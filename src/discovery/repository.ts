import type { Constraints, Entity, Recommendation } from '../types.js';
import { milesBetween, DEFAULT_RADIUS_MILES, WIDENED_RADIUS_MILES, type Place, type ZipIndex } from '../geo/zip.js';
import { CLINICAL_CATEGORY } from './samhsa.js';

/**
 * Discovery. One canonical source of listings for every surface (PRD FR-7).
 * Nothing reaches a user that isn't in here and active — that is the whole
 * anti-fabrication mechanism (FR-6, AC-1).
 *
 * Location works nationwide: a listing with coordinates is matched by real
 * distance, and a listing with only a city name falls back to text matching.
 */

export interface SearchOptions {
  belonging?: boolean;
  limit?: number;
  place?: Place | null;
  radiusMiles?: number;
  /** id → meaning score, from the vector index. Absent when embeddings are off. */
  semantic?: Map<string, number>;
  /**
   * Treatment facilities stay hidden unless the member asked for professional
   * help. Someone who feels lonely should meet people, not be sent to a clinic.
   */
  allowClinical?: boolean;
}

export interface SearchResult {
  entities: Entity[];
  /** True when we widened the radius or fell back to online because nothing was close. */
  widened: boolean;
  onlineOnly: boolean;
  radiusUsed: number;
}

export interface EntityRepository {
  search(c: Constraints, opts?: SearchOptions): Promise<Entity[]>;
  searchWithCoverage?(c: Constraints, opts?: SearchOptions): Promise<SearchResult>;
  byIds(ids: string[]): Promise<Entity[]>;
}

/** Sample listings used until data/listings.csv exists. Jersey City area. */
export const FIXTURES: Entity[] = [
  { id: 'ent_001', type: 'community', name: 'Sunrise Walking Group', active: true, categories: ['community', 'movement', 'outdoors'], city: 'Jersey City', state: 'NJ', zip: '07302', lat: 40.7178, lon: -74.0431, format: 'in_person', priceUsd: 0, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/communities/ent_001', summary: 'Free morning walks, all paces welcome.' },
  { id: 'ent_002', type: 'event', name: 'Gentle Evening Yoga', active: true, categories: ['yoga', 'movement', 'stress'], city: 'Jersey City', state: 'NJ', zip: '07306', lat: 40.7350, lon: -74.0654, format: 'in_person', priceUsd: 15, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/events/ent_002' },
  { id: 'ent_003', type: 'community', name: 'Newcomers Supper Club', active: true, categories: ['community', 'belonging', 'social'], city: 'Hoboken', state: 'NJ', zip: '07030', lat: 40.7439, lon: -74.0324, format: 'in_person', priceUsd: 0, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/communities/ent_003' },
  { id: 'ent_004', type: 'practitioner', name: 'Dana Ruiz, Breathwork Facilitator', active: true, categories: ['breathwork', 'stress'], city: 'New York', state: 'NY', zip: '10001', lat: 40.7506, lon: -73.9971, format: 'hybrid', priceUsd: 60, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/practitioners/ent_004' },
  { id: 'ent_005', type: 'event', name: 'Online Meditation Drop-In', active: true, categories: ['meditation', 'stress'], format: 'online', priceUsd: 0, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/events/ent_005' },
  { id: 'ent_006', type: 'community', name: 'Peer Support Circle (online)', active: true, categories: ['community', 'belonging', 'peer_support'], format: 'online', priceUsd: 0, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/communities/ent_006' },
  { id: 'ent_007', type: 'nonprofit', name: 'Riverside Community Center', active: true, categories: ['community', 'classes', 'belonging'], city: 'Jersey City', state: 'NJ', zip: '07304', lat: 40.7100, lon: -74.0776, format: 'in_person', priceUsd: 0, verified: true, source: 'msn_curated', languages: [], bookingUrl: '/orgs/ent_007' },
  { id: 'ent_008', type: 'event', name: 'Sleep & Rest Workshop', active: true, categories: ['rest', 'stress'], format: 'online', priceUsd: 25, verified: false, source: 'msn_curated', languages: [], bookingUrl: '/events/ent_008' },
  // Blocked fixtures — must never surface.
  { id: 'ent_900', type: 'event', name: 'Cancelled Sound Bath', active: false, categories: ['meditation'], city: 'Jersey City', state: 'NJ', format: 'in_person', verified: true, source: 'msn_curated', languages: [] },
  { id: 'ent_901', type: 'practitioner', name: 'Suspended Account', active: false, categories: ['breathwork'], format: 'online', verified: false, source: 'msn_curated', languages: [] },
];

const BELONGING_TYPES = new Set(['community', 'event', 'nonprofit']);

interface Scored { e: Entity; score: number; reasons: string[]; distance?: number }

export class FixtureRepository implements EntityRepository {
  constructor(private readonly rows: Entity[] = FIXTURES) {}

  async byIds(ids: string[]): Promise<Entity[]> {
    const set = new Set(ids);
    return this.rows.filter(e => set.has(e.id) && e.active);
  }

  async search(c: Constraints, opts: SearchOptions = {}): Promise<Entity[]> {
    return (await this.searchWithCoverage(c, opts)).entities;
  }

  /**
   * Widens the net rather than returning nothing: default radius, then a wider
   * one, then online-only. The caller tells the user which happened.
   */
  async searchWithCoverage(c: Constraints, opts: SearchOptions = {}): Promise<SearchResult> {
    const limit = opts.limit ?? 5;
    const place = opts.place ?? null;
    const firstRadius = opts.radiusMiles ?? c.radiusMiles ?? DEFAULT_RADIUS_MILES;

    if (!place) {
      return { entities: this.rank(c, opts, null, Infinity).slice(0, limit), widened: false, onlineOnly: false, radiusUsed: Infinity };
    }

    // "Something local" is what the user actually asked for, so online results
    // alone don't count as coverage.
    const local = (rows: Entity[]) => rows.filter(e => (e as any).__distance !== undefined);

    const near = this.rank(c, opts, place, firstRadius);
    if (local(near).length) return { entities: near.slice(0, limit), widened: false, onlineOnly: false, radiusUsed: firstRadius };

    const wider = this.rank(c, opts, place, WIDENED_RADIUS_MILES);
    if (local(wider).length) return { entities: wider.slice(0, limit), widened: true, onlineOnly: false, radiusUsed: WIDENED_RADIUS_MILES };

    // Nothing within reach — offer what works anywhere rather than an empty screen.
    const online = this.rank({ ...c, format: 'online' }, opts, null, Infinity).filter(e => e.format === 'online');
    return { entities: online.slice(0, limit), widened: true, onlineOnly: true, radiusUsed: WIDENED_RADIUS_MILES };
  }

  private rank(c: Constraints, opts: SearchOptions, place: Place | null, radius: number): Entity[] {
    const wanted = new Set(c.categories.map(x => x.toLowerCase()));

    const scored: Scored[] = [];

    for (const e of this.rows) {
      if (!e.active) continue;
      if (!opts.allowClinical && e.categories.includes(CLINICAL_CATEGORY)) continue;
      if (c.format !== 'either' && e.format !== c.format && e.format !== 'hybrid') continue;
      if (c.maxPriceUsd !== undefined && (e.priceUsd ?? 0) > c.maxPriceUsd) continue;

      let distance: number | undefined;
      if (place && e.format !== 'online') {
        if (e.lat !== undefined && e.lon !== undefined) {
          distance = milesBetween(place, { lat: e.lat, lon: e.lon });
          if (distance > radius) continue;
        } else if (c.location) {
          // No coordinates: fall back to matching the text of the city/state.
          const hay = `${e.city ?? ''} ${e.state ?? ''}`.toLowerCase();
          if (!hay.includes(c.location.toLowerCase().split(',')[0].trim())) continue;
        } else continue;
      }

      let score = 0;
      const reasons: string[] = [];

      const overlap = e.categories.filter(cat => wanted.has(cat.toLowerCase()));
      if (overlap.length) { score += overlap.length * 10; reasons.push(`match.category:${overlap.join('|')}`); }

      // Meaning. When embeddings are on, a listing must either match a category
      // the user asked for or be genuinely close in meaning — this is what keeps
      // an international aid charity out of "I feel lonely".
      if (opts.semantic) {
        const meaning = opts.semantic.get(e.id);
        // Not close enough in meaning to be what was asked for — a shared
        // category tag is not a reason to show it.
        if (meaning === undefined) continue;
        score += meaning * 40;
        reasons.push(`match.meaning:${meaning.toFixed(2)}`);
      }
      if (opts.belonging && BELONGING_TYPES.has(e.type)) { score += 9; reasons.push('rank.belonging_boost'); }
      if (e.verified) { score += 3; reasons.push('trust.verified'); }
      else if (e.source === 'public_open_data') { score -= 1; reasons.push('trust.public_unverified'); }
      if ((e.priceUsd ?? 0) === 0) { score += 1; reasons.push('access.free'); }
      if (distance !== undefined) {
        score += Math.max(0, 6 - distance / 5);        // closer is better, gently
        reasons.push(`geo.miles:${distance.toFixed(1)}`);
      }

      if (score <= 0) continue;
      scored.push({ e, score, reasons, distance });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map(x => Object.assign({}, x.e, { __reasons: x.reasons, __distance: x.distance }) as Entity);
  }
}

/** Attaches coordinates to listings that only gave a ZIP. Runs once at load. */
export function attachCoordinates(entities: Entity[], zips: ZipIndex): { located: number; unlocated: string[] } {
  let located = 0;
  const unlocated: string[] = [];
  for (const e of entities) {
    if (e.format === 'online') continue;
    if (e.lat !== undefined && e.lon !== undefined) { located++; continue; }
    const place = zips.resolve(e.zip) ?? zips.resolve([e.city, e.state].filter(Boolean).join(', '));
    if (place) { e.lat = place.lat; e.lon = place.lon; located++; }
    else unlocated.push(e.id);
  }
  return { located, unlocated };
}

export function toRecommendation(e: Entity): Recommendation {
  const reasons = ((e as any).__reasons as string[] | undefined) ?? [];
  const distance = (e as any).__distance as number | undefined;
  const bits: string[] = [];
  if (reasons.some(r => r.startsWith('match.meaning') || r.startsWith('match.category'))) bits.push('matches what you asked for');
  if (reasons.includes('rank.belonging_boost')) bits.push('a group rather than a solo session');
  if (distance !== undefined) bits.push(`about ${distance < 1 ? 'a mile' : `${Math.round(distance)} miles`} away`);
  if (reasons.includes('access.free')) bits.push('free to attend');
  if (reasons.includes('trust.verified')) bits.push('verified on MSN');
  if (reasons.includes('trust.public_unverified')) bits.push('public listing, not checked by MSN');
  return {
    entityId: e.id,
    entityType: e.type,
    name: e.name,
    reasonCodes: reasons,
    displayReason: bits.length ? bits.join(', ') : 'available near you',
    verified: e.verified,
    source: e.source,
    format: e.format,
    priceUsd: e.priceUsd,
    bookingUrl: e.bookingUrl,
    distanceMiles: distance === undefined ? undefined : Math.round(distance * 10) / 10,
  };
}
