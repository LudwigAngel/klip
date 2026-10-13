'use strict';
// Top-level window discovery for window capture/recording. desktopCapturer
// lists the windows (id "window:<HWND>:0", front-to-back); windows.ps1 asks
// DWM for each window's real on-screen bounds so the overlay can highlight it.
const { desktopCapturer, screen, nativeImage, BrowserWindow } = require('electron');
const { runPs } = require('./ps');

const hwndOf = (sourceId) => String(sourceId).split(':')[1];

/** Visible windows as [{ id, name, rect (DIP, screen coords) }], front to back. */
async function listWindows() {
  const all = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  // Computed after the await: overlays opened meanwhile must be excluded too.
  const own = new Set(BrowserWindow.getAllWindows().map((w) => hwndOf(w.getMediaSourceId())));
  const sources = all.filter((s) => !own.has(hwndOf(s.id)) && s.name && s.name !== 'Program Manager');
  if (!sources.length) return [];
  const bounds = await runPs('windows.ps1', ['-Handles', sources.map((s) => hwndOf(s.id)).join(',')]);
  return sources.flatMap((s) => {
    const b = bounds[hwndOf(s.id)];
    if (!b || b.minimized || b.width < 40 || b.height < 30) return [];
    return [{ id: s.id, name: s.name, physical: b, rect: screen.screenToDipRect(null, b) }];
  });
}

/** Full-resolution image of one window's own content (even if partly covered). */
async function windowImage(win) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: win.physical.width, height: win.physical.height },
  });
  const src = sources.find((s) => s.id === win.id);
  return src && !src.thumbnail.isEmpty() ? src.thumbnail : null;
}

/**
 * Put an image on a transparent canvas with a soft drop shadow, like a macOS
 * window screenshot. Pure pixel math, so it needs no renderer.
 */
function withShadow(image, { blur = 0, offsetY = 0 } = {}) {
  const { width: w, height: h } = image.getSize();
  const b = blur || Math.round(Math.min(60, Math.max(18, Math.max(w, h) * 0.03)));
  const oy = offsetY || Math.round(b * 0.4);
  const pad = b * 2;
  const W = w + pad * 2, H = h + pad * 2;
  const out = Buffer.alloc(W * H * 4); // BGRA, transparent
  const src = image.toBitmap(); // BGRA
  const rx0 = pad, ry0 = pad + oy, rx1 = pad + w, ry1 = pad + h + oy;
  for (let y = 0; y < H; y++) {
    const dy = y < ry0 ? ry0 - y : y >= ry1 ? y - ry1 + 1 : 0;
    for (let x = 0; x < W; x++) {
      const dx = x < rx0 ? rx0 - x : x >= rx1 ? x - rx1 + 1 : 0;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= b * 1.6) continue;
      const t = 1 - d / (b * 1.6);
      out[(y * W + x) * 4 + 3] = Math.round(110 * t * t); // shadow alpha, colour stays black
    }
  }
  for (let y = 0; y < h; y++) {
    src.copy(out, ((y + pad) * W + pad) * 4, y * w * 4, (y + 1) * w * 4);
  }
  return nativeImage.createFromBitmap(out, { width: W, height: H });
}

module.exports = { listWindows, windowImage, withShadow };
