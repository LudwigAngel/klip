'use strict';
// Draws the Klip icon in code so the app ships without binary image assets:
// a rounded square with white viewfinder corners. The recording variant is
// red with a white dot in the middle.
const { nativeImage } = require('electron');

function createIcon(size = 32, { recording = false } = {}) {
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const [R, G, B] = recording ? [0xe5, 0x39, 0x35] : [0x5b, 0x5b, 0xf7];
  const r = size * 0.22; // corner radius
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const m = Math.round(size * 0.25); // bracket margin
  const len = Math.round(size * 0.2); // bracket arm length
  const t = Math.max(2, Math.round(size * 0.08)); // bracket thickness
  const hi = size - 1 - m;
  const bracket = (x, y) => {
    const nearL = x >= m && x < m + t, nearR = x <= hi && x > hi - t;
    const nearT = y >= m && y < m + t, nearB = y <= hi && y > hi - t;
    const armX = (x >= m && x < m + len) || (x <= hi && x > hi - len);
    const armY = (y >= m && y < m + len) || (y <= hi && y > hi - len);
    return ((nearL || nearR) && armY) || ((nearT || nearB) && armX);
  };
  const c = (size - 1) / 2;
  const dot = (x, y) => recording && (x - c) ** 2 + (y - c) ** 2 <= (size * 0.13) ** 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x, y)) continue; // transparent
      const i = (y * size + x) * 4;
      const white = bracket(x, y) || dot(x, y);
      buf[i] = white ? 255 : B;
      buf[i + 1] = white ? 255 : G;
      buf[i + 2] = white ? 255 : R;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

module.exports = { createIcon };
