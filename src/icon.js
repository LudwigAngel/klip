'use strict';
// Tray and window icon. The drawing itself lives in logo-raster.js; the
// recording variant swaps the gradient to red so the tray shows "REC".
const { nativeImage } = require('electron');
const { drawLogo } = require('./logo-raster');

function createIcon(size = 32, { recording = false } = {}) {
  return nativeImage.createFromBitmap(drawLogo(size, { recording, premultiplied: true }), { width: size, height: size });
}

module.exports = { createIcon };
