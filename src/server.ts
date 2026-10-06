import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { SuzzieEngine } from './agent/orchestrator.js';
import { FixtureRepository } from './discovery/repository.js';
import { loadCatalogCsv } from './discovery/csvLoader.js';
import { attachCoordinates } from './discovery/repository.js';
import type { Entity } from './types.js';
import { loadZipIndex, ZipIndex } from './geo/zip.js';
import { VectorIndex, loadLocalEmbedder, type Embedder } from './discovery/embeddings.js';
import { InMemoryStore } from './memory/store.js';

/**
 * Local dev server. One endpoint, POST /api/ask, so the browser never talks to a
 * model provider directly — the same shape the production service will have.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CATALOGS = [
  { path: join(here, '..', 'data', 'listings.csv'), label: 'MSN catalog' },
  { path: join(here, '..', 'data', 'listings-public.csv'), label: 'public listings' },
  { path: join(here, '..', 'data', 'listings-clinical.csv'), label: 'clinical services' },
];
const ZIPS = join(here, '..', 'data', 'us-zips.csv');
const EMBEDDINGS = join(here, '..', 'data', 'embeddings');

/** Nationwide ZIP/city lookup. Without it, location matching is text-only. */
async function buildZipIndex(): Promise<ZipIndex | undefined> {
  if (!existsSync(ZIPS)) {
    console.warn('[suzzie] no data/us-zips.csv — run `npm run fetch:zips` for nationwide "near me" search');
    return undefined;
  }
  const index = await loadZipIndex(ZIPS);
  console.log(`[suzzie] loaded ${index.size} US ZIPs (data © GeoNames, CC BY 4.0)`);
  return index;
}

/** Loads every catalog file that exists: MSN's own first, then public data. */
async function buildRepository(zips?: ZipIndex): Promise<FixtureRepository> {
  const all: Entity[] = [];
  const seen = new Set<string>();

  for (const { path, label } of CATALOGS) {
    if (!existsSync(path)) continue;
    const report = await loadCatalogCsv(path);
    let added = 0;
    for (const e of report.entities) {
      if (seen.has(e.id)) continue;      // earlier files win, so curated beats public
      seen.add(e.id);
      all.push(e);
      added++;
    }
    console.log(`[suzzie] ${label}: loaded ${added} listings`);
    if (report.stale.length) console.warn(`[suzzie] ${label}: dropped ${report.stale.length} stale listing(s)`);
    for (const e of report.errors) console.error(`[suzzie] ${label} row ${e.row} skipped (${e.name || 'unnamed'}): ${e.problem}`);
  }

  if (!all.length) {
    console.log('[suzzie] no catalog files — using built-in SAMPLE listings');
    return new FixtureRepository();
  }

  if (zips) {
    const geo = attachCoordinates(all, zips);
    console.log(`[suzzie] placed ${geo.located} of ${all.length} listings on the map`);
    if (geo.unlocated.length) console.warn(`[suzzie] could not locate ${geo.unlocated.length} listing(s)`);
  }
  return new FixtureRepository(all);
}

/** Meaning-based retrieval, if the index has been built. */
async function buildMeaningSearch(): Promise<{ embedder?: Embedder; vectors?: VectorIndex }> {
  if (!existsSync(`${EMBEDDINGS}.vectors.bin`)) {
    console.warn('[suzzie] no meaning index — run `npm run build:embeddings` for relevance beyond keywords');
    return {};
  }
  try {
    const vectors = await VectorIndex.load(EMBEDDINGS);
    const embedder = await loadLocalEmbedder();
    console.log(`[suzzie] meaning search ready (${vectors.size.toLocaleString()} vectors)`);
    return { embedder, vectors };
  } catch (err) {
    console.error('[suzzie] meaning index failed to load, keywords only:', (err as Error).message);
    return {};
  }
}

const zips = await buildZipIndex();
const meaning = await buildMeaningSearch();
const engine = new SuzzieEngine({
  repo: await buildRepository(zips),
  zips,
  embedder: meaning.embedder,
  vectors: meaning.vectors,
  memory: new InMemoryStore(),
});
const PORT = Number(process.env.PORT ?? 5173);

const readBody = (req: import('node:http').IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/ask') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const answer = await engine.handle({
        userId: String(body.userId ?? 'demo-user'),
        sessionId: String(body.sessionId ?? 'demo-session'),
        text: String(body.text ?? ''),
        inputMode: body.inputMode === 'voice' ? 'voice' : 'typed',
        country: 'US',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(join(here, '..', 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    // Never leak internals to the browser; the trace stays in the server log.
    console.error('[suzzie]', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'engine_error' }));
  }
});

server.listen(PORT, () => console.log(`Suzzie Q dev server → http://localhost:${PORT}`));
