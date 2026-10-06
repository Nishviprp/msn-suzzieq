/**
 * Turning IRS nonprofit records into listings Suzzie Q can use.
 *
 * The IRS publishes every registered US nonprofit with an NTEE code — a
 * classification like "P20 Human Service Organizations". We keep only the
 * categories that plausibly help someone's wellbeing or belonging, and map
 * them onto our own category words.
 *
 * These become `public_open_data` listings: never verified, ranked below
 * MSN's own, and always labelled as unchecked.
 */

export interface NteeMapping { categories: string[]; note: string }

/** Two-character prefixes are specific; single letters are the fallback. */
const MAP: Array<[RegExp, NteeMapping]> = [
  // Recreation, sport, outdoors
  [/^N2/, { categories: ['movement', 'outdoors', 'community'], note: 'recreation' }],
  [/^N6/, { categories: ['movement', 'community'], note: 'sports' }],
  [/^N/,  { categories: ['movement', 'community'], note: 'recreation' }],

  // Human services, community support
  [/^P2/, { categories: ['community', 'belonging'], note: 'human services' }],
  [/^P8/, { categories: ['community', 'belonging'], note: 'centers serving specific groups' }],
  [/^P/,  { categories: ['community'], note: 'human services' }],

  // Community improvement, neighbourhood groups
  [/^S2/, { categories: ['community', 'belonging'], note: 'community improvement' }],
  [/^S8/, { categories: ['community', 'belonging'], note: 'neighbourhood groups' }],
  [/^S/,  { categories: ['community'], note: 'community improvement' }],

  // Mental health and peer support organisations
  [/^F3/, { categories: ['peer_support', 'community'], note: 'mental health support' }],
  [/^F8/, { categories: ['peer_support', 'community'], note: 'peer support' }],
  [/^F/,  { categories: ['peer_support', 'community'], note: 'mental health services' }],

  // Arts and culture — creative outlets that get people out of the house
  [/^A2/, { categories: ['creative', 'community'], note: 'arts' }],
  [/^A6/, { categories: ['creative', 'community'], note: 'performing arts' }],
  [/^A/,  { categories: ['creative', 'community'], note: 'arts and culture' }],

  // Youth and senior centres
  [/^O2/, { categories: ['community', 'belonging'], note: 'youth centers' }],
  [/^O/,  { categories: ['community', 'belonging'], note: 'youth development' }],

  // Food programs — real wellbeing, and often the first need
  [/^K3/, { categories: ['nutrition', 'community'], note: 'food programs' }],

  // Nature and environment groups (walks, conservation, gardens)
  [/^C3/, { categories: ['outdoors', 'nature', 'community'], note: 'nature and conservation' }],
];

/**
 * Deliberately excluded: hospitals and clinics (E), disease-specific medical
 * research (G, H), religion (X — belief-specific, a founder decision, not ours),
 * housing corporations (L — these are co-op ownership entities, not services),
 * and anything financial or professional. Keeping the catalog to things a
 * member can simply turn up to.
 */
const EXCLUDED = /^[BDEGHIJLMQRTUVWXYZ]/;

export function mapNtee(code: string | undefined): NteeMapping | null {
  const c = (code ?? '').trim().toUpperCase();
  if (!c || EXCLUDED.test(c)) return null;
  for (const [re, mapping] of MAP) if (re.test(c)) return mapping;
  return null;
}

/** Title Case for the SHOUTED NAMES the IRS file uses. */
export function tidyName(raw: string): string {
  const small = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'on', 'a', 'an', 'to']);
  const keepUpper = new Set(['USA', 'US', 'YMCA', 'YWCA', 'NAACP', 'LGBT', 'LGBTQ', 'AA', 'NA', 'VFW', 'PTA', 'PTO', 'NJ', 'NY', 'CA', 'TX', 'DC', 'II', 'III', 'IV']);
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word, i) => {
      const bare = word.replace(/[^A-Za-z]/g, '');
      if (keepUpper.has(bare.toUpperCase()) && bare.length <= 5) return word.toUpperCase();
      const lower = word.toLowerCase();
      if (i > 0 && small.has(lower)) return lower;
      return lower.replace(/(^|[^a-z])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
    })
    .join(' ');
}

/**
 * The IRS file is full of entities nobody can turn up to: co-op boards named
 * after their street address, numbered shells, trusts. A wellness listing has
 * to at least look like a place with a door.
 */
const BAD_NAME = [
  /housing development fund/i,
  /\bh d f c\b|\bhdfc\b/i,
  /\b(tenants?|owners?|condominium|co-?op|cooperative) (association|corp)/i,
  /\btrust\b|\bestate of\b|\bfbo\b/i,
  /\bfoundation\b.*\binc\b.*\bfund\b/i,
  /^\d/,                                   // "2164 Inc", "619 Village"
  /^[a-z]{1,3}\s*\d/i,                     // "PS 84", "IS 230"
  /\b\d{2,}\s+(east|west|north|south|e|w|n|s)?\s*\d*\s*(street|st|avenue|ave|road|rd|blvd)\b/i,
];

export function looksLikeAPlace(name: string): boolean {
  if (BAD_NAME.some(re => re.test(name))) return false;
  const words = name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  return words.length >= 2;                 // needs at least two real words
}

/** IRS ZIPs come as "07302" or "07302-1234". */
export function tidyZip(raw: string): string | null {
  const m = (raw ?? '').trim().match(/^(\d{5})/);
  return m ? m[1] : null;
}

export interface IrsRow {
  EIN?: string; NAME?: string; STREET?: string; CITY?: string; STATE?: string;
  ZIP?: string; NTEE_CD?: string; STATUS?: string; SUBSECTION?: string;
}

export interface PublicListing {
  id: string; type: 'nonprofit'; name: string; active: 'yes'; categories: string;
  format: 'in_person'; city: string; state: string; zip: string; address: string;
  summary: string; verified: 'no'; source: 'public_open_data'; lastCheckedAt: string;
}

/** One IRS row → one listing, or null if we shouldn't list it. */
export function irsRowToListing(row: IrsRow, today: string): PublicListing | null {
  // 01 = unconditional exemption. Anything else may be revoked or pending.
  if ((row.STATUS ?? '').trim() !== '01') return null;
  const mapping = mapNtee(row.NTEE_CD);
  if (!mapping) return null;

  const zip = tidyZip(row.ZIP ?? '');
  const state = (row.STATE ?? '').trim().toUpperCase();
  const city = tidyName(row.CITY ?? '');
  const name = tidyName(row.NAME ?? '');
  const ein = (row.EIN ?? '').trim();

  if (!zip || !state || !name || !ein) return null;
  if (name.length < 4) return null;
  if (!looksLikeAPlace(name)) return null;

  return {
    id: `irs_${ein}`,
    type: 'nonprofit',
    name,
    active: 'yes',
    categories: mapping.categories.join(';'),
    format: 'in_person',
    city,
    state,
    zip,
    address: [tidyName(row.STREET ?? ''), city, state, zip].filter(Boolean).join(', '),
    summary: `${mapping.note} organisation, listed from public records. Call or visit to find out what they run — we haven't checked.`,
    verified: 'no',
    source: 'public_open_data',
    lastCheckedAt: today,
  };
}
