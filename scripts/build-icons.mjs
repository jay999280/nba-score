/**
 * Builds the PWA icon set with zero dependencies: a minimal PNG writer
 * (signature + IHDR + zlib IDAT + IEND, CRC32 included) and a tiny flat
 * rasterizer for the basketball glyph.
 *
 * The glyph is the same on every size — a near-black ball outline with seams
 * on white — drawn at 4x and box-downsampled so edges stay crisp without any
 * imaging library.
 *
 * Run:  node scripts/build-icons.mjs
 * Output: public/icon-192.png, public/icon-512.png,
 *         public/icon-maskable-512.png (dark, padded safe zone),
 *         public/apple-touch-icon.png
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(PUBLIC_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Minimal PNG writer (8-bit RGBA, non-interlaced)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0 (none)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Basketball glyph
// ---------------------------------------------------------------------------

/** Quadratic bezier point. */
function qbezier(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

/**
 * Render the glyph into an RGBA buffer at 4x, then box-downsample.
 * `ink` / `paper` are [r, g, b]; `ballScale` shrinks the ball for the
 * maskable safe zone.
 */
function render(size, ink, paper, ballScale = 1) {
  const SS = 4;
  const big = size * SS;
  const buf = new Float32Array(big * big * 4);
  const cx = big / 2;
  const cy = big / 2;
  const R = big * 0.3 * ballScale;
  const stroke = big * 0.022;

  // Seams sampled as polyline point lists (in big pixels).
  const seams = [];
  const stamp = (list) => seams.push(list);
  const vline = [];
  for (let i = 0; i <= 60; i++) vline.push([cx, cy - R + (2 * R * i) / 60]);
  stamp(vline);
  const hline = [];
  for (let i = 0; i <= 60; i++) hline.push([cx - R + (2 * R * i) / 60, cy]);
  stamp(hline);
  // Side seams: start at ±60° on the circle, bow inward to ~0.74R.
  const ex = Math.cos(Math.PI / 3) * R;
  const ey = Math.sin(Math.PI / 3) * R;
  const ccx = 0.98 * R;
  for (const side of [-1, 1]) {
    const curve = [];
    for (let i = 0; i <= 80; i++) {
      curve.push(
        qbezier(
          [cx + side * ex, cy - ey],
          [cx + side * ccx, cy],
          [cx + side * ex, cy + ey],
          i / 80,
        ),
      );
    }
    stamp(curve);
  }

  // Coverage mask at 4x: stamp disks along every stroke, then downsample.
  // (A per-pixel distance test would be O(pixels × points); stamping is not.)
  const mask = new Float32Array(big * big);
  const stampDisk = (px, py) => {
    const r = stroke / 2;
    const x0 = Math.max(0, Math.floor(px - r));
    const x1 = Math.min(big - 1, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r));
    const y1 = Math.min(big - 1, Math.ceil(py + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ddx = x + 0.5 - px;
        const ddy = y + 0.5 - py;
        if (ddx * ddx + ddy * ddy <= r * r) mask[y * big + x] += 1;
      }
    }
  };

  for (let a = 0; a < 720; a++) {
    const t = (a / 720) * Math.PI * 2;
    stampDisk(cx + R * Math.cos(t), cy + R * Math.sin(t));
  }
  for (const list of seams) {
    for (const [px, py] of list) stampDisk(px, py);
  }

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const covered = mask[y * big + x] > 0.5;
      const i = (y * big + x) * 4;
      buf[i] = covered ? ink[0] : paper[0];
      buf[i + 1] = covered ? ink[1] : paper[1];
      buf[i + 2] = covered ? ink[2] : paper[2];
      buf[i + 3] = 255;
    }
  }

  // Box downsample 4x4.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * big + (x * SS + dx)) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / 16);
      out[o + 1] = Math.round(g / 16);
      out[o + 2] = Math.round(b / 16);
      out[o + 3] = 255;
    }
  }
  return out;
}

const BLACK = [11, 11, 12];
const WHITE = [255, 255, 255];

const targets = [
  { file: "icon-192.png", size: 192, ink: BLACK, paper: WHITE, scale: 1 },
  { file: "icon-512.png", size: 512, ink: BLACK, paper: WHITE, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, ink: WHITE, paper: BLACK, scale: 0.72 },
  { file: "apple-touch-icon.png", size: 180, ink: BLACK, paper: WHITE, scale: 1 },
];

for (const target of targets) {
  const rgba = render(target.size, target.ink, target.paper, target.scale);
  writeFileSync(join(PUBLIC_DIR, target.file), encodePng(target.size, target.size, rgba));
  console.log(`wrote public/${target.file} (${target.size}x${target.size})`);
}
