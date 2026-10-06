import { inflateRawSync } from 'node:zlib';

/**
 * Just enough ZIP reading for the data downloads, with no dependency.
 *
 * Entries are found through the archive's central directory (the index at the
 * end of the file) rather than by walking local headers — a streamed archive
 * leaves the sizes out of the local headers, which is why walking them fails.
 */

export interface ZipEntry { name: string; method: number; compressedSize: number; localOffset: number }

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/** Lists what's inside the archive. Useful when an expected file isn't there. */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 64KB, after a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('zip64 archives are not supported by this reader');

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Reads one file out of the archive by name. */
export function readZipEntry(buf: Buffer, wanted: string): Buffer {
  const entries = listZipEntries(buf);
  const entry = entries.find(e => e.name === wanted);
  if (!entry) {
    throw new Error(`"${wanted}" not in the archive. It contains: ${entries.map(e => e.name).join(', ') || '(nothing)'}`);
  }

  // The local header tells us where the compressed bytes actually start.
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported compression method ${entry.method} for ${wanted}`);
}
