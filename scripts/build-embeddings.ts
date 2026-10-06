/**
 * Builds the meaning index the agent searches with.
 *
 *   npm run build:embeddings
 *
 * Reads every catalog file, turns each listing into a vector with a local model
 * (Transformers.js, all-MiniLM-L6-v2 — about 23MB, downloaded once), and writes
 * data/embeddings.ids.json + data/embeddings.vectors.bin.
 *
 * Runs on the CPU, no API key, no per-query cost, and nothing leaves the
 * machine. Expect roughly 10–25 minutes for 50,000 listings; re-run it whenever
 * the catalog changes.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogCsv } from '../src/discovery/csvLoader.js';
import { loadLocalEmbedder, listingText, VectorIndex } from '../src/discovery/embeddings.js';
import type { Entity } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOGS = [
  join(here, '..', 'data', 'listings.csv'),
  join(here, '..', 'data', 'listings-public.csv'),
  join(here, '..', 'data', 'listings-clinical.csv'),
];
const OUT = join(here, '..', 'data', 'embeddings');

async function main() {
  const all: Entity[] = [];
  const seen = new Set<string>();

  for (const path of CATALOGS) {
    if (!existsSync(path)) continue;
    const report = await loadCatalogCsv(path);
    for (const e of report.entities) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
  }

  if (!all.length) {
    console.error('no listings found — run the importer or add data/listings.csv first');
    process.exit(1);
  }

  console.log(`embedding ${all.length.toLocaleString()} listings …`);
  console.log('loading the model (first run downloads ~23MB) …');
  const embedder = await loadLocalEmbedder();

  const index = new VectorIndex(embedder.dims, all.length);
  const started = Date.now();
  const BATCH = 32;

  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map(listingText));
    batch.forEach((e, j) => index.add(e.id, vectors[j]));

    const done = Math.min(i + BATCH, all.length);
    if (done % 512 === 0 || done === all.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / elapsed;
      const left = Math.round((all.length - done) / rate);
      process.stdout.write(`\r  ${done.toLocaleString()} / ${all.length.toLocaleString()}  (${rate.toFixed(0)}/s, ~${Math.floor(left / 60)}m ${left % 60}s left)   `);
    }
  }

  await index.save(OUT);
  console.log(`\nwrote data/embeddings.* — ${index.size.toLocaleString()} vectors, ${embedder.dims} dimensions`);
  console.log('restart the dev server to use it.');
}

main().catch(err => {
  console.error('\nbuild:embeddings failed —', err.message);
  if (/Cannot find module|@xenova/.test(err.message)) {
    console.error('install the model runtime first:  npm i @xenova/transformers');
  }
  process.exit(1);
});
