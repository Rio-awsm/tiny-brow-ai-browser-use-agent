/**
 * Renders the tiny-brow mark to PNG toolbar icons.
 *
 * Drawn procedurally rather than rasterised from the SVG, so the repo needs no
 * image toolchain. Shapes are boolean coverage tests sampled 4x4 per pixel,
 * which is enough antialiasing at these sizes.
 *
 *   npm run icons
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const OUT_DIR = join(process.cwd(), "public", "icon");

/** Brand mint, matching --primary in the dark theme. */
const BRAND: RGB = [0x1f, 0xc4, 0x97];
const GLYPH: RGB = [0xff, 0xff, 0xff];

type RGB = [number, number, number];
type Point = [number, number];

/** All geometry in a 24x24 space, matching Logo.tsx. */
const UNIT = 24;

/** Pointer, sized to read at 16px. */
const CURSOR: Point[] = [
  [8.8, 9.2],
  [8.8, 17.01],
  [10.84, 15.04],
  [11.99, 17.55],
  [13.64, 16.79],
  [12.47, 14.27],
  [15.29, 13.93],
];

const FRAME = { x: 3.0, y: 4.4, w: 18.0, h: 15.2, r: 3.0 };
const TITLE_BAR_BOTTOM = 7.8;

function roundedRect(
  px: number, py: number,
  x: number, y: number, w: number, h: number, r: number,
): boolean {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function inPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The mark: a browser frame with a solid title bar and a pointer inside.
 * `stroke` is widened for small tiles — a hairline outline turns to mush by
 * 16px, which is the size the toolbar actually renders.
 */
function glyphAt(x: number, y: number, stroke: number): boolean {
  const outer = roundedRect(x, y, FRAME.x, FRAME.y, FRAME.w, FRAME.h, FRAME.r);
  if (!outer) return inPolygon(x, y, CURSOR);

  if (y <= TITLE_BAR_BOTTOM) return true;

  const inner = roundedRect(
    x, y,
    FRAME.x + stroke, FRAME.y + stroke,
    FRAME.w - stroke * 2, FRAME.h - stroke * 2,
    Math.max(0.8, FRAME.r - stroke),
  );
  if (!inner) return true;

  return inPolygon(x, y, CURSOR);
}

function render(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const step = UNIT / (size * SUPERSAMPLE);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  // Squeeze the mark inwards so it does not touch the tile edge.
  const pad = size <= 16 ? 0.3 : 1.0;
  const scale = UNIT / (UNIT + pad * 2);
  const stroke = size <= 32 ? 2.1 : 1.75;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let glyph = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const ux = (x * SUPERSAMPLE + sx + 0.5) * step;
          const uy = (y * SUPERSAMPLE + sy + 0.5) * step;

          if (roundedRect(ux, uy, 0.6, 0.6, UNIT - 1.2, UNIT - 1.2, UNIT * 0.235)) {
            tile++;
          }
          const gx = (ux - UNIT / 2) / scale + UNIT / 2;
          const gy = (uy - UNIT / 2) / scale + UNIT / 2;
          if (glyphAt(gx, gy, stroke)) glyph++;
        }
      }

      const tileA = tile / samples;
      const glyphA = (glyph / samples) * tileA;
      const alpha = tileA;

      // Glyph composited over the brand tile, then the whole thing premultiplied
      // out against transparency.
      const mix = (c: number) =>
        alpha === 0 ? 0 : Math.round(((BRAND[c]! * (tileA - glyphA)) + (GLYPH[c]! * glyphA)) / alpha);

      const o = (y * size + x) * 4;
      px[o] = mix(0);
      px[o + 1] = mix(1);
      px[o + 2] = mix(2);
      px[o + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(px, size, size);
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
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

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = render(size);
  const path = join(OUT_DIR, `${size}.png`);
  writeFileSync(path, png);
  console.log(`  ${size}x${size}  ${String(png.length).padStart(6)} bytes  ${path}`);
}
console.log(`\n  ${SIZES.length} icons written\n`);
