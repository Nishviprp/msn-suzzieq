import { describe, it, expect } from 'vitest';
import { ZipIndex, milesBetween, DEFAULT_RADIUS_MILES } from '../src/geo/zip.js';
import { FixtureRepository, attachCoordinates, FIXTURES } from '../src/discovery/repository.js';
import { SuzzieEngine } from '../src/agent/orchestrator.js';
import { Constraints, type Entity } from '../src/types.js';

/** A stand-in for the 41,000-row file, so tests don't depend on a download. */
const zips = new ZipIndex([
  { zip: '07302', lat: 40.7178, lon: -74.0431, city: 'Jersey City', state: 'NJ' },
  { zip: '07030', lat: 40.7439, lon: -74.0324, city: 'Hoboken', state: 'NJ' },
  { zip: '10001', lat: 40.7506, lon: -73.9971, city: 'New York', state: 'NY' },
  { zip: '78701', lat: 30.2711, lon: -97.7437, city: 'Austin', state: 'TX' },
  { zip: '59718', lat: 45.6656, lon: -111.1078, city: 'Bozeman', state: 'MT' },
]);

const c = (o: Partial<ReturnType<typeof Constraints.parse>> = {}) => Constraints.parse(o);

describe('finding a place anywhere in the US', () => {
  it('resolves a ZIP', () => {
    expect(zips.resolve('07302')?.label).toBe('Jersey City, NJ');
  });

  it('resolves a city name, with or without the state', () => {
    expect(zips.resolve('Austin, TX')?.label).toBe('Austin, TX');
    expect(zips.resolve('austin tx')?.label).toBe('Austin, TX');
    expect(zips.resolve('Bozeman')?.label).toBe('Bozeman, MT');
  });

  it("returns nothing for a place it does not know", () => {
    expect(zips.resolve('Atlantis')).toBeNull();
    expect(zips.resolve('99999')).toBeNull();
    expect(zips.resolve(undefined)).toBeNull();
  });

  it('measures distance sensibly', () => {
    const jc = { lat: 40.7178, lon: -74.0431 };
    const austin = { lat: 30.2711, lon: -97.7437 };
    expect(milesBetween(jc, jc)).toBeCloseTo(0, 5);
    expect(milesBetween(jc, { lat: 40.7439, lon: -74.0324 })).toBeLessThan(3);   // Hoboken
    expect(Math.round(milesBetween(jc, austin))).toBeGreaterThan(1400);
  });
});

describe('searching near a place', () => {
  const repo = new FixtureRepository();

  it('returns nearby listings first', async () => {
    const r = await repo.searchWithCoverage(c({ categories: ['community', 'belonging'] }), {
      place: zips.resolve('07302'), belonging: true,
    });
    expect(r.entities.length).toBeGreaterThan(0);
    expect(r.onlineOnly).toBe(false);
    const distances = r.entities.map(e => (e as any).__distance).filter(Boolean);
    expect(Math.min(...distances)).toBeLessThan(DEFAULT_RADIUS_MILES);
  });

  it('falls back to online when nothing is within reach', async () => {
    const r = await repo.searchWithCoverage(c({ categories: ['yoga', 'movement'] }), {
      place: zips.resolve('59718'),    // Bozeman, MT — 1,900 miles from every fixture
    });
    expect(r.onlineOnly).toBe(true);
    expect(r.entities.every(e => e.format === 'online')).toBe(true);
  });

  it('never returns an in-person listing on the other side of the country', async () => {
    const r = await repo.searchWithCoverage(c({ categories: ['yoga'] }), { place: zips.resolve('78701') });
    expect(r.entities.some(e => e.city === 'Jersey City')).toBe(false);
  });
});

describe('geocoding the catalog at load time', () => {
  it('fills in coordinates from a ZIP', () => {
    const rows: Entity[] = [{
      id: 'x1', type: 'event', name: 'Test', active: true, categories: ['yoga'],
      city: 'Austin', state: 'TX', zip: '78701', format: 'in_person',
      verified: true, source: 'msn_curated', languages: [],
    }];
    const report = attachCoordinates(rows, zips);
    expect(report.located).toBe(1);
    expect(rows[0].lat).toBeCloseTo(30.2711, 3);
  });

  it('falls back to the city name when there is no ZIP', () => {
    const rows: Entity[] = [{
      id: 'x2', type: 'event', name: 'Test', active: true, categories: ['yoga'],
      city: 'Bozeman', state: 'MT', format: 'in_person',
      verified: true, source: 'msn_curated', languages: [],
    }];
    attachCoordinates(rows, zips);
    expect(rows[0].lat).toBeCloseTo(45.6656, 3);
  });

  it('reports listings it could not place', () => {
    const rows: Entity[] = [{
      id: 'x3', type: 'event', name: 'Test', active: true, categories: ['yoga'],
      city: 'Atlantis', state: 'ZZ', format: 'in_person',
      verified: true, source: 'msn_curated', languages: [],
    }];
    expect(attachCoordinates(rows, zips).unlocated).toEqual(['x3']);
  });
});

describe('the agent, used from anywhere in the country', () => {
  const engine = () => new SuzzieEngine({ repo: new FixtureRepository([...FIXTURES]), zips });
  const ask = (e: SuzzieEngine, text: string, session: string) =>
    e.handle({ userId: 'u1', sessionId: session, text, country: 'US' });

  it('searches around the place the user named', async () => {
    const r = await ask(engine(), 'yoga near 07302 this week', 'g1');
    expect(r.searchedNear).toBe('Jersey City, NJ');
    expect(r.recommendations[0].distanceMiles).toBeLessThan(DEFAULT_RADIUS_MILES);
  });

  it('tells a user in Montana that it found nothing local, and offers online', async () => {
    const r = await ask(engine(), 'yoga in Bozeman, just go with this', 'g2');
    expect(r.message).toMatch(/couldn't find anything within reach/i);
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations.every(x => x.format === 'online')).toBe(true);
  });
});
