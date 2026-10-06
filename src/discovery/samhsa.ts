import { tidyName, tidyZip, looksLikeAPlace } from './ntee.js';

/**
 * SAMHSA's national directories of mental health and substance use treatment
 * facilities — real services with addresses and phone numbers, updated from an
 * annual federal survey.
 *
 * These are *clinical* services, not wellness activities. They carry the
 * `clinical_service` category, which the engine hides from ordinary discovery:
 * someone saying "I feel lonely" gets community groups, not a treatment centre.
 * They surface when a member asks for professional help, or from the clinical
 * boundary hand-off.
 */

export interface FacilityRow {
  name?: string; street?: string; city?: string; state?: string;
  zip?: string; phone?: string; services?: string; website?: string;
}

export interface FacilityListing {
  id: string; type: 'practitioner'; name: string; active: 'yes'; categories: string;
  format: 'in_person'; city: string; state: string; zip: string; address: string;
  phone: string; bookingUrl: string; summary: string;
  verified: 'no'; source: 'public_open_data'; lastCheckedAt: string;
}

/** What a facility's listed services mean in our own words. */
export function facilityCategories(services: string, kind: 'mental_health' | 'substance_use'): string[] {
  const s = (services ?? '').toLowerCase();
  const out = new Set<string>(['clinical_service']);

  out.add(kind === 'substance_use' ? 'substance_use_support' : 'mental_health_services');
  if (/peer|mutual.?help|recovery support/.test(s)) out.add('peer_support');
  if (/group/.test(s)) out.add('group_therapy');
  if (/telehealth|telemedicine|virtual/.test(s)) out.add('telehealth');
  if (/outpatient/.test(s)) out.add('outpatient');
  if (/sliding|no.?fee|free|payment assistance/.test(s)) out.add('low_cost');

  return [...out];
}

const digits = (s: string) => (s ?? '').replace(/\D/g, '');

/** One directory row → one listing, or null if it isn't usable. */
export function facilityToListing(
  row: FacilityRow,
  kind: 'mental_health' | 'substance_use',
  today: string,
): FacilityListing | null {
  const name = tidyName(row.name ?? '');
  const zip = tidyZip(row.zip ?? '');
  const state = (row.state ?? '').trim().toUpperCase();
  const city = tidyName(row.city ?? '');
  const phoneDigits = digits(row.phone ?? '');

  if (!name || !zip || !state) return null;
  if (name.length < 4 || !looksLikeAPlace(name)) return null;

  const phone = phoneDigits.length === 10
    ? `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`
    : (row.phone ?? '').trim();

  // Stable id from what identifies the place, so re-imports don't duplicate it.
  const key = `${name}|${zip}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
  const id = `samhsa_${kind === 'substance_use' ? 'su' : 'mh'}_${hash(key)}`;

  const kindWords = kind === 'substance_use'
    ? 'substance use treatment'
    : 'mental health treatment';

  return {
    id,
    type: 'practitioner',
    name,
    active: 'yes',
    categories: facilityCategories(row.services ?? '', kind).join(';'),
    format: 'in_person',
    city,
    state,
    zip,
    address: [tidyName(row.street ?? ''), city, state, zip].filter(Boolean).join(', '),
    phone,
    bookingUrl: (row.website ?? '').trim().startsWith('http') ? (row.website ?? '').trim() : '',
    summary: `${kindWords} facility listed in SAMHSA's national directory. Call ahead — availability, cost and waiting times change.`,
    verified: 'no',
    source: 'public_open_data',
    lastCheckedAt: today,
  };
}

/** Small stable hash, so the same facility keeps the same id between imports. */
export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** The marker the engine checks before showing a clinical service. */
export const CLINICAL_CATEGORY = 'clinical_service';
