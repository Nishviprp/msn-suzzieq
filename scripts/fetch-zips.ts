/**
 * Downloads the US ZIP code dataset and writes data/us-zips.csv.
 *
 *   npm run fetch:zips
 *
 * Source: GeoNames postal codes (https://download.geonames.org/export/zip/US.zip),
 * licensed CC BY 4.0 — attribution is required wherever the data is used, so the
 * app credits GeoNames in its about/credits text. ~41,000 US ZIPs with
 * coordinates, city and state. No API key, no paid geocoder.
 *
 * Re-run it a couple of times a year; ZIP boundaries change slowly.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntry, listZipEntries } from './zipfile.js';

const SOURCE = 'https://download.geonames.org/export/zip/US.zip';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'data', 'us-zips.csv');

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function main() {
  console.log(`downloading ${SOURCE} …`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const zip = Buffer.from(await res.arrayBuffer());
  console.log(`got ${(zip.length / 1e6).toFixed(1)} MB`);
  if (zip.length < 100_000) throw new Error('download looks too small to be the dataset — check the URL or your connection');

  // US.txt is tab-separated: country, postal, place, state name, state code, …, lat, lon, accuracy
  console.log(`archive contains: ${listZipEntries(zip).map(e => e.name).join(', ')}`);
  const text = readZipEntry(zip, 'US.txt').toString('utf8');

  const seen = new Set<string>();
  const out: string[] = ['zip,lat,lon,city,state'];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const zipCode = (f[1] ?? '').trim();
    const city = (f[2] ?? '').trim();
    const state = (f[4] ?? '').trim().toUpperCase();
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    if (!/^\d{5}$/.test(zipCode) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (seen.has(zipCode)) continue;
    seen.add(zipCode);
    out.push([zipCode, lat.toFixed(5), lon.toFixed(5), csvCell(city), state].join(','));
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, out.join('\n') + '\n', 'utf8');
  console.log(`wrote ${out.length - 1} ZIPs → data/us-zips.csv`);
  console.log('Credit required by the licence: "ZIP data © GeoNames, CC BY 4.0".');
}

main().catch(err => { console.error('fetch:zips failed —', err.message); process.exit(1); });
