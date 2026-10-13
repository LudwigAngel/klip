'use strict';
const card = document.getElementById('card');
const thumb = document.getElementById('thumb');
const meta = document.getElementById('meta');
const toast = document.getElementById('toast');
let id = null;
let kind = 'image';
let timeoutMs = 0;
let timer = 0;

function arm() {
  clearTimeout(timer);
  if (timeoutMs > 0) timer = setTimeout(() => window.klip.quickAction(id, 'close'), timeoutMs);
}

window.klip.onQuickInit((data) => {
  id = data.id;
  kind = data.kind || 'image';
  document.body.classList.toggle('video', kind === 'video');
  if (data.side === 'right') document.body.classList.add('right');
  if (data.dataUrl) thumb.src = data.dataUrl;
  meta.textContent = data.label || '';
  if (typeof data.timeoutMs === 'number') { timeoutMs = data.timeoutMs; arm(); }
});

// Hovering keeps the card on screen; leaving restarts the countdown.
card.addEventListener('mouseenter', () => clearTimeout(timer));
card.addEventListener('mouseleave', arm);

function flash(text) {
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1100);
}

const MESSAGES = { copy: 'Copiada', save: 'Guardada', ocr: 'Texto copiado' };

async function act(action) {
  if (!id) return;
  if (action === 'ocr') flash('Reconociendo texto…');
  const ok = await window.klip.quickAction(id, action);
  if (ok && MESSAGES[action]) flash(MESSAGES[action]);
  if (!ok && action === 'ocr') flash('No se encontró texto');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-a]');
  if (btn) act(btn.dataset.a);
});

thumb.addEventListener('dblclick', () => act(kind === 'video' ? 'open' : 'edit'));

// Drag the file out (chat apps, Explorer, editors…).
thumb.addEventListener('dragstart', (e) => {
  e.preventDefault();
  window.klip.quickDrag(id);
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'escape') act('close');
  else if (e.ctrlKey && k === 'c' && kind === 'image') act('copy');
  else if (e.ctrlKey && k === 's') { e.preventDefault(); act('save'); }
  else if (k === 'delete') act('delete');
});

window.klip.ready('quick');
