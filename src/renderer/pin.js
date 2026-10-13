'use strict';
const img = document.getElementById('img');
let drag = null;

window.klip.onPinInit(({ dataUrl }) => { img.src = dataUrl; });

document.getElementById('x').addEventListener('click', () => window.klip.closeWindow());

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.id === 'x') return;
  drag = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  window.klip.pinMove(drag.wx + e.screenX - drag.sx, drag.wy + e.screenY - drag.sy);
});
window.addEventListener('mouseup', () => { drag = null; });

window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) window.klip.pinOpacity(e.deltaY > 0 ? -0.1 : 0.1);
  else window.klip.pinZoom(e.deltaY > 0 ? 0.9 : 1.1);
}, { passive: false });

window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.klip.pinMenu(); });
window.addEventListener('dblclick', () => window.klip.closeWindow());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.klip.closeWindow();
  if (e.key === '+' || e.key === '=') window.klip.pinZoom(1.1);
  if (e.key === '-') window.klip.pinZoom(0.9);
});


window.klip.ready('pin');
