import { readFile } from 'node:fs/promises';
import { Entity } from '../types.js';

/**
 * Loads the catalog from a CSV the catalog owner maintains (export any
 * spreadsheet as CSV). Every row is validated; a bad row is reported and
 * skipped rather than silently half-loaded.
 */

export interface LoadReport {
  entities: Entity[];
  errors: Array<{ row: number; name: string; problem: string }>;
  stale: string[];      // public listings past their freshness window
}

/** Public listings are dropped after this many days without a re-check. */
export const PUBLIC_FRESHNESS_DAYS = 90;

/** Minimal RFC-4180 parser: handles quoted fields, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

const bool = (v: string, dflt = false) =>
  v.trim() === '' ? dflt : /^(y|yes|true|1)$/i.test(v.trim());

const list = (v: string) =>
  v.split(/[;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);

const num = (v: string) => {
  const t = v.replace(/[$,\s]/g, '');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

export function rowsToEntities(rows: string[][], now = new Date()): LoadReport {
  const [header, ...body] = rows;
  if (!header) return { entities: [], errors: [{ row: 0, name: '', problem: 'file is empty' }], stale: [] };

  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const need = ['id', 'type', 'name', 'active', 'categories', 'format', 'source'];
  const missing = need.filter(h => !col.has(h));
  if (missing.length) {
    return { entities: [], errors: [{ row: 0, name: '', problem: `missing columns: ${missing.join(', ')}` }], stale: [] };
  }

  const at = (r: string[], key: string) => (col.has(key) ? (r[col.get(key)!] ?? '') : '');

  const entities: Entity[] = [];
  const errors: LoadReport['errors'] = [];
  const stale: string[] = [];
  const seen = new Set<string>();

  body.forEach((r, i) => {
    const rowNo = i + 2;                      // 1-based, plus header
    const name = at(r, 'name').trim();
    const id = at(r, 'id').trim();

    if (seen.has(id)) { errors.push({ row: rowNo, name, problem: `duplicate id "${id}"` }); return; }

    const source = at(r, 'source').trim().toLowerCase();
    const lastChecked = at(r, 'lastcheckedat').trim();

    // Freshness: anything we didn't curate ourselves must have been checked recently.
    if (source === 'public_open_data') {
      const checked = lastChecked ? Date.parse(lastChecked) : NaN;
      const ageDays = Number.isNaN(checked) ? Infinity : (now.getTime() - checked) / 86_400_000;
      if (ageDays > PUBLIC_FRESHNESS_DAYS) { stale.push(id || name); return; }
    }

    const parsed = Entity.safeParse({
      id,
      type: at(r, 'type').trim().toLowerCase(),
      name,
      active: bool(at(r, 'active'), true),
      categories: list(at(r, 'categories')),
      city: at(r, 'city').trim() || undefined,
      state: at(r, 'state').trim().toUpperCase() || undefined,
      zip: at(r, 'zip').trim() || undefined,
      lat: num(at(r, 'lat')),
      lon: num(at(r, 'lon')),
      format: at(r, 'format').trim().toLowerCase().replace(/[\s-]/g, '_'),
      priceUsd: num(at(r, 'priceusd')),
      verified: bool(at(r, 'verified')),
      bookingUrl: at(r, 'bookingurl').trim() || undefined,
      summary: at(r, 'summary').trim() || undefined,
      source: source || 'msn_curated',
      lastCheckedAt: lastChecked || undefined,
      contactEmail: at(r, 'contactemail').trim() || undefined,
      phone: at(r, 'phone').trim() || undefined,
      address: at(r, 'address').trim() || undefined,
      schedule: at(r, 'schedule').trim() || undefined,
      accessibility: at(r, 'accessibility').trim() || undefined,
      languages: list(at(r, 'languages')),
    });

    if (!parsed.success) {
      const problem = parsed.error.issues.map(is => `${is.path.join('.') || 'row'}: ${is.message}`).join('; ');
      errors.push({ row: rowNo, name, problem });
      return;
    }

    // Only MSN can vouch for a listing. A public row can't mark itself verified.
    const e = parsed.data;
    if (e.source === 'public_open_data') e.verified = false;

    seen.add(e.id);
    entities.push(e);
  });

  return { entities, errors, stale };
}

export async function loadCatalogCsv(path: string, now = new Date()): Promise<LoadReport> {
  const text = await readFile(path, 'utf8');
  return rowsToEntities(parseCsv(text), now);
}
