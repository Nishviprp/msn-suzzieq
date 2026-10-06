import { readFile } from 'node:fs/promises';
import { parseCsv } from '../discovery/csvLoader.js';

/**
 * US geography. "Near me" has to work in all 50 states, not just the cities
 * someone remembered to hard-code.
 *
 * Data: the US Census Gazetteer ZCTA file — public domain, one row per ZIP with
 * coordinates. `npm run fetch:zips` downloads it into data/us-zips.csv.
 * Nothing here calls a paid geocoding service.
 */

export interface ZipRecord { zip: string; lat: number; lon: number; city?: string; state?: string }

export interface Place { lat: number; lon: number; label: string }

const EARTH_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
export function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR',
]);

export class ZipIndex {
  private byZip = new Map<string, ZipRecord>();
  private byCity = new Map<string, ZipRecord>();       // "jersey city, nj" and "jersey city"

  constructor(records: ZipRecord[] = []) {
    for (const r of records) this.add(r);
  }

  get size(): number { return this.byZip.size; }

  add(r: ZipRecord): void {
    this.byZip.set(r.zip, r);
    if (!r.city) return;
    const city = r.city.trim().toLowerCase();
    const state = (r.state ?? '').trim().toUpperCase();
    if (state) {
      const keyed = `${city}, ${state.toLowerCase()}`;
      if (!this.byCity.has(keyed)) this.byCity.set(keyed, r);
    }
    if (!this.byCity.has(city)) this.byCity.set(city, r);   // first match wins
  }

  /**
   * Turns whatever the user typed into a point on the map.
   * Handles "07302", "Jersey City", "Jersey City, NJ", "Austin TX".
   */
  resolve(input?: string): Place | null {
    if (!input) return null;
    const text = input.trim();
    if (!text) return null;

    const zip = text.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
    if (zip) {
      const hit = this.byZip.get(zip);
      if (hit) return { lat: hit.lat, lon: hit.lon, label: hit.city ? `${hit.city}, ${hit.state}` : zip };
      return null;
    }

    const cleaned = text.replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();

    // "austin tx" → "austin, tx"
    const parts = cleaned.split(/,\s*|\s+/);
    const tail = parts[parts.length - 1]?.toUpperCase();
    const key = US_STATES.has(tail ?? '')
      ? `${parts.slice(0, -1).join(' ')}, ${tail!.toLowerCase()}`
      : cleaned;

    const hit = this.byCity.get(key) ?? this.byCity.get(cleaned);
    if (!hit) return null;
    return { lat: hit.lat, lon: hit.lon, label: hit.city ? `${hit.city}, ${hit.state}` : cleaned };
  }
}

/** Loads data/us-zips.csv: zip,lat,lon,city,state */
export async function loadZipIndex(path: string): Promise<ZipIndex> {
  const rows = parseCsv(await readFile(path, 'utf8'));
  const [header, ...body] = rows;
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const need = ['zip', 'lat', 'lon'];
  const missing = need.filter(h => !col.has(h));
  if (missing.length) throw new Error(`us-zips.csv is missing columns: ${missing.join(', ')}`);

  const index = new ZipIndex();
  for (const r of body) {
    const zip = (r[col.get('zip')!] ?? '').trim().padStart(5, '0');
    const lat = Number(r[col.get('lat')!]);
    const lon = Number(r[col.get('lon')!]);
    if (!/^\d{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    index.add({
      zip, lat, lon,
      city: col.has('city') ? (r[col.get('city')!] ?? '').trim() || undefined : undefined,
      state: col.has('state') ? (r[col.get('state')!] ?? '').trim().toUpperCase() || undefined : undefined,
    });
  }
  return index;
}

/** Default radius when the user says "near me" without a distance. */
export const DEFAULT_RADIUS_MILES = 25;
/** How far we widen before giving up and offering online options instead. */
export const WIDENED_RADIUS_MILES = 60;
