// Writes build/icon.ico (16-256 px) using the same drawing as src/icon.js,
// encoded as 32-bit BMP entries so no image library is needed.
import { mkdirSync, writeFileSync } from 'node:fs';

function drawBGRA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const m = Math.round(size * 0.25), len = Math.round(size * 0.2), t = Math.max(2, Math.round(size * 0.08));
  const hi = size - 1 - m;
  const bracket = (x, y) => {
    const nearL = x >= m && x < m + t, nearR = x <= hi && x > hi - t;
    const nearT = y >= m && y < m + t, nearB = y <= hi && y > hi - t;
    const armX = (x >= m && x < m + len) || (x <= hi && x > hi - len);
    const armY = (y >= m && y < m + len) || (y <= hi && y > hi - len);
    return ((nearL || nearR) && armY) || ((nearT || nearB) && armX);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside(x, y)) continue;
      const i = (y * size + x) * 4, w = bracket(x, y);
      buf[i] = w ? 255 : 0xf7; buf[i + 1] = w ? 255 : 0x5b; buf[i + 2] = w ? 255 : 0x5b; buf[i + 3] = 255;
    }
  }
  return buf;
}

/** One ICO image entry: BITMAPINFOHEADER + bottom-up BGRA pixels + AND mask. */
function bmpEntry(size) {
  const px = drawBGRA(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height counts XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const rows = [];
  for (let y = size - 1; y >= 0; y--) rows.push(px.subarray(y * size * 4, (y + 1) * size * 4));
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, ...rows, Buffer.alloc(maskRow * size)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map(bmpEntry);
const dir = Buffer.alloc(6 + sizes.length * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const o = 6 + i * 16;
  dir.writeUInt8(s === 256 ? 0 : s, o);
  dir.writeUInt8(s === 256 ? 0 : s, o + 1);
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(entries[i].length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += entries[i].length;
});
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.ico', Buffer.concat([dir, ...entries]));
console.log(`build/icon.ico (${sizes.join(', ')} px)`);
