import { readFile, writeFile } from 'node:fs/promises';

/**
 * Meaning-based retrieval.
 *
 * Keyword matching can't tell "I feel alone" from "Food for the Hungry
 * International" — both carry the tag `community`. Embeddings turn a listing
 * and a request into vectors, so closeness in meaning becomes a number we can
 * rank and threshold.
 *
 * The model runs locally (Transformers.js, all-MiniLM-L6-v2, ~23MB, downloaded
 * once). No API key, no per-query cost, nothing leaves the machine — which
 * also means embedding a member's words never reaches a third party.
 */

export interface Embedder {
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Cosine similarity of two unit-length vectors, i.e. their dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const len = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / len;
  return out;
}

/**
 * The sentence we embed for each listing. Name alone is misleading —
 * "Jcama Inc" says nothing — so the categories and summary carry the meaning.
 */
export function listingText(e: {
  name: string; categories: string[]; summary?: string; type: string; city?: string;
}): string {
  return [
    e.name,
    e.type,
    e.categories.join(', '),
    e.summary ?? '',
    e.city ?? '',
  ].filter(Boolean).join('. ');
}

/** Loads the local model. Kept behind a dynamic import so tests never need it. */
export async function loadLocalEmbedder(modelName = 'Xenova/all-MiniLM-L6-v2'): Promise<Embedder> {
  const { pipeline } = await import('@xenova/transformers' as string);
  const extractor = await pipeline('feature-extraction', modelName);
  return {
    dims: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const result = await extractor(text, { pooling: 'mean', normalize: true });
        out.push(new Float32Array(result.data as Float32Array));
      }
      return out;
    },
  };
}

/**
 * A flat vector index. Exhaustive search over ~50k vectors takes a few
 * milliseconds, which is well inside budget — no approximate index needed
 * until the catalog is far larger.
 */
export class VectorIndex {
  private ids: string[] = [];
  private data: Float32Array;
  private count = 0;

  constructor(public readonly dims: number, capacity = 1024) {
    this.data = new Float32Array(dims * capacity);
  }

  get size(): number { return this.count; }

  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.dims) throw new Error(`expected ${this.dims} dimensions, got ${vector.length}`);
    if ((this.count + 1) * this.dims > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, (this.count + 1) * this.dims));
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(vector, this.count * this.dims);
    this.ids.push(id);
    this.count++;
  }

  /** Top-k by similarity, with anything below `minScore` left out entirely. */
  search(query: Float32Array, k = 50, minScore = 0): Array<{ id: string; score: number }> {
    const hits: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < this.count; i++) {
      let dot = 0;
      const base = i * this.dims;
      for (let d = 0; d < this.dims; d++) dot += this.data[base + d] * query[d];
      if (dot >= minScore) hits.push({ id: this.ids[i], score: dot });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Two files: the ids as JSON, the vectors as raw float32. */
  async save(basePath: string): Promise<void> {
    await writeFile(`${basePath}.ids.json`, JSON.stringify({ dims: this.dims, ids: this.ids }), 'utf8');
    await writeFile(`${basePath}.vectors.bin`, Buffer.from(this.data.buffer, 0, this.count * this.dims * 4));
  }

  static async load(basePath: string): Promise<VectorIndex> {
    const meta = JSON.parse(await readFile(`${basePath}.ids.json`, 'utf8')) as { dims: number; ids: string[] };
    const buf = await readFile(`${basePath}.vectors.bin`);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

    const index = new VectorIndex(meta.dims, meta.ids.length || 1);
    for (let i = 0; i < meta.ids.length; i++) {
      index.add(meta.ids[i], floats.subarray(i * meta.dims, (i + 1) * meta.dims));
    }
    return index;
  }
}

/**
 * Below this, a listing isn't really about what was asked. Tuned so that
 * "I feel lonely" keeps community and peer-support groups and drops
 * international aid charities that merely carry a `community` tag.
 */
export const RELEVANCE_FLOOR = 0.25;
