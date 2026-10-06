import { describe, it, expect } from 'vitest';
import { VectorIndex, cosine, normalise, listingText, RELEVANCE_FLOOR, type Embedder } from '../src/discovery/embeddings.js';
import { FixtureRepository } from '../src/discovery/repository.js';
import { SuzzieEngine } from '../src/agent/orchestrator.js';
import { Constraints, type Entity } from '../src/types.js';

/**
 * A stand-in for the real model: each listing gets a hand-made vector, so the
 * ranking logic is tested without downloading anything. Three meaning axes:
 * [belonging, movement, aid-work].
 */
const VECTORS: Record<string, number[]> = {
  lonely_query:        [1.0, 0.1, 0.0],
  support_group:       [0.95, 0.1, 0.05],
  community_center:    [0.85, 0.2, 0.1],
  walking_group:       [0.5, 0.85, 0.0],
  overseas_aid:        [0.05, 0.0, 1.0],
};

const fakeEmbedder = (map: Record<string, number[]>): Embedder => ({
  dims: 3,
  async embed(texts) {
    return texts.map(t => {
      const key = Object.keys(map).find(k => t.toLowerCase().includes(k.replace(/_/g, ' '))) ?? 'lonely_query';
      return normalise(Float32Array.from(map[key]));
    });
  },
});

const entity = (id: string, name: string, cats: string[]): Entity => ({
  id, type: 'nonprofit', name, active: true, categories: cats,
  city: 'Jersey City', state: 'NJ', zip: '07302', lat: 40.7178, lon: -74.0431,
  format: 'in_person', priceUsd: 0, verified: false, source: 'public_open_data', languages: [],
});

const CATALOG = [
  entity('n1', 'Peer Support Group', ['community']),
  entity('n2', 'Riverside Community Center', ['community']),
  entity('n3', 'Morning Walking Group', ['community', 'movement']),
  entity('n4', 'Food for the Hungry International Inc', ['community']),
];

const index = new VectorIndex(3);
index.add('n1', normalise(Float32Array.from(VECTORS.support_group)));
index.add('n2', normalise(Float32Array.from(VECTORS.community_center)));
index.add('n3', normalise(Float32Array.from(VECTORS.walking_group)));
index.add('n4', normalise(Float32Array.from(VECTORS.overseas_aid)));

describe('vector maths', () => {
  it('scores identical meanings at 1 and unrelated ones near 0', () => {
    const a = normalise(Float32Array.from([1, 0, 0]));
    const b = normalise(Float32Array.from([0, 1, 0]));
    expect(cosine(a, a)).toBeCloseTo(1, 5);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it('describes a listing with more than its name', () => {
    const text = listingText({ name: 'Jcama Inc', type: 'nonprofit', categories: ['community', 'belonging'], summary: 'Registered nonprofit.', city: 'Jersey City' });
    expect(text).toContain('community');
    expect(text).toContain('Jersey City');
  });

  it('returns the closest listings in order', () => {
    const q = normalise(Float32Array.from(VECTORS.lonely_query));
    const hits = index.search(q, 3);
    expect(hits[0].id).toBe('n1');
    expect(hits.map(h => h.id)).not.toContain('n4');
  });

  it('leaves out anything below the relevance floor', () => {
    const q = normalise(Float32Array.from(VECTORS.lonely_query));
    const hits = index.search(q, 10, RELEVANCE_FLOOR);
    expect(hits.some(h => h.id === 'n4')).toBe(false);
  });

  it('survives a save and reload', async () => {
    const path = `/tmp/suzzie-vec-test-${Date.now()}`;
    await index.save(path);
    const reloaded = await VectorIndex.load(path);
    expect(reloaded.size).toBe(4);
    const q = normalise(Float32Array.from(VECTORS.lonely_query));
    expect(reloaded.search(q, 1)[0].id).toBe('n1');
  });
});

describe('ranking with meaning', () => {
  const repo = new FixtureRepository(CATALOG);
  const semanticFor = (queryKey: keyof typeof VECTORS) => {
    const q = normalise(Float32Array.from(VECTORS[queryKey]));
    return new Map(index.search(q, 200, RELEVANCE_FLOOR).map(h => [h.id, h.score]));
  };

  it('keeps the aid charity out of a loneliness search', async () => {
    const r = await repo.searchWithCoverage(
      Constraints.parse({ categories: ['community'] }),
      { semantic: semanticFor('lonely_query'), limit: 5 },
    );
    expect(r.entities.map(e => e.id)).not.toContain('n4');
    expect(r.entities[0].id).toBe('n1');
  });

  it('still works when embeddings are off — just less precisely', async () => {
    const r = await repo.searchWithCoverage(Constraints.parse({ categories: ['community'] }), { limit: 5 });
    expect(r.entities.length).toBe(4);      // everything tagged community, junk included
  });
});

describe('the agent with meaning search', () => {
  const engine = new SuzzieEngine({
    repo: new FixtureRepository(CATALOG),
    embedder: fakeEmbedder(VECTORS),
    vectors: index,
  });

  it('puts the support group first and drops the aid charity', async () => {
    const r = await engine.handle({ userId: 'u1', sessionId: 'm1', text: 'lonely query, just go with this', country: 'US' });
    expect(r.recommendations[0].entityId).toBe('n1');
    expect(r.recommendations.map(x => x.entityId)).not.toContain('n4');
    expect(r.reasonCodes.some(c => c.startsWith('retrieval.semantic'))).toBe(true);
  });

  it('falls back to keywords if the embedder throws', async () => {
    const broken = new SuzzieEngine({
      repo: new FixtureRepository(CATALOG),
      embedder: { dims: 3, embed: async () => { throw new Error('model missing'); } },
      vectors: index,
    });
    const r = await broken.handle({ userId: 'u1', sessionId: 'm2', text: 'community near me, just go with this', country: 'US' });
    expect(r.mode).toBe('NORMAL_DISCOVERY');
    expect(r.recommendations.length).toBeGreaterThan(0);
  });
});
