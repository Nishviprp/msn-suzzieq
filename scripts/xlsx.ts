import { readZipEntry, listZipEntries } from './zipfile.js';

/**
 * Minimal .xlsx reading, no dependency.
 *
 * An .xlsx is a zip of XML. We only need the first worksheet as rows of text,
 * which is a shared-string table plus the cells of that sheet — small enough to
 * do by hand and safer than pulling in a spreadsheet library for one import.
 */

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
   .replace(/&amp;/g, '&');

/** The <si> entries of sharedStrings.xml, in order. */
function sharedStrings(buf: Buffer): string[] {
  const entry = listZipEntries(buf).find(e => e.name === 'xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = readZipEntry(buf, 'xl/sharedStrings.xml').toString('utf8');
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => {
    // A string can be split across several <t> runs.
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1]));
    return parts.join('');
  });
}

/** "BC12" → column index 54 (zero-based). */
export function columnIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** First worksheet as rows of plain strings. */
export function readXlsxSheet(buf: Buffer): string[][] {
  const strings = sharedStrings(buf);
  const names = listZipEntries(buf).map(e => e.name);
  const sheetName = names.find(n => /^xl\/worksheets\/sheet1\.xml$/.test(n))
    ?? names.find(n => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) throw new Error(`no worksheet inside the file (contains: ${names.slice(0, 8).join(', ')})`);

  const xml = readZipEntry(buf, sheetName).toString('utf8');
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1];

      let value = '';
      if (type === 's') {
        const idx = Number(body.match(/<v>(\d+)<\/v>/)?.[1] ?? -1);
        value = strings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1])).join('');
      } else {
        value = decode(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      }

      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }

  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/**
 * Government spreadsheets often start with title and note rows. The header is
 * the first row that contains the columns we actually need.
 */
export function findHeaderRow(rows: string[][], required: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const lower = rows[i].map(c => c.trim().toLowerCase());
    if (required.every(want => lower.some(cell => cell.includes(want)))) return i;
  }
  return -1;
}

/** Fuzzy header lookup: "Facility Name" matches a want of "name". */
export function columnFinder(header: string[]) {
  const lower = header.map(h => h.trim().toLowerCase());
  return (...wants: string[]): number => {
    for (const want of wants) {
      const exact = lower.indexOf(want);
      if (exact > -1) return exact;
    }
    for (const want of wants) {
      const partial = lower.findIndex(h => h.includes(want));
      if (partial > -1) return partial;
    }
    return -1;
  };
}
