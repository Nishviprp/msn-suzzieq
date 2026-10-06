/**
 * Builds data/listings-public.csv from the IRS list of registered US nonprofits.
 *
 *   npm run import:nonprofits -- --states NJ,NY
 *   npm run import:nonprofits -- --states TX --limit 2000
 *   npm run import:nonprofits             (every state — big; a few minutes)
 *
 * Source: IRS Exempt Organizations Business Master File, published as four
 * regional CSVs at https://www.irs.gov/pub/irs-soi/. US government work, public
 * domain, no key, no terms to breach.
 *
 * What these listings are and are not: real organisations at real addresses,
 * with no opening hours, prices or programmes. They come in as
 * `public_open_data`, never verified, always labelled as unchecked, and ranked
 * below anything MSN has confirmed. They fill the map while the curated
 * catalog grows.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/discovery/csvLoader.js';
import { irsRowToListing, type IrsRow, type PublicListing } from '../src/discovery/ntee.js';

const FILES = [
  { name: 'eo1.csv', url: 'https://www.irs.gov/pub/irs-soi/eo1.csv' },   // Northeast
  { name: 'eo2.csv', url: 'https://www.irs.gov/pub/irs-soi/eo2.csv' },   // Mid-Atlantic & Great Lakes
  { name: 'eo3.csv', url: 'https://www.irs.gov/pub/irs-soi/eo3.csv' },   // Gulf & Pacific Coast, elsewhere
  { name: 'eo4.csv', url: 'https://www.irs.gov/pub/irs-soi/eo4.csv' },   // Outside the US
];

/**
 * These files are 50-165MB and the IRS server drops connections. Retry with a
 * generous timeout rather than losing a 10-minute download to one hiccup.
 */
async function download(url: string, attempts = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      const why = (err as Error).message;
      if (attempt === attempts) { console.log(`failed after ${attempts} tries (${why})`); return null; }
      const wait = attempt * 5;
      process.stdout.write(`retrying in ${wait}s (${why}) … `);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'data', 'listings-public.csv');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const HEADER = [
  'id', 'type', 'name', 'active', 'categories', 'format', 'city', 'state', 'zip',
  'address', 'priceUsd', 'schedule', 'bookingUrl', 'phone', 'contactEmail',
  'languages', 'accessibility', 'summary', 'verified', 'source', 'lastCheckedAt',
];

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const toRow = (l: PublicListing) => [
  l.id, l.type, l.name, l.active, l.categories, l.format, l.city, l.state, l.zip,
  l.address, '', '', '', '', '', '', '', l.summary, l.verified, l.source, l.lastCheckedAt,
].map(cell).join(',');

async function main() {
  const states = arg('states')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const limit = Number(arg('limit') ?? Infinity);
  const today = new Date().toISOString().slice(0, 10);

  console.log(states ? `filtering to: ${states.join(', ')}` : 'importing every state (this takes a while)');

  const listings: PublicListing[] = [];
  const seen = new Set<string>();
  let scanned = 0, skippedCategory = 0;

  let failed = 0;

  for (const file of FILES) {
    if (listings.length >= limit) break;
    process.stdout.write(`downloading ${file.name} … `);

    const text = await download(file.url);
    if (text === null) { failed++; continue; }
    console.log(`${(text.length / 1e6).toFixed(0)} MB`);

    const rows = parseCsv(text);
    const header = rows[0].map(h => h.trim().toUpperCase());
    const idx = new Map(header.map((h, i) => [h, i]));
    const get = (r: string[], k: string) => (idx.has(k) ? r[idx.get(k)!] : undefined);

    for (const r of rows.slice(1)) {
      scanned++;
      const state = (get(r, 'STATE') ?? '').trim().toUpperCase();
      if (states && !states.includes(state)) continue;

      const row: IrsRow = {
        EIN: get(r, 'EIN'), NAME: get(r, 'NAME'), STREET: get(r, 'STREET'),
        CITY: get(r, 'CITY'), STATE: state, ZIP: get(r, 'ZIP'),
        NTEE_CD: get(r, 'NTEE_CD'), STATUS: get(r, 'STATUS'), SUBSECTION: get(r, 'SUBSECTION'),
      };

      const listing = irsRowToListing(row, today);
      if (!listing) { skippedCategory++; continue; }
      if (seen.has(listing.id)) continue;
      seen.add(listing.id);
      listings.push(listing);
      if (listings.length >= limit) break;
    }
  }

  if (!listings.length) {
    console.error(failed
      ? `\nevery download failed — data/listings-public.csv was NOT changed, so the app is still using the old file.\nCheck your connection and run it again.`
      : '\nnothing matched — check the --states codes (two letters, e.g. NJ)');
    process.exit(1);
  }

  if (failed) {
    console.warn(`\n${failed} of ${FILES.length} regional files could not be downloaded — this import covers only part of the country.`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, [HEADER.join(','), ...listings.map(toRow)].join('\n') + '\n', 'utf8');

  const byState = new Map<string, number>();
  for (const l of listings) byState.set(l.state, (byState.get(l.state) ?? 0) + 1);
  const top = [...byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([s, n]) => `${s}:${n}`).join('  ');

  console.log(`\nscanned ${scanned.toLocaleString()} organisations`);
  console.log(`kept ${listings.length.toLocaleString()} (${skippedCategory.toLocaleString()} were the wrong kind of organisation)`);
  console.log(`by state: ${top}`);
  console.log(`wrote data/listings-public.csv (replacing whatever was there before)`);
  console.log('run `npm run build:embeddings` next — the meaning index is built from this file.');
  console.log('\nThese are unverified public listings. They rank below MSN listings and say so on the card.');
}

main().catch(err => { console.error('import failed —', err.message); process.exit(1); });
