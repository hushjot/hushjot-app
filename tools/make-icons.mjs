/**
 * Generate the PWA icons.
 *
 * Written by hand rather than pulling in an image library: the mark is a few
 * rectangles, Node already ships zlib, and §28 asks every dependency to
 * justify its bundle, startup, security and maintenance cost. A 90-line
 * generator costs none of those.
 *
 * Run with `npm run icons`. Output goes to `public/icons/`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');

// --- minimal PNG writer ----------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** `pixels` is RGBA, row-major, `size * size * 4` bytes. */
function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark --------------------------------------------------------------

const INK = [0xf2, 0xf4, 0xf6, 0xff];
const BG = [0x16, 0x18, 0x1a, 0xff];

/**
 * A lowercase "t" built from two bars, drawn at whatever size is asked for.
 *
 * `padding` is the fraction of the canvas left empty around the glyph. Maskable
 * icons need a wide safe zone because the platform may crop to a circle, so
 * they get a much larger value than the standard icon.
 */
function drawIcon(size, { padding, rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const radius = rounded ? Math.round(size * 0.22) : 0;

  const set = (x, y, colour) => {
    const i = (y * size + x) * 4;
    px[i] = colour[0];
    px[i + 1] = colour[1];
    px[i + 2] = colour[2];
    px[i + 3] = colour[3];
  };

  // Background, with optional rounded corners.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      if (radius > 0) {
        const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
        const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
      }
      set(x, y, inside ? BG : [0, 0, 0, 0]);
    }
  }

  const inset = Math.round(size * padding);
  const box = size - inset * 2;
  const stroke = Math.max(2, Math.round(box * 0.16));

  // Vertical stem, slightly right of centre so the crossbar reads as a "t".
  const stemX = inset + Math.round(box * 0.42);
  const stemTop = inset + Math.round(box * 0.08);
  const stemBottom = inset + Math.round(box * 0.86);
  for (let y = stemTop; y < stemBottom; y++) {
    for (let x = stemX; x < stemX + stroke; x++) set(x, y, INK);
  }

  // Crossbar.
  const barY = inset + Math.round(box * 0.34);
  const barLeft = inset + Math.round(box * 0.16);
  const barRight = inset + Math.round(box * 0.82);
  for (let y = barY; y < barY + stroke; y++) {
    for (let x = barLeft; x < barRight; x++) set(x, y, INK);
  }

  // Foot: a short tail so the glyph is not mistaken for a plus sign.
  const footY = stemBottom - stroke;
  for (let y = footY; y < stemBottom; y++) {
    for (let x = stemX; x < stemX + Math.round(stroke * 2.4); x++) set(x, y, INK);
  }

  return encodePng(size, px);
}

mkdirSync(outDir, { recursive: true });

const icons = [
  { name: 'icon-192.png', size: 192, padding: 0.16, rounded: true },
  { name: 'icon-512.png', size: 512, padding: 0.16, rounded: true },
  // Maskable icons are cropped by the platform, often to a circle, so the
  // glyph sits well inside the 80% safe zone and the background is full bleed.
  { name: 'icon-maskable-512.png', size: 512, padding: 0.28, rounded: false },
  // iOS ignores the manifest and uses this, always square with no transparency.
  { name: 'apple-touch-icon.png', size: 180, padding: 0.18, rounded: false },
];

for (const icon of icons) {
  const png = drawIcon(icon.size, { padding: icon.padding, rounded: icon.rounded });
  writeFileSync(resolve(outDir, icon.name), png);
  console.log(`${icon.name.padEnd(24)} ${icon.size}×${icon.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
