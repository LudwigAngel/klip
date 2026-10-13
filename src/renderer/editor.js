'use strict';
// Klip image editor. Every annotation is an object in `objects`; the canvas is
// re-rendered from the base image + objects on every change, so anything can
// be selected, moved, resized, restyled or deleted later. Undo/redo stores
// whole snapshots of `objects`.
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const wrap = $('wrap');
const main = $('main');
const ui = {
  width: $('width'), fill: $('fill'), dashed: $('dashed'), shadow: $('shadow'),
  arrowStyle: $('arrowStyle'), textStyle: $('textStyle'), zoomLevel: $('zoomLevel'), counterStyle: $('counterStyle'),
  customColor: $('customColor'), bg: $('bg'), bg1: $('bg1'), bg2: $('bg2'),
  stickers: $('stickers'), hint: $('hint'), status: $('status'), zoomLabel: $('zoomLabel'),
};

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#5b5bf7', '#ff2d92', '#ffffff', '#111111'];
const STICKERS = ['✅', '❌', '⚠️', '❓', '❗', '💡', '👉', '👈', '👆', '👇', '⭐', '🔥', '❤️', '👍', '👎', '🚫', '🔒', '🐛', '🎯', '📌'];
const BOX_TYPES = new Set(['rect', 'ellipse', 'pixelate', 'blur', 'spotlight', 'hlbox', 'sticker', 'magnify']);
const REDACT_TYPES = new Set(['pixelate', 'blur']);
const HINTS = {
  select: 'Clic para seleccionar · arrastra para mover · tiradores para redimensionar · Supr borra · Ctrl+D duplica · flechas mueven',
  arrow: 'Arrastra para dibujar una flecha · Shift: ángulos de 45°',
  curve: 'Arrastra para dibujar; luego mueve el tirador del centro para curvarla',
  line: 'Arrastra para dibujar una línea · Shift: ángulos de 45°',
  rect: 'Arrastra para dibujar · Shift: cuadrado', ellipse: 'Arrastra para dibujar · Shift: círculo',
  pen: 'Dibuja a mano alzada', highlight: 'Resalta a mano alzada', hlbox: 'Arrastra sobre la zona a resaltar',
  text: 'Clic para escribir · Enter termina · Shift+Enter nueva línea · doble clic edita un texto',
  counter: 'Clic para colocar el siguiente número', sticker: 'Elige un emoji y haz clic donde colocarlo',
  spotlight: 'Arrastra sobre lo importante: el resto se oscurece', magnify: 'Arrastra sobre la zona a ampliar; mueve la burbuja después',
  blur: 'Arrastra sobre la zona a difuminar', pixelate: 'Arrastra sobre la zona a pixelar', crop: 'Arrastra el área que quieres conservar',
};

const base = new Image();
let captureId = null;
let tool = 'arrow';
let color = COLORS[0];
let sticker = STICKERS[0];
let objects = [];
let undoStack = [];
let redoStack = [];
let selectedId = null;
let drag = null; // { kind: 'draw'|'move'|'handle', ... }
let textBox = null;
let background = false;
let zoom = null; // null = fit to window
let nextId = 1;

// ================================================================ setup

COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.title = c;
  b.setAttribute('aria-label', `Color ${c}`);
  b.setAttribute('aria-pressed', String(i === 0));
  b.addEventListener('click', () => setColor(c));
  $('colors').insertBefore(b, ui.customColor);
});
ui.customColor.addEventListener('input', () => setColor(ui.customColor.value));

STICKERS.forEach((s) => {
  const b = document.createElement('button');
  b.textContent = s;
  b.title = `Colocar ${s}`;
  b.setAttribute('aria-label', `Emoji ${s}`);
  b.addEventListener('click', () => {
    sticker = s;
    setTool('sticker');
    const o = selected();
    if (o?.type === 'sticker') updateSelected({ emoji: s });
  });
  ui.stickers.appendChild(b);
});

function setColor(c) {
  color = c;
  document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', String(s.title === c)));
  updateSelected({ color: c });
}

$('tools').parentElement.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tool]');
  if (b) setTool(b.dataset.tool);
});

function setTool(t) {
  commitText();
  tool = t;
  if (t !== 'select' && !(t === 'sticker' && selected()?.type === 'sticker')) selectedId = null;
  document.querySelectorAll('button[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  ui.stickers.classList.toggle('show', t === 'sticker' || selected()?.type === 'sticker');
  canvas.className = t === 'select' ? 'select' : '';
  ui.hint.textContent = HINTS[t] || '';
  render();
}

// Property controls also restyle the selected object.
ui.width.addEventListener('input', () => {
  const o = selected();
  if (!o) return;
  if (o.type === 'text') updateSelected({ size: textSize() }, false);
  else updateSelected({ width: Number(ui.width.value) }, false);
});
ui.width.addEventListener('change', () => { if (selected()) checkpointPending(); });
ui.fill.addEventListener('change', () => updateSelected({ fill: ui.fill.checked }));
ui.dashed.addEventListener('change', () => updateSelected({ dashed: ui.dashed.checked }));
ui.shadow.addEventListener('change', () => updateSelected({ shadow: ui.shadow.checked }));
ui.arrowStyle.addEventListener('change', () => updateSelected({ heads: ui.arrowStyle.value }));
ui.textStyle.addEventListener('change', () => updateSelected({ style: ui.textStyle.value }));
ui.zoomLevel.addEventListener('change', () => updateSelected({ zoom: Number(ui.zoomLevel.value) }));
ui.counterStyle.addEventListener('change', () => {
  // Restyle every step number at once so the sequence stays consistent.
  const counters = objects.filter((o) => o.type === 'counter');
  if (!counters.length) return;
  checkpoint();
  counters.forEach((o) => { o.cstyle = ui.counterStyle.value; });
  render(); updateButtons();
});

window.klip.onEditorInit(({ id, dataUrl }) => {
  captureId = id;
  base.onload = () => { render(); fit(); };
  base.src = dataUrl;
});
window.addEventListener('resize', fit);

// ================================================================ geometry

const textSize = () => 10 + Number(ui.width.value) * 4;
const uid = () => `o${nextId++}`;
const selected = () => objects.find((o) => o.id === selectedId) || null;

function view() {
  for (let i = objects.length - 1; i >= 0; i--) if (objects[i].type === 'crop') return objects[i].rect;
  return { x: 0, y: 0, width: base.naturalWidth, height: base.naturalHeight };
}
function padding(v) { return background ? Math.round(Math.max(v.width, v.height) * 0.08) : 0; }
function layout() {
  const v = view();
  const p = padding(v);
  return { v, p, width: v.width + p * 2, height: v.height + p * 2 };
}

function fitScale() {
  return Math.min((main.clientWidth - 48) / canvas.width, (main.clientHeight - 48) / canvas.height, 1);
}
function displayScale() { return zoom ?? fitScale(); }

function fit() {
  if (!base.naturalWidth) return;
  const s = displayScale();
  canvas.style.width = `${Math.round(canvas.width * s)}px`;
  canvas.style.height = `${Math.round(canvas.height * s)}px`;
  ui.zoomLabel.textContent = `${Math.round(s * 100)}%`;
}

function setZoom(z) {
  zoom = z === null ? null : Math.min(8, Math.max(0.1, z));
  fit();
}

/** Screen pixels -> image pixels ratio (for constant-size handles). */
function pxRatio() {
  const r = canvas.getBoundingClientRect();
  return r.width ? canvas.width / r.width : 1;
}

function toImage(e) {
  const r = canvas.getBoundingClientRect();
  const { v, p } = layout();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width) - p + v.x,
    y: (e.clientY - r.top) * (canvas.height / r.height) - p + v.y,
  };
}

function toClient(pt) {
  const r = canvas.getBoundingClientRect();
  const { v, p } = layout();
  const s = r.width / canvas.width;
  return { x: (pt.x + p - v.x) * s + r.left, y: (pt.y + p - v.y) * s + r.top };
}

function rectOf(o) {
  return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), width: Math.abs(o.x2 - o.x1), height: Math.abs(o.y2 - o.y1) };
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function curvePoints(o, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({ x: u * u * o.x1 + 2 * u * t * o.cx + t * t * o.x2, y: u * u * o.y1 + 2 * u * t * o.cy + t * t * o.y2 });
  }
  return pts;
}

function textMetrics(o) {
  ctx.save();
  ctx.font = `600 ${o.size}px "Segoe UI", system-ui, sans-serif`;
  const lines = o.text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const pad = o.style === 'label' ? o.size * 0.35 : 0;
  return { x: o.x - pad, y: o.y - pad, width: w + pad * 2, height: lines.length * o.size * 1.2 + pad * 2, pad, lines };
}

/** Magnifier bubble: centre + radius in image coords. */
function bubbleOf(o) {
  const r = rectOf(o);
  const side = Math.max(r.width, r.height, 10);
  return { cx: o.bx, cy: o.by, r: (side * o.zoom) / 2, side, sx: r.x + r.width / 2 - side / 2, sy: r.y + r.height / 2 - side / 2 };
}

/** Bounding box of an object (selection outline + hit-testing). */
function boxOf(o) {
  switch (o.type) {
    case 'line': case 'arrow': {
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), width: Math.abs(o.x2 - o.x1), height: Math.abs(o.y2 - o.y1) };
    }
    case 'curve': {
      const pts = curvePoints(o);
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    case 'pen': case 'highlight': {
      const xs = o.points.map((p) => p.x), ys = o.points.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    case 'text': return textMetrics(o);
    case 'counter': { const r = counterRadius(o); return { x: o.x - r, y: o.y - r, width: r * 2, height: r * 2 }; }
    case 'magnify': {
      const b = bubbleOf(o), s = rectOf(o);
      const x = Math.min(s.x, b.cx - b.r), y = Math.min(s.y, b.cy - b.r);
      return { x, y, width: Math.max(s.x + s.width, b.cx + b.r) - x, height: Math.max(s.y + s.height, b.cy + b.r) - y };
    }
    default: return rectOf(o);
  }
}

const counterRadius = (o) => 10 + o.width * 1.6;

/** Hit test: returns { part } or null. Front-most object wins. */
function hitTest(o, p) {
  const tol = Math.max(8 * pxRatio(), (o.width || 4) * 1.2);
  const inside = (r, m = 0) => p.x >= r.x - m && p.x <= r.x + r.width + m && p.y >= r.y - m && p.y <= r.y + r.height + m;
  switch (o.type) {
    case 'line': case 'arrow':
      return distToSegment(p, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }) <= tol ? { part: 'body' } : null;
    case 'curve': {
      const pts = curvePoints(o);
      for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= tol) return { part: 'body' };
      return null;
    }
    case 'pen': case 'highlight': {
      const t = o.type === 'highlight' ? tol * 3 : tol;
      for (let i = 1; i < o.points.length; i++) if (distToSegment(p, o.points[i - 1], o.points[i]) <= t) return { part: 'body' };
      return null;
    }
    case 'rect': case 'ellipse': {
      const r = rectOf(o);
      if (o.fill || r.width < tol * 4 || r.height < tol * 4) return inside(r, tol) ? { part: 'body' } : null;
      const nearEdge = inside(r, tol) && !(p.x > r.x + tol && p.x < r.x + r.width - tol && p.y > r.y + tol && p.y < r.y + r.height - tol);
      return nearEdge ? { part: 'body' } : null;
    }
    case 'counter': return Math.hypot(p.x - o.x, p.y - o.y) <= counterRadius(o) + tol / 2 ? { part: 'body' } : null;
    case 'magnify': {
      const b = bubbleOf(o);
      if (Math.hypot(p.x - b.cx, p.y - b.cy) <= b.r) return { part: 'bubble' };
      return inside(rectOf(o), tol / 2) ? { part: 'body' } : null;
    }
    default: return inside(boxOf(o), tol / 2) ? { part: 'body' } : null;
  }
}

function pick(p) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type === 'crop') continue;
    const h = hitTest(o, p);
    if (h) return { o, part: h.part };
  }
  return null;
}

function handlesOf(o) {
  switch (o.type) {
    case 'line': case 'arrow': return [{ name: 'a', x: o.x1, y: o.y1 }, { name: 'b', x: o.x2, y: o.y2 }];
    case 'curve': return [{ name: 'a', x: o.x1, y: o.y1 }, { name: 'b', x: o.x2, y: o.y2 }, { name: 'c', x: o.cx, y: o.cy, round: true }];
    case 'text': { const m = textMetrics(o); return [{ name: 'size', x: m.x + m.width, y: m.y + m.height }]; }
    case 'pen': case 'highlight': case 'counter': return [];
    default: {
      if (!BOX_TYPES.has(o.type)) return [];
      const r = rectOf(o);
      return [
        { name: 'nw', x: r.x, y: r.y }, { name: 'ne', x: r.x + r.width, y: r.y },
        { name: 'sw', x: r.x, y: r.y + r.height }, { name: 'se', x: r.x + r.width, y: r.y + r.height },
      ];
    }
  }
}

function handleAt(o, p) {
  const hs = 7 * pxRatio();
  return handlesOf(o).find((h) => Math.abs(p.x - h.x) <= hs && Math.abs(p.y - h.y) <= hs) || null;
}

function translate(o, dx, dy, part = 'body') {
  if (o.type === 'magnify' && part === 'bubble') { o.bx += dx; o.by += dy; return; }
  if ('x1' in o) { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
  if ('cx' in o) { o.cx += dx; o.cy += dy; }
  if (o.type === 'magnify') { o.bx += dx; o.by += dy; }
  if ('x' in o && !('x1' in o)) { o.x += dx; o.y += dy; }
  if (o.points) o.points = o.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
}

function applyHandle(o, orig, name, p, shift) {
  if (name === 'a') { o.x1 = p.x; o.y1 = p.y; return; }
  if (name === 'b') {
    o.x2 = p.x; o.y2 = p.y;
    if (shift && o.type !== 'curve') constrain(o);
    return;
  }
  if (name === 'c') { o.cx = p.x; o.cy = p.y; return; }
  if (name === 'size') {
    const m = textMetrics(orig);
    const ratio = Math.max(0.2, (p.y - m.y) / Math.max(1, m.height));
    o.size = Math.max(8, Math.round(orig.size * ratio));
    return;
  }
  const r = rectOf(orig);
  let x1 = r.x, y1 = r.y, x2 = r.x + r.width, y2 = r.y + r.height;
  if (name.includes('w')) x1 = p.x; else x2 = p.x;
  if (name.includes('n')) y1 = p.y; else y2 = p.y;
  if (o.type === 'sticker' || shift) {
    const s = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    if (name.includes('w')) x1 = x2 - s; else x2 = x1 + s;
    if (name.includes('n')) y1 = y2 - s; else y2 = y1 + s;
  }
  Object.assign(o, { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) });
}

function constrain(d) {
  const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
  if (BOX_TYPES.has(d.type) || d.type === 'crop') {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    d.x2 = d.x1 + Math.sign(dx || 1) * s; d.y2 = d.y1 + Math.sign(dy || 1) * s;
  } else {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    d.x2 = d.x1 + Math.cos(ang) * len; d.y2 = d.y1 + Math.sin(ang) * len;
  }
}

function clampToImage(r) {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  return { x, y, width: Math.min(base.naturalWidth - x, Math.round(r.width)), height: Math.min(base.naturalHeight - y, Math.round(r.height)) };
}

// ================================================================ rendering

function render(target = canvas, { forExport = false } = {}) {
  if (!base.naturalWidth) return;
  const c = target.getContext('2d');
  const { v, p, width, height } = layout();
  if (target.width !== width || target.height !== height) {
    target.width = width; target.height = height;
    if (target === canvas) requestAnimationFrame(fit);
  }
  c.clearRect(0, 0, width, height);
  const radius = background ? Math.round(Math.min(v.width, v.height) * 0.025) + 4 : 0;
  if (background) {
    const g = c.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, ui.bg1.value);
    g.addColorStop(1, ui.bg2.value);
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
    c.save();
    c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = p * 0.5; c.shadowOffsetY = p * 0.12;
    c.fillStyle = '#000';
    c.beginPath(); c.roundRect(p, p, v.width, v.height, radius); c.fill();
    c.restore();
  }
  c.save();
  c.beginPath(); c.roundRect(p, p, v.width, v.height, radius); c.clip();
  c.translate(p - v.x, p - v.y);
  c.drawImage(base, 0, 0);

  const drawing = drag?.kind === 'draw' && drag.obj.type !== 'crop' ? [...objects, drag.obj] : objects;
  const list = drawing.filter((o) => o.type !== 'crop');
  // Order: redactions -> spotlight dimming -> everything else, so a spotlight
  // never darkens arrows or text drawn to explain it.
  list.filter((o) => REDACT_TYPES.has(o.type)).forEach((o) => drawObject(c, o));
  const spots = list.filter((o) => o.type === 'spotlight');
  if (spots.length) drawSpotlights(c, spots, v);
  let counter = 0;
  for (const o of list) {
    if (REDACT_TYPES.has(o.type) || o.type === 'spotlight') continue;
    if (o.type === 'counter') counter += 1;
    drawObject(c, o, counter);
  }
  if (!forExport) drawSelection(c);
  c.restore();
  if (!forExport && drag?.kind === 'draw' && drag.obj.type === 'crop') drawCropGuide(c, drag.obj, p, v);
}

function strokeStyle(c, o) {
  c.strokeStyle = o.color;
  c.fillStyle = o.color;
  c.lineWidth = o.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (o.dashed) c.setLineDash([o.width * 2.5, o.width * 2]);
  if (o.shadow) { c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 4 + o.width; c.shadowOffsetY = 2; }
}

function drawObject(c, o, counterNumber = 0) {
  if (o.hidden) return; // text currently open in the inline editor
  c.save();
  strokeStyle(c, o);
  switch (o.type) {
    case 'rect': {
      const r = rectOf(o);
      c.beginPath(); c.roundRect(r.x, r.y, r.width, r.height, Math.min(8, o.width * 1.5));
      o.fill ? c.fill() : c.stroke();
      break;
    }
    case 'ellipse': {
      const r = rectOf(o);
      c.beginPath(); c.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
      o.fill ? c.fill() : c.stroke();
      break;
    }
    case 'line':
      c.beginPath(); c.moveTo(o.x1, o.y1); c.lineTo(o.x2, o.y2); c.stroke();
      break;
    case 'arrow':
      drawArrow(c, o, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 });
      break;
    case 'curve':
      drawArrow(c, o, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }, { x: o.cx, y: o.cy }, { x: o.cx, y: o.cy });
      break;
    case 'pen': case 'highlight':
      c.setLineDash([]);
      if (o.type === 'highlight') {
        c.shadowColor = 'transparent';
        c.globalAlpha = 0.4; c.globalCompositeOperation = 'multiply'; c.lineWidth = o.width * 4; c.lineCap = 'square';
      }
      c.beginPath();
      o.points.forEach((pt, i) => (i ? c.lineTo(pt.x, pt.y) : c.moveTo(pt.x, pt.y)));
      c.stroke();
      break;
    case 'hlbox': {
      const r = rectOf(o);
      c.shadowColor = 'transparent';
      c.globalAlpha = 0.38; c.globalCompositeOperation = 'multiply';
      c.fillRect(r.x, r.y, r.width, r.height);
      break;
    }
    case 'text': drawText(c, o); break;
    case 'counter': {
      const r = counterRadius(o);
      const style = o.cstyle || 'filled';
      const outline = style.endsWith('outline');
      const label = style.startsWith('letters') ? counterLetter(counterNumber) : String(counterNumber);
      c.setLineDash([]);
      c.beginPath(); c.arc(o.x, o.y, r, 0, Math.PI * 2);
      if (outline) {
        c.lineWidth = Math.max(3, r * 0.18);
        c.stroke();
        c.fillStyle = o.color;
      } else {
        c.fill();
        c.shadowColor = 'transparent';
        c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
        c.fillStyle = contrastOn(o.color);
      }
      c.shadowColor = 'transparent';
      c.font = `700 ${Math.round(r * (label.length > 1 ? 0.9 : 1.1))}px "Segoe UI", system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, o.x, o.y + 1);
      break;
    }
    case 'sticker': {
      const r = rectOf(o);
      const s = Math.min(r.width, r.height);
      c.font = `${Math.round(s * 0.85)}px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(o.emoji, r.x + r.width / 2, r.y + r.height / 2 + s * 0.04);
      break;
    }
    case 'pixelate': drawPixelate(c, rectOf(o)); break;
    case 'blur': drawBlur(c, rectOf(o), o.width); break;
    case 'magnify': drawMagnifier(c, o); break;
    default: break;
  }
  c.restore();
}

/** 1 -> A, 26 -> Z, 27 -> AA … */
function counterLetter(n) {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

function contrastOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 165 ? '#111' : '#fff';
}

function drawHead(c, tip, from, size) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  c.save();
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(tip.x, tip.y);
  c.lineTo(tip.x - size * Math.cos(ang - Math.PI / 7), tip.y - size * Math.sin(ang - Math.PI / 7));
  c.lineTo(tip.x - size * Math.cos(ang + Math.PI / 7), tip.y - size * Math.sin(ang + Math.PI / 7));
  c.closePath();
  c.fill();
  c.restore();
}

/** Straight (control = endpoints) or quadratic arrow with optional heads. */
function drawArrow(c, o, a, b, ctrlA, ctrlB) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const head = Math.min(len * 0.45, 12 + o.width * 3);
  const heads = o.heads || 'end';
  // pull the shaft back so its round cap does not poke through the tip
  const pull = (tip, from) => {
    const d = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
    return { x: tip.x - ((tip.x - from.x) / d) * head * 0.7, y: tip.y - ((tip.y - from.y) / d) * head * 0.7 };
  };
  const fromB = o.type === 'curve' ? ctrlB : a;
  const fromA = o.type === 'curve' ? ctrlA : b;
  const end = heads === 'none' ? b : pull(b, fromB);
  const start = heads === 'both' ? pull(a, fromA) : a;
  c.beginPath();
  c.moveTo(start.x, start.y);
  if (o.type === 'curve') c.quadraticCurveTo(o.cx, o.cy, end.x, end.y);
  else c.lineTo(end.x, end.y);
  c.stroke();
  if (heads !== 'none') drawHead(c, b, fromB, head);
  if (heads === 'both') drawHead(c, a, fromA, head);
}

function drawText(c, o) {
  const m = textMetrics(o);
  c.setLineDash([]);
  c.font = `600 ${o.size}px "Segoe UI", system-ui, sans-serif`;
  c.textBaseline = 'top';
  if (o.style === 'label') {
    c.beginPath(); c.roundRect(m.x, m.y, m.width, m.height, o.size * 0.3); c.fill();
    c.shadowColor = 'transparent';
    c.fillStyle = contrastOn(o.color);
  }
  m.lines.forEach((line, i) => {
    const y = o.y + i * o.size * 1.2;
    if (o.style === 'outline' || !o.style) {
      c.save();
      c.shadowColor = 'transparent';
      c.lineWidth = Math.max(2, o.size / 8);
      c.strokeStyle = contrastOn(o.color) === '#fff' ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.6)';
      if (contrastOn(o.color) === '#fff') c.strokeStyle = 'rgba(255,255,255,.85)';
      c.strokeText(line, o.x, y);
      c.restore();
    }
    c.fillText(line, o.x, y);
  });
}

const fxCanvas = document.createElement('canvas');
function drawPixelate(c, r) {
  if (r.width < 2 || r.height < 2) return;
  const block = Math.max(6, Math.round(Math.min(r.width, r.height) / 12));
  const w = Math.max(1, Math.round(r.width / block)), h = Math.max(1, Math.round(r.height / block));
  fxCanvas.width = w; fxCanvas.height = h;
  const fc = fxCanvas.getContext('2d');
  fc.imageSmoothingEnabled = true;
  fc.drawImage(base, r.x, r.y, r.width, r.height, 0, 0, w, h);
  c.imageSmoothingEnabled = false;
  c.drawImage(fxCanvas, 0, 0, w, h, r.x, r.y, r.width, r.height);
}

function drawBlur(c, r, strength) {
  if (r.width < 2 || r.height < 2) return;
  const radius = 4 + strength * 1.5;
  const m = Math.ceil(radius * 2); // sample outside the box so edges stay opaque
  c.save();
  c.beginPath(); c.rect(r.x, r.y, r.width, r.height); c.clip();
  c.filter = `blur(${radius}px)`;
  c.drawImage(base, r.x - m, r.y - m, r.width + m * 2, r.height + m * 2, r.x - m, r.y - m, r.width + m * 2, r.height + m * 2);
  c.restore();
}

function drawSpotlights(c, spots, v) {
  c.save();
  c.fillStyle = 'rgba(0, 0, 0, 0.6)';
  c.beginPath();
  c.rect(v.x, v.y, v.width, v.height);
  spots.forEach((o) => {
    const r = rectOf(o);
    c.roundRect(r.x, r.y, r.width, r.height, Math.min(12, r.width / 4, r.height / 4));
  });
  c.fill('evenodd');
  c.restore();
}

function drawMagnifier(c, o) {
  const r = rectOf(o);
  const b = bubbleOf(o);
  c.setLineDash([]);
  // connector + source frame
  c.save();
  c.shadowColor = 'transparent';
  c.lineWidth = Math.max(2, o.width / 2);
  c.beginPath(); c.moveTo(r.x + r.width / 2, r.y + r.height / 2); c.lineTo(b.cx, b.cy); c.stroke();
  c.strokeRect(r.x, r.y, r.width, r.height);
  c.restore();
  // bubble
  c.save();
  c.beginPath(); c.arc(b.cx, b.cy, b.r, 0, Math.PI * 2); c.fill(); // casts the shadow
  c.clip();
  c.shadowColor = 'transparent';
  c.imageSmoothingQuality = 'high';
  c.drawImage(base, b.sx, b.sy, b.side, b.side, b.cx - b.r, b.cy - b.r, b.r * 2, b.r * 2);
  c.restore();
  c.save();
  c.lineWidth = o.width;
  c.beginPath(); c.arc(b.cx, b.cy, b.r, 0, Math.PI * 2); c.stroke();
  c.restore();
}

function drawSelection(c) {
  const o = selected();
  if (!o) return;
  const k = pxRatio();
  const bx = boxOf(o);
  c.save();
  c.shadowColor = 'transparent';
  c.setLineDash([5 * k, 4 * k]);
  c.lineWidth = 1.5 * k;
  c.strokeStyle = '#5b5bf7';
  const m = 4 * k;
  c.strokeRect(bx.x - m, bx.y - m, bx.width + m * 2, bx.height + m * 2);
  c.setLineDash([]);
  for (const h of handlesOf(o)) {
    c.fillStyle = '#fff';
    c.strokeStyle = '#5b5bf7';
    c.lineWidth = 1.5 * k;
    c.beginPath();
    if (h.round) c.arc(h.x, h.y, 6 * k, 0, Math.PI * 2);
    else c.rect(h.x - 5 * k, h.y - 5 * k, 10 * k, 10 * k);
    c.fill(); c.stroke();
  }
  c.restore();
}

function drawCropGuide(c, o, p, v) {
  const r = rectOf(o);
  const x = r.x - v.x + p, y = r.y - v.y + p;
  c.save();
  c.fillStyle = 'rgba(0,0,0,.5)';
  c.beginPath(); c.rect(0, 0, c.canvas.width, c.canvas.height); c.rect(x, y, r.width, r.height); c.fill('evenodd');
  c.strokeStyle = '#fff'; c.setLineDash([6, 4]); c.lineWidth = Math.max(1, pxRatio());
  c.strokeRect(x, y, r.width, r.height);
  c.restore();
}

// ================================================================ history

const snapshot = () => JSON.stringify(objects);
let pendingSnapshot = null;

function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  pendingSnapshot = null;
}
/** For continuous edits (slider drags): snapshot once, before the first change. */
function checkpointLazy() { if (pendingSnapshot === null) pendingSnapshot = snapshot(); }
function checkpointPending() {
  if (pendingSnapshot === null) return;
  undoStack.push(pendingSnapshot);
  redoStack = [];
  pendingSnapshot = null;
  updateButtons();
}

function restore(state) {
  objects = JSON.parse(state);
  if (!selected()) selectedId = null;
  render();
  updateButtons();
}
function undo() { commitText(); if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

function addObject(o) {
  checkpoint();
  o.id = uid();
  objects.push(o);
  if (o.type !== 'crop' && o.type !== 'pen' && o.type !== 'highlight') selectedId = o.id;
  render();
  updateButtons();
}

function updateSelected(props, immediate = true) {
  const o = selected();
  if (!o) return;
  const applicable = Object.fromEntries(Object.entries(props).filter(([k]) => k in o || ['dashed', 'shadow', 'heads', 'style', 'fill'].includes(k)));
  if (!Object.keys(applicable).length) return;
  if (immediate) checkpoint(); else checkpointLazy();
  Object.assign(o, applicable);
  render();
  updateButtons();
}

function deleteSelected() {
  if (!selected()) return;
  checkpoint();
  objects = objects.filter((o) => o.id !== selectedId);
  selectedId = null;
  render();
  updateButtons();
}

function duplicateSelected() {
  const o = selected();
  if (!o) return;
  const copy = JSON.parse(JSON.stringify(o));
  translate(copy, 20, 20);
  addObject(copy);
}

function reorderSelected(toFront) {
  const o = selected();
  if (!o) return;
  checkpoint();
  objects = objects.filter((x) => x !== o);
  if (toFront) objects.push(o); else objects.unshift(o);
  render();
}

function updateButtons() {
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
  $('delete').disabled = !selected();
  $('clear').disabled = !objects.some((o) => o.type !== 'crop');
  $('reset-crop').disabled = !objects.some((o) => o.type === 'crop');
}

/** Reflect the selected object's style in the property controls. */
function syncControls(o) {
  if (!o) return;
  if (o.type === 'text') ui.width.value = Math.round((o.size - 10) / 4);
  else if (o.width) ui.width.value = o.width;
  if ('fill' in o) ui.fill.checked = o.fill;
  if ('dashed' in o) ui.dashed.checked = o.dashed;
  if ('shadow' in o) ui.shadow.checked = o.shadow;
  if (o.heads) ui.arrowStyle.value = o.heads;
  if (o.style) ui.textStyle.value = o.style;
  if (o.zoom) ui.zoomLevel.value = String(o.zoom);
  if (o.type === 'counter') ui.counterStyle.value = o.cstyle || 'filled';
  ui.stickers.classList.toggle('show', tool === 'sticker' || o.type === 'sticker');
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('delete').addEventListener('click', deleteSelected);
$('clear').addEventListener('click', () => {
  checkpoint();
  objects = objects.filter((o) => o.type === 'crop');
  selectedId = null;
  render(); updateButtons();
});
$('reset-crop').addEventListener('click', () => {
  addObject({ type: 'crop', rect: { x: 0, y: 0, width: base.naturalWidth, height: base.naturalHeight } });
});
ui.bg.addEventListener('click', () => {
  background = !background;
  ui.bg.setAttribute('aria-pressed', String(background));
  render();
});
ui.bg1.addEventListener('input', () => render());
ui.bg2.addEventListener('input', () => render());
$('zoomFit').addEventListener('click', () => setZoom(null));
$('zoom100').addEventListener('click', () => setZoom(1));

// ================================================================ pointer input

function newObject(type, pt) {
  const style = { color, width: Number(ui.width.value), dashed: ui.dashed.checked, shadow: ui.shadow.checked };
  switch (type) {
    case 'pen': case 'highlight': return { type, ...style, dashed: false, points: [pt] };
    case 'arrow': case 'line': return { type, ...style, heads: ui.arrowStyle.value, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    case 'curve': return { type, ...style, heads: ui.arrowStyle.value, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, cx: pt.x, cy: pt.y };
    case 'rect': case 'ellipse': return { type, ...style, fill: ui.fill.checked, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    case 'magnify': return { type, ...style, dashed: false, zoom: Number(ui.zoomLevel.value), x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, bx: pt.x, by: pt.y };
    default: return { type, ...style, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
  }
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !base.naturalWidth) return;
  const pt = toImage(e);
  commitText();

  // Handles of the selected object work with any tool.
  const sel = selected();
  const h = sel && handleAt(sel, pt);
  if (h) {
    drag = { kind: 'handle', id: sel.id, handle: h.name, orig: JSON.parse(JSON.stringify(sel)), before: snapshot() };
    return;
  }

  if (tool === 'select') {
    const hit = pick(pt);
    selectedId = hit?.o.id || null;
    if (hit) {
      syncControls(hit.o);
      drag = { kind: 'move', id: hit.o.id, part: hit.part, last: pt, before: snapshot(), moved: false };
    }
    render(); updateButtons();
    return;
  }
  if (tool === 'text') { e.preventDefault(); return openText(pt); }
  if (tool === 'counter') {
    return addObject({ type: 'counter', color, width: Number(ui.width.value), shadow: ui.shadow.checked, cstyle: ui.counterStyle.value, x: pt.x, y: pt.y });
  }
  if (tool === 'sticker') {
    const s = 40 + Number(ui.width.value) * 6;
    return addObject({ type: 'sticker', emoji: sticker, color, width: 0, x1: pt.x - s / 2, y1: pt.y - s / 2, x2: pt.x + s / 2, y2: pt.y + s / 2 });
  }
  selectedId = null;
  drag = { kind: 'draw', obj: newObject(tool, pt) };
  render();
});

canvas.addEventListener('dblclick', (e) => {
  const hit = pick(toImage(e));
  if (hit?.o.type === 'text') editText(hit.o);
});

window.addEventListener('mousemove', (e) => {
  const pt = toImage(e);
  if (!drag) return hoverCursor(pt);
  if (drag.kind === 'draw') {
    const d = drag.obj;
    if (d.points) d.points.push(pt);
    else {
      d.x2 = pt.x; d.y2 = pt.y;
      if (e.shiftKey) constrain(d);
      if (d.type === 'curve') {
        // default bend: perpendicular offset of 25% of the length
        const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
        d.cx = mx - (d.y2 - d.y1) * 0.25; d.cy = my + (d.x2 - d.x1) * 0.25;
      }
      if (d.type === 'magnify') {
        const r = rectOf(d), side = Math.max(r.width, r.height, 10);
        const R = (side * d.zoom) / 2;
        d.bx = Math.min(base.naturalWidth - R, r.x + r.width + R + 12);
        d.by = Math.max(R, r.y - R * 0.3);
      }
    }
  } else if (drag.kind === 'move') {
    const o = objects.find((x) => x.id === drag.id);
    if (!o) return;
    translate(o, pt.x - drag.last.x, pt.y - drag.last.y, drag.part);
    drag.last = pt;
    drag.moved = true;
  } else if (drag.kind === 'handle') {
    const o = objects.find((x) => x.id === drag.id);
    if (o) applyHandle(o, drag.orig, drag.handle, pt, e.shiftKey);
  }
  render();
});

window.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'move' || d.kind === 'handle') {
    if (d.kind === 'handle' || d.moved) {
      undoStack.push(d.before);
      redoStack = [];
      updateButtons();
    }
    render();
    return;
  }
  const o = d.obj;
  if (o.type === 'crop') {
    const r = clampToImage(rectOf(o));
    if (r.width >= 4 && r.height >= 4) addObject({ type: 'crop', rect: r });
    else render();
    return;
  }
  const tiny = o.points ? o.points.length < 2 : Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 4;
  if (tiny) return render();
  if (BOX_TYPES.has(o.type)) Object.assign(o, (({ x, y, width, height }) => ({ x1: x, y1: y, x2: x + width, y2: y + height }))(rectOf(o)));
  addObject(o);
});

function hoverCursor(pt) {
  const sel = selected();
  if (sel && handleAt(sel, pt)) { canvas.className = 'resize'; return; }
  if (tool === 'select') canvas.className = pick(pt) ? 'move' : 'select';
  else canvas.className = '';
}

main.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(displayScale() * (e.deltaY > 0 ? 0.9 : 1.1));
}, { passive: false });

// ================================================================ text

function openText(pt, existing = null) {
  commitText();
  const size = existing ? existing.size : textSize();
  const scale = 1 / pxRatio();
  const wr = wrap.getBoundingClientRect();
  const at = toClient({ x: existing ? existing.x : pt.x, y: existing ? existing.y : pt.y });
  const ta = document.createElement('textarea');
  ta.id = 'text-input';
  ta.rows = 1;
  ta.value = existing ? existing.text : '';
  ta.style.left = `${at.x - wr.left}px`;
  ta.style.top = `${at.y - wr.top}px`;
  ta.style.fontSize = `${size * scale}px`;
  ta.style.color = existing ? existing.color : color;
  ta.setAttribute('aria-label', 'Texto de la anotación');
  const grow = () => {
    ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`;
    ta.style.width = 'auto'; ta.style.width = `${Math.max(40, ta.scrollWidth + 8)}px`;
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { textBox = null; ta.remove(); render(); }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
  });
  ta.addEventListener('blur', () => setTimeout(commitText, 0));
  wrap.appendChild(ta);
  textBox = {
    el: ta, existingId: existing?.id || null,
    obj: existing ? { ...existing } : { type: 'text', x: pt.x, y: pt.y, size, color, style: ui.textStyle.value, shadow: ui.shadow.checked },
  };
  if (existing) { existing.hidden = true; render(); }
  grow();
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}

function editText(o) {
  selectedId = o.id;
  openText(null, o);
}

function commitText() {
  if (!textBox) return;
  const { el, existingId, obj } = textBox;
  textBox = null;
  const text = el.value.replace(/\s+$/, '');
  el.remove();
  const existing = objects.find((o) => o.id === existingId);
  if (existing) {
    delete existing.hidden;
    if (!text) { selectedId = existingId; deleteSelected(); return; }
    if (text !== existing.text) { checkpoint(); existing.text = text; }
    render(); updateButtons();
    return;
  }
  if (text) addObject({ ...obj, text });
}

// ================================================================ export

function exportDataUrl() {
  commitText();
  const out = document.createElement('canvas');
  render(out, { forExport: true });
  return out.toDataURL('image/png');
}

function flash(text) {
  ui.status.textContent = text;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { ui.status.textContent = ''; }, 1800);
}

async function doExport(mode) {
  if (!captureId) return;
  if (mode === 'ocr') flash('Reconociendo texto…');
  const ok = await window.klip.editorExport(captureId, exportDataUrl(), mode);
  if (ok && mode === 'copy') flash('Copiada al portapapeles');
  if (ok && mode === 'saveAs') flash('Guardada');
  if (mode === 'ocr') flash(ok ? 'Texto copiado al portapapeles' : 'No se encontró texto');
}

$('ocr').addEventListener('click', () => doExport('ocr'));
$('pin').addEventListener('click', () => doExport('pin'));
$('copy').addEventListener('click', () => doExport('copy'));
$('save').addEventListener('click', () => doExport('saveAs'));
$('done').addEventListener('click', () => doExport('done'));

// ================================================================ keyboard

const TOOL_KEYS = {
  v: 'select', a: 'arrow', q: 'curve', l: 'line', r: 'rect', e: 'ellipse', p: 'pen', h: 'highlight', k: 'hlbox',
  t: 'text', n: 'counter', x: 'sticker', s: 'spotlight', z: 'magnify', g: 'blur', b: 'pixelate', c: 'crop',
};

window.addEventListener('keydown', (e) => {
  if (textBox) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); return redo(); }
    if (k === 'c') { e.preventDefault(); return doExport('copy'); }
    if (k === 's') { e.preventDefault(); return doExport('saveAs'); }
    if (k === 'd') { e.preventDefault(); return duplicateSelected(); }
    if (k === 'enter') { e.preventDefault(); return doExport('done'); }
    if (k === 't' && e.shiftKey) { e.preventDefault(); return doExport('ocr'); }
    if (k === '0') { e.preventDefault(); return setZoom(null); }
    if (k === '1') { e.preventDefault(); return setZoom(1); }
    if (k === '=' || k === '+') { e.preventDefault(); return setZoom(displayScale() * 1.2); }
    if (k === '-') { e.preventDefault(); return setZoom(displayScale() / 1.2); }
    return;
  }
  if (k === 'escape') {
    if (drag?.kind === 'draw') { drag = null; return render(); }
    selectedId = null; render(); updateButtons();
    return;
  }
  if ((k === 'delete' || k === 'backspace') && selected()) { e.preventDefault(); return deleteSelected(); }
  if (k === 'enter' && selected()?.type === 'text') { e.preventDefault(); return editText(selected()); }
  if (k === ']') return reorderSelected(true);
  if (k === '[') return reorderSelected(false);
  if (k.startsWith('arrow') && selected()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
    const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
    checkpoint();
    translate(selected(), dx, dy);
    render(); updateButtons();
    return;
  }
  if (!e.altKey && TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

setTool('arrow');
updateButtons();
window.klip.ready('editor');
