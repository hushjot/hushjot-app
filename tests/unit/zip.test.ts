import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { crc32, readZip, writeZip, isZip, ZipError, MAX_TOTAL_BYTES } from '../../src/core/portability/zip.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A deflated archive with a data descriptor, the way Finder and `zip` write one. */
function deflatedZip(path: string, text: string, declaredSize?: number): Uint8Array {
  const data = enc.encode(text);
  const packed = new Uint8Array(deflateRawSync(data));
  const name = enc.encode(path);
  const size = declaredSize ?? data.length;
  const local = new Uint8Array(30 + name.length + packed.length + 16);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0808, true); // data descriptor + UTF-8
  lv.setUint16(8, 8, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(packed, 30 + name.length);
  const d = 30 + name.length + packed.length;
  lv.setUint32(d, 0x08074b50, true);
  lv.setUint32(d + 4, crc32(data), true);
  lv.setUint32(d + 8, packed.length, true);
  lv.setUint32(d + 12, size, true);

  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(8, 0x0808, true);
  cv.setUint16(10, 8, true);
  cv.setUint16(14, (46 << 9) | (3 << 5) | 17, true); // 2026-03-17
  cv.setUint32(16, crc32(data), true);
  cv.setUint32(20, packed.length, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('writeZip / readZip', () => {
  it('round-trips paths, UTF-8 names, content, directories and timestamps', async () => {
    const modified = new Date(2026, 8, 17, 10, 30, 42).getTime();
    const zip = writeZip([
      { path: 'Ideas/startup.md', data: enc.encode('# Startup\n'), modified },
      { path: 'Café/über 🎉.md', data: enc.encode('héllo'), modified },
      { path: 'Empty/', data: new Uint8Array(0), modified },
    ]);
    expect(isZip(zip)).toBe(true);

    const entries = await readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(['Ideas/startup.md', 'Café/über 🎉.md', 'Empty/']);
    expect(dec.decode(entries[1]!.data)).toBe('héllo');
    expect(entries[0]!.modified).toBe(modified);
  });

  it('reads a deflated archive that uses data descriptors', async () => {
    const text = 'deflate me '.repeat(500);
    const [entry] = await readZip(deflatedZip('notes/a.md', text));
    expect(entry!.path).toBe('notes/a.md');
    expect(dec.decode(entry!.data)).toBe(text);
    expect(new Date(entry!.modified).getFullYear()).toBe(2026);
  });

  it('refuses an entry that inflates past its declared size', async () => {
    await expect(readZip(deflatedZip('bomb.md', 'x'.repeat(10_000), 100))).rejects.toThrow(ZipError);
  });

  it('refuses an archive declaring more than the size budget', async () => {
    await expect(readZip(deflatedZip('big.md', 'x', MAX_TOTAL_BYTES + 1))).rejects.toThrow(/too large/);
  });

  it('refuses something that is not a zip', async () => {
    await expect(readZip(enc.encode('just some text, long enough to scan'))).rejects.toThrow(ZipError);
  });

  it('detects corruption by CRC', async () => {
    const zip = writeZip([{ path: 'a.md', data: enc.encode('hello'), modified: Date.now() }]);
    zip[34] = zip[34]! ^ 0xff; // flip a byte of the stored data
    await expect(readZip(zip)).rejects.toThrow(/damaged/);
  });
});
