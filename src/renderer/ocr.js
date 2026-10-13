'use strict';
const text = document.getElementById('text');
const meta = document.getElementById('meta');
const status = document.getElementById('status');

window.klip.onOcrInit((r) => {
  text.value = r.text;
  meta.textContent = `${r.lines} línea${r.lines === 1 ? '' : 's'} · ${r.language}`;
  text.focus();
  text.select();
});

async function copy() {
  const ok = await window.klip.ocrCopy(text.value);
  status.textContent = ok ? 'Copiado al portapapeles.' : 'No se pudo copiar.';
}

document.getElementById('copy').addEventListener('click', copy);
document.getElementById('oneline').addEventListener('click', () => {
  text.value = text.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  copy();
});
document.getElementById('x').addEventListener('click', () => window.klip.closeWindow());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.klip.closeWindow();
  if (e.ctrlKey && e.key === 'Enter') copy();
});
window.klip.ready('ocr');
