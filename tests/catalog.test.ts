import { describe, it, expect } from 'vitest';
import { parseCsv, rowsToEntities, PUBLIC_FRESHNESS_DAYS } from '../src/discovery/csvLoader.js';

const HEADER = 'id,type,name,active,categories,format,city,state,priceUsd,verified,source,lastCheckedAt';
const row = (o: Partial<Record<string, string>> = {}) => [
  o.id ?? 'msn_1', o.type ?? 'community', o.name ?? 'Test Group', o.active ?? 'yes',
  o.categories ?? 'community;belonging', o.format ?? 'in_person', o.city ?? 'Jersey City',
  o.state ?? 'NJ', o.priceUsd ?? '0', o.verified ?? 'yes', o.source ?? 'msn_curated',
  o.lastCheckedAt ?? '2026-09-21',
].join(',');

const load = (lines: string[], now = new Date('2026-09-21')) =>
  rowsToEntities(parseCsv([HEADER, ...lines].join('\n')), now);

describe('csv parsing', () => {
  it('handles quoted fields with commas', () => {
    const rows = parseCsv('a,b\n"one, two",three');
    expect(rows[1]).toEqual(['one, two', 'three']);
  });

  it('handles escaped quotes', () => {
    const rows = parseCsv('a\n"she said ""hi"""');
    expect(rows[1][0]).toBe('she said "hi"');
  });
});

describe('loading a catalog', () => {
  it('loads a good row', () => {
    const r = load([row()]);
    expect(r.errors).toHaveLength(0);
    expect(r.entities[0].name).toBe('Test Group');
    expect(r.entities[0].categories).toEqual(['community', 'belonging']);
  });

  it('reports a bad row with its line number instead of failing the file', () => {
    const r = load([row(), row({ id: 'msn_2', type: 'wizard' })]);
    expect(r.entities).toHaveLength(1);
    expect(r.errors[0].row).toBe(3);
    expect(r.errors[0].problem).toMatch(/type/);
  });

  it('rejects duplicate ids', () => {
    const r = load([row(), row({ name: 'Copy' })]);
    expect(r.entities).toHaveLength(1);
    expect(r.errors[0].problem).toMatch(/duplicate/);
  });

  it('refuses to let a public listing call itself verified', () => {
    const r = load([row({ source: 'public_open_data', verified: 'yes' })]);
    expect(r.entities[0].verified).toBe(false);
    expect(r.entities[0].source).toBe('public_open_data');
  });

  it('drops public listings that are past the freshness window', () => {
    const stale = row({ source: 'public_open_data', verified: 'no', lastCheckedAt: '2026-01-01' });
    const r = load([stale], new Date('2026-09-21'));
    expect(r.entities).toHaveLength(0);
    expect(r.stale).toContain('msn_1');
    expect(PUBLIC_FRESHNESS_DAYS).toBe(90);
  });

  it('keeps curated listings even when the check date is old', () => {
    const r = load([row({ lastCheckedAt: '2025-01-01' })], new Date('2026-09-21'));
    expect(r.entities).toHaveLength(1);
  });

  it('complains clearly when a required column is missing', () => {
    const r = rowsToEntities(parseCsv('id,name\nmsn_1,Test'));
    expect(r.errors[0].problem).toMatch(/missing columns/);
  });
});
