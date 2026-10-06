import { describe, it, expect } from 'vitest';
import { mapNtee, tidyName, tidyZip, irsRowToListing, looksLikeAPlace, type IrsRow } from '../src/discovery/ntee.js';

const TODAY = '2026-09-22';
const row = (o: Partial<IrsRow> = {}): IrsRow => ({
  EIN: '221234567', NAME: 'RIVERSIDE COMMUNITY CENTER INC', STREET: '9 RIVER RD',
  CITY: 'JERSEY CITY', STATE: 'NJ', ZIP: '07304-1234', NTEE_CD: 'P20', STATUS: '01', ...o,
});

describe('choosing which organisations to list', () => {
  it('keeps community, recreation, arts and peer support', () => {
    expect(mapNtee('P20')?.categories).toContain('community');
    expect(mapNtee('N20')?.categories).toContain('outdoors');
    expect(mapNtee('A65')?.categories).toContain('creative');
    expect(mapNtee('F32')?.categories).toContain('peer_support');
    expect(mapNtee('S22')?.categories).toContain('belonging');
  });

  it('leaves out hospitals, research and religious organisations', () => {
    for (const code of ['E20', 'G81', 'H90', 'X21', 'T30', 'W05']) {
      expect(mapNtee(code), code).toBeNull();
    }
  });

  it('handles a missing or junk code', () => {
    expect(mapNtee(undefined)).toBeNull();
    expect(mapNtee('')).toBeNull();
    expect(mapNtee('   ')).toBeNull();
  });
});

describe('cleaning up IRS data', () => {
  it('turns shouted names into readable ones', () => {
    expect(tidyName('RIVERSIDE COMMUNITY CENTER INC')).toBe('Riverside Community Center Inc');
    expect(tidyName('FRIENDS OF THE PARK')).toBe('Friends of the Park');
    expect(tidyName('YMCA OF GREATER NEW YORK')).toBe('YMCA of Greater New York');
  });

  it('shortens ZIP+4 to five digits', () => {
    expect(tidyZip('07304-1234')).toBe('07304');
    expect(tidyZip('07304')).toBe('07304');
    expect(tidyZip('bad')).toBeNull();
  });
});

describe('building a listing from an IRS row', () => {
  it('produces a usable listing', () => {
    const l = irsRowToListing(row(), TODAY)!;
    expect(l.id).toBe('irs_221234567');
    expect(l.name).toBe('Riverside Community Center Inc');
    expect(l.city).toBe('Jersey City');
    expect(l.zip).toBe('07304');
    expect(l.categories).toContain('community');
    expect(l.lastCheckedAt).toBe(TODAY);
  });

  it('never marks a public listing as verified', () => {
    const l = irsRowToListing(row(), TODAY)!;
    expect(l.verified).toBe('no');
    expect(l.source).toBe('public_open_data');
  });

  it('never links a member to financial filings', () => {
    const l = irsRowToListing(row(), TODAY) as any;
    expect(l.bookingUrl).toBeUndefined();
  });

  it('drops entities nobody can turn up to', () => {
    for (const name of [
      '545 E 166 STREET HOUSING DEVELOPMENT FUND CORPORATION',
      '2164 INC',
      '619 VILLAGE',
      'SMITH FAMILY TRUST',
      'PS 84 PARENTS ASSOCIATION',
    ]) {
      expect(irsRowToListing(row({ NAME: name }), TODAY), name).toBeNull();
    }
  });

  it('keeps places with real names', () => {
    for (const name of ['RIVERSIDE COMMUNITY CENTER', 'HUDSON SENIOR CENTER INC', 'GREENVILLE WALKING CLUB']) {
      expect(looksLikeAPlace(tidyName(name)), name).toBe(true);
    }
  });

  it('leaves out housing corporations entirely', () => {
    expect(mapNtee('L21')).toBeNull();
    expect(mapNtee('L82')).toBeNull();
  });

  it('says plainly that the details are unchecked', () => {
    expect(irsRowToListing(row(), TODAY)!.summary).toMatch(/public records|haven't checked/i);
  });

  it('skips organisations that are not in good standing', () => {
    expect(irsRowToListing(row({ STATUS: '12' }), TODAY)).toBeNull();
    expect(irsRowToListing(row({ STATUS: '' }), TODAY)).toBeNull();
  });

  it('skips rows missing the basics', () => {
    expect(irsRowToListing(row({ ZIP: '' }), TODAY)).toBeNull();
    expect(irsRowToListing(row({ EIN: '' }), TODAY)).toBeNull();
    expect(irsRowToListing(row({ NAME: 'AB' }), TODAY)).toBeNull();
  });

  it('skips the wrong kind of organisation', () => {
    expect(irsRowToListing(row({ NTEE_CD: 'E20' }), TODAY)).toBeNull();
  });
});
