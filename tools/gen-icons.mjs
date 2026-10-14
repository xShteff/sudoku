// Generates the PWA app icons as PNGs with no external dependencies.
// A stylized 3x3 sudoku grid (checkerboard of the app's two accent blues)
// on the dark panel background, full-bleed so it also works as a maskable icon.
//
//   node tools/gen-icons.mjs
//
// Outputs icons/icon-192.png, icon-512.png and apple-touch-icon.png.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

// theme colours (match css/styles.css)
const BG = [15, 23, 42];       // #0f172a
const PANEL = [30, 41, 59];    // #1e293b
const A1 = [56, 189, 248];     // #38bdf8
const A2 = [14, 165, 233];     // #0ea5e9

function px(buf, N, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 4;
  // simple source-over alpha blend onto whatever is there
  const inv = (255 - a) / 255, k = a / 255;
  buf[i]     = Math.round(buf[i]     * inv + r * k);
  buf[i + 1] = Math.round(buf[i + 1] * inv + g * k);
  buf[i + 2] = Math.round(buf[i + 2] * inv + b * k);
  buf[i + 3] = 255;
}

// filled rounded rectangle with lightly anti-aliased corners
function roundRect(buf, N, x0, y0, w, h, rad, color) {
  const x1 = x0 + w, y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // distance into the nearest corner's rounded region
      const cx = x < x0 + rad ? x0 + rad : x > x1 - rad ? x1 - rad : x;
      const cy = y < y0 + rad ? y0 + rad : y > y1 - rad ? y1 - rad : y;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let a = 255;
      if ((x < x0 + rad || x > x1 - rad) && (y < y0 + rad || y > y1 - rad)) {
        if (d > rad + 0.5) continue;
        if (d > rad - 0.5) a = Math.round(255 * (rad + 0.5 - d)); // AA edge
      }
      px(buf, N, x, y, color, a);
    }
  }
}

function makePng(N) {
  const buf = Buffer.alloc(N * N * 4);
  // full-bleed background: subtle vertical wash from panel to bg
  for (let y = 0; y < N; y++) {
    const t = y / (N - 1);
    const col = [
      Math.round(PANEL[0] + (BG[0] - PANEL[0]) * t),
      Math.round(PANEL[1] + (BG[1] - PANEL[1]) * t),
      Math.round(PANEL[2] + (BG[2] - PANEL[2]) * t),
    ];
    for (let x = 0; x < N; x++) px(buf, N, x, y, col);
  }

  // 3x3 grid of tiles centred in the safe zone (~62% of the icon)
  const grid = N * 0.62;
  const off = (N - grid) / 2;
  const gap = N * 0.028;
  const tile = (grid - gap * 2) / 3;
  const rad = tile * 0.22;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const color = (r + c) % 2 === 0 ? A1 : A2;
      roundRect(buf, N, off + c * (tile + gap), off + r * (tile + gap), tile, tile, rad, color);
    }
  }
  return encodePng(buf, N);
}

/* ---- minimal PNG encoder (RGBA, no external deps) ---- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, N) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // add per-row filter byte (0 = none)
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(join(OUT, name), makePng(size));
  console.log("wrote icons/" + name);
}
