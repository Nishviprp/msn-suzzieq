import { describe, it, expect } from 'vitest';
import { facilityToListing, facilityCategories, CLINICAL_CATEGORY } from '../src/discovery/samhsa.js';
import { FixtureRepository, FIXTURES } from '../src/discovery/repository.js';
import { SuzzieEngine } from '../src/agent/orchestrator.js';
import { Constraints, type Entity } from '../src/types.js';

const TODAY = '2026-09-23';
const facility = (o = {}) => ({
  name: 'HUDSON WELLNESS COUNSELING CENTER', street: '12 RIVER RD', city: 'JERSEY CITY',
  state: 'NJ', zip: '07302', phone: '(201) 555-0101', services: 'Outpatient mental health, peer support', ...o,
});

describe('reading a SAMHSA facility', () => {
  it('builds a listing with a usable phone number', () => {
    const l = facilityToListing(facility(), 'mental_health', TODAY)!;
    expect(l.name).toBe('Hudson Wellness Counseling Center');
    expect(l.phone).toBe('201-555-0101');
    expect(l.zip).toBe('07302');
  });

  it('always marks it as a clinical service', () => {
    const l = facilityToListing(facility(), 'mental_health', TODAY)!;
    expect(l.categories).toContain(CLINICAL_CATEGORY);
    expect(l.verified).toBe('no');
  });

  it('reads the services into our own words', () => {
    const cats = facilityCategories('Outpatient, telehealth, sliding fee scale, peer support', 'mental_health');
    expect(cats).toContain('outpatient');
    expect(cats).toContain('telehealth');
    expect(cats).toContain('low_cost');
    expect(cats).toContain('peer_support');
  });

  it('keeps the same id when re-imported', () => {
    const a = facilityToListing(facility(), 'mental_health', TODAY)!;
    const b = facilityToListing(facility(), 'mental_health', '2027-01-01')!;
    expect(a.id).toBe(b.id);
  });

  it('skips rows without a name, state or ZIP', () => {
    expect(facilityToListing(facility({ name: '' }), 'mental_health', TODAY)).toBeNull();
    expect(facilityToListing(facility({ zip: 'n/a' }), 'mental_health', TODAY)).toBeNull();
  });
});

const clinic: Entity = {
  id: 'samhsa_mh_test', type: 'practitioner', name: 'Hudson Counseling Center', active: true,
  categories: ['clinical_service', 'mental_health_services', 'peer_support'],
  city: 'Jersey City', state: 'NJ', zip: '07302', lat: 40.7178, lon: -74.0431,
  format: 'in_person', verified: false, source: 'public_open_data', languages: [],
};

describe('when a treatment facility may be shown', () => {
  const repo = new FixtureRepository([...FIXTURES, clinic]);
  const engine = new SuzzieEngine({ repo });
  const ask = (text: string, session: string) =>
    engine.handle({ userId: 'u1', sessionId: session, text, country: 'US' });

  it('hides it from someone who just feels lonely', async () => {
    const r = await ask('i feel lonely and want to meet people, just go with this', 'c1');
    expect(r.recommendations.map(x => x.entityId)).not.toContain('samhsa_mh_test');
  });

  it('shows it when the member asks for a counsellor', async () => {
    const r = await repo.search(Constraints.parse({ categories: ['peer_support'] }), { allowClinical: true });
    expect(r.map(e => e.id)).toContain('samhsa_mh_test');
  });

  it('shows it at the clinical boundary', async () => {
    const r = await ask('i have had a headache for days', 'c2');
    expect(r.mode).toBe('CLINICAL_BOUNDARY');
    expect(r.quickActions.some(a => a.id === 'find_consultant')).toBe(true);
  });
});
