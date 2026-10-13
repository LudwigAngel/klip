'use strict';
// Text recognition through the OCR engine built into Windows
// (Windows.Media.Ocr). No network and nothing to install: it uses the
// language packs Windows already has.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runPs } = require('./ps');

/** Installed OCR languages: [{ tag, name }]. */
async function languages() {
  const list = await runPs('ocr.ps1', ['-List']);
  return Array.isArray(list) ? list : [list];
}

/**
 * Recognise the text in a nativeImage. Small crops are upscaled first because
 * the Windows engine misses glyphs shorter than ~20 px.
 */
async function recognize(image, { language = '', keepLineBreaks = true } = {}) {
  let img = image;
  const { width, height } = img.getSize();
  const longest = Math.max(width, height, 1);
  const scale = Math.max(1, Math.min(3, Math.ceil(900 / Math.max(width, 1)), Math.floor(9000 / longest)));
  if (scale > 1) img = img.resize({ width: width * scale, height: height * scale, quality: 'best' });
  const tmp = path.join(os.tmpdir(), `klip-ocr-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(tmp, img.toPNG());
  try {
    const out = await runPs('ocr.ps1', ['-Path', tmp, ...(language ? ['-Lang', language] : [])]);
    const lines = Array.isArray(out.lines) ? out.lines : out.lines ? [out.lines] : [];
    return {
      text: lines.join(keepLineBreaks ? '\r\n' : ' '),
      lines: lines.length,
      language: out.language,
    };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { languages, recognize };
