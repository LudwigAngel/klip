'use strict';
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');
const img = new Image();
let cfg = { mode: 'capture', magnifier: true, crosshair: true, allowWindowToggle: false, lockWindowMode: false };
let windowMode = false;
let windows = null; // [{ id, name, rect }] relative to this display, front to back
let ready = false;
let W = 0, H = 0;
let ratioX = 1, ratioY = 1; // image pixels per CSS pixel
let start = null;
let sel = null;
let mouse = { x: -1, y: -1 };
let hovered = null;
let raf = 0;

window.klip.onOverlayInit((data) => {
  cfg = data;
  W = data.width; H = data.height;
  windowMode = data.mode === 'window';
  hint.textContent = data.hint;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  img.onload = () => {
    ratioX = img.naturalWidth / W;
    ratioY = img.naturalHeight / H;
    ready = true;
    draw();
  };
  img.src = data.dataUrl;
});

window.klip.onOverlayWindows((list) => {
  windows = list;
  updateHover();
  schedule();
});

function normalized(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
}

function updateHover() {
  hovered = null;
  if (!windowMode || !windows || mouse.x < 0) return;
  hovered = windows.find((w) => mouse.x >= w.rect.x && mouse.x < w.rect.x + w.rect.width &&
    mouse.y >= w.rect.y && mouse.y < w.rect.y + w.rect.height) || null;
}

function dimExcept(r) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  if (!r) return ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.fill('evenodd');
}

function draw() {
  if (!ready) return;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  if (windowMode) {
    drawWindowMode();
    return;
  }
  if (sel && sel.width > 0 && sel.height > 0) {
    dimExcept(sel);
    ctx.strokeStyle = cfg.mode === 'record' || cfg.mode === 'gif' ? '#ff453a' : '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.width - 1, sel.height - 1);
    sizeLabel();
  } else {
    dimExcept(null);
    if (cfg.crosshair) crosshair();
  }
  if (cfg.magnifier) magnifier();
}

function drawWindowMode() {
  if (!windows) {
    dimExcept(null);
    pill('Buscando ventanas…', W / 2 - 60, H / 2 - 11);
    return;
  }
  // Only the visible part of the hovered window is drawn undimmed.
  const r = hovered && clip(hovered.rect);
  dimExcept(r);
  if (!r) return;
  ctx.fillStyle = 'rgba(91, 91, 247, 0.18)';
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.strokeStyle = '#5b5bf7';
  ctx.lineWidth = 3;
  ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.width - 3, r.height - 3);
  const label = `${hovered.name.slice(0, 60)} · ${Math.round(hovered.rect.width * ratioX)} × ${Math.round(hovered.rect.height * ratioY)}`;
  pill(label, r.x + 8, r.y + 8);
}

function clip(r) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(W, r.x + r.width) - x, h = Math.min(H, r.y + r.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

function crosshair() {
  if (mouse.x < 0) return;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, mouse.y + 0.5); ctx.lineTo(W, mouse.y + 0.5);
  ctx.moveTo(mouse.x + 0.5, 0); ctx.lineTo(mouse.x + 0.5, H);
  ctx.stroke();
  ctx.setLineDash([]);
}

function pill(text, x, y) {
  ctx.font = '12px "Segoe UI", system-ui, sans-serif';
  const w = ctx.measureText(text).width + 14;
  const px = Math.min(Math.max(4, x), W - w - 4);
  const py = Math.min(Math.max(4, y), H - 26);
  ctx.fillStyle = 'rgba(20, 20, 28, 0.88)';
  ctx.beginPath();
  ctx.roundRect(px, py, w, 22, 6);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, px + 7, py + 15);
}

function sizeLabel() {
  const text = `${Math.round(sel.width * ratioX)} × ${Math.round(sel.height * ratioY)}`;
  const below = sel.y + sel.height + 8;
  pill(text, sel.x, below + 26 > H ? sel.y - 30 : below);
}

function magnifier() {
  if (mouse.x < 0) return;
  const size = 120, zoom = 8, src = size / zoom;
  let mx = mouse.x + 24, my = mouse.y + 24;
  if (mx + size > W) mx = mouse.x - size - 24;
  if (my + size + 26 > H) my = mouse.y - size - 50;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath();
  ctx.roundRect(mx, my, size, size, 10);
  ctx.clip();
  ctx.drawImage(img, (mouse.x - src / 2) * ratioX, (mouse.y - src / 2) * ratioY, src * ratioX, src * ratioY, mx, my, size, size);
  ctx.strokeStyle = 'rgba(91, 91, 247, 0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx + size / 2 - zoom / 2, my + size / 2 - zoom / 2, zoom, zoom);
  ctx.restore();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(mx, my, size, size, 10);
  ctx.stroke();
  pill(`${Math.round(mouse.x * ratioX)}, ${Math.round(mouse.y * ratioY)}`, mx, my + size + 4);
}

function toggleWindowMode() {
  if (!cfg.allowWindowToggle || cfg.lockWindowMode) return;
  windowMode = !windowMode;
  start = null; sel = null;
  if (windowMode && !windows) window.klip.overlayWantWindows();
  updateHover();
  schedule();
}

window.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (windowMode) updateHover();
  else if (start) sel = normalized(start, mouse);
  schedule();
});

window.addEventListener('mouseleave', () => { mouse = { x: -1, y: -1 }; hovered = null; schedule(); });

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  hint.style.opacity = '0';
  if (windowMode) return;
  start = { x: e.clientX, y: e.clientY };
  sel = null;
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2) return window.klip.overlayCancel();
  if (e.button !== 0) return;
  if (windowMode) {
    if (hovered) window.klip.overlayPickWindow(hovered.id);
    return;
  }
  if (!start) return;
  const rect = normalized(start, { x: e.clientX, y: e.clientY });
  start = null;
  // A plain click (no drag) selects the whole display.
  window.klip.overlayDone(rect.width < 3 || rect.height < 3 ? null : rect);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.klip.overlayCancel();
  else if (e.key === ' ') { e.preventDefault(); toggleWindowMode(); }
  else if (e.key === 'Enter' && !windowMode) window.klip.overlayDone(null);
});

window.klip.ready('overlay');
