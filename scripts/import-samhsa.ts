/**
 * Builds data/listings-clinical.csv from SAMHSA's national directories.
 *
 *   npm run import:samhsa
 *   npm run import:samhsa -- --states NJ,NY
 *
 * Source: SAMHSA National Directory of Mental Health Treatment Facilities and
 * the matching substance use directory, published as Excel files from the
 * N-SUMHSS survey. US government work, public domain.
 *
 * These are clinical services. They are written to their own file and carry the
 * `clinical_service` category, so the engine only shows them when a member asks
 * for professional help or hits the clinical boundary.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsxSheet, findHeaderRow, columnFinder } from './xlsx.js';
import { facilityToListing, type FacilityListing, type FacilityRow } from '../src/discovery/samhsa.js';

const SOURCES = [
  {
    kind: 'mental_health' as const,
    label: 'mental health facilities',
    url: 'https://www.samhsa.gov/data/sites/default/files/reports/rpt57010/2025_MH_Facilities_for_All_City_All.xlsx',
  },
  {
    kind: 'substance_use' as const,
    label: 'substance use facilities',
    url: 'https://www.samhsa.gov/data/sites/default/files/reports/rpt57009/2025_SU_Facilities_for_All_City_All.xlsx',
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'data', 'listings-clinical.csv');

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

const toRow = (l: FacilityListing) => [
  l.id, l.type, l.name, l.active, l.categories, l.format, l.city, l.state, l.zip,
  l.address, '', '', l.bookingUrl, l.phone, '', '', '', l.summary, l.verified, l.source, l.lastCheckedAt,
].map(cell).join(',');

async function download(url: string, attempts = 3): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      const why = (err as Error).message;
      if (attempt === attempts) { console.log(`failed after ${attempts} tries (${why})`); return null; }
      process.stdout.write(`retrying (${why}) … `);
      await new Promise(r => setTimeout(r, attempt * 5000));
    }
  }
  return null;
}

async function main() {
  const states = arg('states')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  const listings: FacilityListing[] = [];
  const seen = new Set<string>();
  let failed = 0;

  for (const source of SOURCES) {
    process.stdout.write(`downloading ${source.label} … `);
    const buf = await download(source.url);
    if (!buf) { failed++; continue; }
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);

    const rows = readXlsxSheet(buf);
    const headerAt = findHeaderRow(rows, ['name', 'city', 'state']);
    if (headerAt < 0) {
      console.error(`  could not find the header row. First row looks like: ${rows[0]?.slice(0, 6).join(' | ')}`);
      failed++;
      continue;
    }

    const header = rows[headerAt];
    const col = columnFinder(header);
    const at = {
      name: col('facility name', 'name1', 'name'),
      street: col('street address 1', 'street1', 'street', 'address'),
      city: col('city'),
      state: col('state'),
      zip: col('zip code', 'zip'),
      phone: col('phone', 'telephone'),
      services: col('type of care', 'services', 'service setting'),
      website: col('website', 'url'),
    };
    console.log(`  columns: ${Object.entries(at).filter(([, i]) => i > -1).map(([k, i]) => `${k}→${header[i]}`).join(', ')}`);

    let kept = 0;
    for (const r of rows.slice(headerAt + 1)) {
      const pick = (i: number) => (i > -1 ? (r[i] ?? '') : '');
      const state = pick(at.state).trim().toUpperCase();
      if (states && !states.includes(state)) continue;

      const row: FacilityRow = {
        name: pick(at.name), street: pick(at.street), city: pick(at.city), state,
        zip: pick(at.zip), phone: pick(at.phone), services: pick(at.services), website: pick(at.website),
      };

      const listing = facilityToListing(row, source.kind, today);
      if (!listing || seen.has(listing.id)) continue;
      seen.add(listing.id);
      listings.push(listing);
      kept++;
    }
    console.log(`  kept ${kept.toLocaleString()} facilities`);
  }

  if (!listings.length) {
    console.error('\nnothing imported — data/listings-clinical.csv was not changed.');
    process.exit(1);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, [HEADER.join(','), ...listings.map(toRow)].join('\n') + '\n', 'utf8');

  console.log(`\nwrote ${listings.length.toLocaleString()} clinical listings → data/listings-clinical.csv`);
  if (failed) console.warn(`${failed} source(s) failed — this import is partial.`);
  console.log('These stay hidden unless a member asks for professional help.');
  console.log('run `npm run build:embeddings` next.');
}

main().catch(err => { console.error('import failed —', err.message); process.exit(1); });
