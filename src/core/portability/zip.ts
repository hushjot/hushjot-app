/**
 * A minimal zip writer and reader, for export and import (spec §24).
 *
 * Hand-written rather than a dependency, for the reason §28 gives and the
 * search index and service worker already follow: the part of the format a
 * notepad needs is a few hundred lines, and a general archive library brings
 * ZIP64, encryption, streaming and a compressor that nothing here uses.
 *
 * ## Writing: STORE only
 *
 * An export is Markdown, which is small; 10,000 notes of typical length is a
 * few megabytes stored. Deflate would halve that at the cost of either a
 * bundled compressor or an async `CompressionStream` pass per file, and the
 * export would stop being instant. Every unzip tool reads STORE.
 *
 * ## Reading: STORE and DEFLATE, from the central directory
 *
 * Archives made by Finder, Explorer or `zip` are deflated and often use data
 * descriptors, which leave the sizes in the local header as zero. The central
 * directory always has them, so that is what is walked. Inflating uses the
 * platform's `DecompressionStream('deflate-raw')` — no bundled inflater.
 *
 * ## Limits
 *
 * Nothing here writes to a file system, so path traversal cannot hurt — the
 * paths only become folder names. What can hurt is a small archive that
 * inflates to gigabytes inside a tab, so entry count and total inflated size
 * are capped, the size is checked against the declared size, and the CRC is
 * verified. ZIP64 and encrypted entries are refused with a message rather than
 * misread.
 */

export interface ZipEntry {
  /**
   * `/`-separated, no leading slash. A trailing `/` with empty data is a
   * directory entry — only needed for an empty folder; others are implied.
   */
  path: string;
  data: Uint8Array;
  /** Milliseconds since the epoch. Zip stores local time at 2 s resolution. */
  modified: number;
}

export const MAX_ENTRIES = 20_000;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export class ZipError extends Error {
  override name = 'ZipError';
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toDos(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = d.getFullYear();
  // DOS dates start in 1980; anything earlier is clamped rather than wrapped.
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(time: number, date: number): number {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f || 1;
  return new Date(year, month, day, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
}

const encoder = new TextEncoder();

/** Build a STORE archive. Paths must already be unique. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const prepared = entries.map((e) => ({
    name: encoder.encode(e.path),
    data: e.data,
    crc: crc32(e.data),
    dos: toDos(e.modified),
  }));

  let localSize = 0;
  let centralSize = 0;
  for (const p of prepared) {
    localSize += 30 + p.name.length + p.data.length;
    centralSize += 46 + p.name.length;
  }
  if (localSize + centralSize > 0xffffffff || prepared.length > 0xffff) {
    throw new ZipError('Too much to fit in one zip file.');
  }

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];

  for (const p of prepared) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, 0x0800, true); // UTF-8 names
    view.setUint16(at + 8, 0, true); // STORE
    view.setUint16(at + 10, p.dos.time, true);
    view.setUint16(at + 12, p.dos.date, true);
    view.setUint32(at + 14, p.crc, true);
    view.setUint32(at + 18, p.data.length, true);
    view.setUint32(at + 22, p.data.length, true);
    view.setUint16(at + 26, p.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(p.name, at + 30);
    out.set(p.data, at + 30 + p.name.length);
    at += 30 + p.name.length + p.data.length;
  }

  const centralStart = at;
  prepared.forEach((p, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 0x031e, true); // made by: Unix, spec 3.0
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, p.dos.time, true);
    view.setUint16(at + 14, p.dos.date, true);
    view.setUint32(at + 16, p.crc, true);
    view.setUint32(at + 20, p.data.length, true);
    view.setUint32(at + 24, p.data.length, true);
    view.setUint16(at + 28, p.name.length, true);
    // extra, comment, disk, internal attrs: zero
    // -rw-r--r-- for files; drwxr-xr-x plus the MS-DOS directory bit for folders.
    const dir = p.name[p.name.length - 1] === 0x2f;
    view.setUint32(at + 38, dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, true);
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  });

  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot read compressed zip files.');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // The declared size is what the budget was charged for; refuse to inflate past it.
    if (at + value.length > expected) {
      await reader.cancel();
      throw new ZipError('A file in the zip is larger than it claims to be.');
    }
    out.set(value, at);
    at += value.length;
  }
  if (at !== expected) throw new ZipError('A file in the zip is damaged.');
  return out;
}

/**
 * Read every entry in an archive. Directory entries come back with a trailing
 * `/` and no data, so an empty folder survives a round trip.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record is last, before an optional comment of
  // up to 65,535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a zip file, or it is damaged.');

  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipError('Zip files larger than 4 GB are not supported.');
  }
  if (count > MAX_ENTRIES) throw new ZipError(`That zip holds more than ${MAX_ENTRIES.toLocaleString()} files.`);

  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  let total = 0;
  let at = centralOffset;

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      throw new ZipError('This zip file is damaged.');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    // Names without the UTF-8 flag are nominally CP437; in practice modern
    // tools write UTF-8 either way, and ASCII is identical in both.
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith('/')) {
      out.push({ path, data: new Uint8Array(0), modified: fromDos(time, date) });
      continue;
    }
    if (flags & 0x1) throw new ZipError('Password-protected zip files are not supported.');
    if (compressed === 0xffffffff || size === 0xffffffff) {
      throw new ZipError('Zip files larger than 4 GB are not supported.');
    }
    if (method !== 0 && method !== 8) throw new ZipError(`“${path}” uses a compression method this app cannot read.`);

    total += size;
    if (total > MAX_TOTAL_BYTES) throw new ZipError('That zip is too large to import (over 200 MB unpacked).');

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ZipError('This zip file is damaged.');
    }
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + compressed > bytes.length) throw new ZipError('This zip file is damaged.');
    const raw = bytes.subarray(start, start + compressed);

    const data = method === 0 ? raw.slice() : await inflateRaw(raw, size);
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`“${path}” in the zip is damaged.`);
    out.push({ path, data, modified: fromDos(time, date) });
  }
  return out;
}
