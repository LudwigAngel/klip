// Writes build/icon.ico (16-256 px) from the shared logo rasterizer
// (src/logo-raster.js), encoded as 32-bit BMP entries: no image library needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { drawLogo } = require('../src/logo-raster.js');

/** One ICO image entry: BITMAPINFOHEADER + bottom-up BGRA pixels + AND mask. */
function bmpEntry(size) {
  const px = drawLogo(size, { premultiplied: false });
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
