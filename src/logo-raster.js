'use strict';
// Klip logo "K en el visor": a K inside crop-frame corners on a violet → pink
// rounded square. Drawn with signed-distance math so it is anti-aliased at any
// size and needs no image files or libraries. Shared by the tray/window icon
// (src/icon.js) and the installer icon (scripts/make-icon.mjs).
//
// Geometry lives in a 64×64 design space (same as docs/logo.svg).

const CORNERS = [
  [[13, 21], [13, 13], [21, 13]],
  [[43, 13], [51, 13], [51, 21]],
  [[51, 43], [51, 51], [43, 51]],
  [[21, 51], [13, 51], [13, 43]],
];
const K = [
  [[26, 21], [26, 43]],
  [[39, 21], [28, 32], [39, 43]],
];
const PALETTE = {
  normal: [[0x5b, 0x5b, 0xf7], [0xe1, 0x5b, 0xf7]],
  recording: [[0xe5, 0x39, 0x35], [0xff, 0x5b, 0x8a]],
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function polyDist(px, py, polylines) {
  let d = Infinity;
  for (const line of polylines) {
    for (let i = 1; i < line.length; i++) {
      d = Math.min(d, segDist(px, py, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
    }
  }
  return d;
}

/** Signed distance to the 64×64 rounded square (negative inside). */
function roundedSquare(px, py, r = 14) {
  const qx = Math.abs(px - 32) - (32 - r);
  const qy = Math.abs(py - 32) - (32 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Render the logo as a size×size BGRA buffer.
 * premultiplied: true for Electron nativeImage bitmaps, false for ICO/BMP.
 */
function drawLogo(size, { recording = false, premultiplied = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 64; // device pixels per design unit
  const [c0, c1] = recording ? PALETTE.recording : PALETTE.normal;
  // Tiny icons: drop the thin corners and thicken the K so it stays legible.
  const tiny = size <= 20;
  const kWidth = tiny ? 8 : 6;
  const cornerWidth = 3.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s, py = (y + 0.5) / s;
      const bgA = clamp01(0.5 - roundedSquare(px, py) * s);
      if (bgA <= 0) continue;
      const t = (px + py) / 128;
      let r = c0[0] + (c1[0] - c0[0]) * t;
      let g = c0[1] + (c1[1] - c0[1]) * t;
      let b = c0[2] + (c1[2] - c0[2]) * t;
      const blendWhite = (a) => { r += (255 - r) * a; g += (255 - g) * a; b += (255 - b) * a; };
      if (!tiny) blendWhite(0.78 * clamp01((cornerWidth / 2 - polyDist(px, py, CORNERS)) * s + 0.5));
      blendWhite(clamp01((kWidth / 2 - polyDist(px, py, K)) * s + 0.5));
      const a = bgA;
      const m = premultiplied ? a : 1;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * m);
      buf[i + 1] = Math.round(g * m);
      buf[i + 2] = Math.round(r * m);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

module.exports = { drawLogo };
