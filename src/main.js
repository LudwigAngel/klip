'use strict';
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, desktopCapturer, screen, session,
  ipcMain, clipboard, ClipboardItem, nativeImage, dialog, shell, Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createIcon } = require('./icon');
const settingsStore = require('./settings');
const ocr = require('./ocr');
const windowsApi = require('./windows');

const RENDERER = path.join(__dirname, 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const QUICK_W = 300;
const QUICK_H = 210;
const QUICK_MARGIN = 16;
const SMOKE = Boolean(process.env.KLIP_SMOKE);

let S = null; // current settings (loaded at startup)
/** id -> { id, kind: 'image'|'video', file, image } */
const captures = new Map();
const quickWindows = [];
let tray = null;
let overlays = [];
let overlayRequest = null; // { mode, onDone(result) }
let busy = false;
let lastArea = null; // { displayId, rect } for "capture previous area"
let recording = null; // active recording session
let settingsWin = null;
let hotkeyErrors = [];
const readyPages = new Set(); // renderer pages that booted (smoke test)

// ================================================================ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function webPrefs(extra = {}) {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra };
}

function notify(title, body) {
  if (!S.general.notifications || SMOKE || !Notification.isSupported()) return;
  new Notification({ title, body, icon: createIcon(64) }).show();
}

function reportError(title, err) {
  console.error(title, err);
  if (Notification.isSupported() && !SMOKE) new Notification({ title: 'Klip', body: `${title}: ${err.message}` }).show();
}

async function copyImage(image) {
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
    return true;
  } catch (err) {
    reportError('No se pudo copiar al portapapeles', err);
    return false;
  }
}

async function copyText(text) {
  try {
    await clipboard.writeText(text);
    return true;
  } catch (err) {
    reportError('No se pudo copiar el texto', err);
    return false;
  }
}

function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// ================================================================ screen grabbing

/** Screenshot of every display as { display, image } at native resolution. */
async function grabDisplays() {
  const displays = screen.getAllDisplays();
  const width = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const height = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  return displays.map((display, i) => {
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[i];
    return { display, image: src ? src.thumbnail : nativeImage.createEmpty(), sourceId: src?.id };
  });
}

/** Hide Klip's floating windows so they never appear in a capture. */
async function withOwnWindowsHidden(fn) {
  const visible = BrowserWindow.getAllWindows().filter((w) => w.isVisible() && w.__klipHideOnCapture);
  visible.forEach((w) => w.hide());
  if (visible.length) await sleep(180);
  try {
    return await fn();
  } finally {
    visible.forEach((w) => !w.isDestroyed() && w.showInactive());
  }
}

/** rect is in DIP, relative to the display's top-left corner. */
function cropToRect(image, display, rect) {
  const size = image.getSize();
  const sx = size.width / display.bounds.width;
  const sy = size.height / display.bounds.height;
  return image.crop({
    x: Math.round(rect.x * sx), y: Math.round(rect.y * sy),
    width: Math.max(1, Math.round(rect.width * sx)), height: Math.max(1, Math.round(rect.height * sy)),
  });
}

function clampRect(rect, display) {
  const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
  return {
    x, y,
    width: Math.min(display.bounds.width - x, Math.round(rect.width)),
    height: Math.min(display.bounds.height - y, Math.round(rect.height)),
  };
}

// ================================================================ overlay (selection UI)

const OVERLAY_HINTS = {
  capture: 'Arrastra para seleccionar · Clic: pantalla completa · Espacio: elegir ventana · Esc: cancelar',
  window: 'Clic en una ventana para capturarla · Espacio: volver a área · Esc: cancelar',
  ocr: 'Selecciona el área con texto · Esc: cancelar',
  record: 'Selecciona el área a grabar (MP4) · Clic: pantalla completa · Espacio: ventana · Esc: cancelar',
  gif: 'Selecciona el área a grabar como GIF · Clic: pantalla completa · Esc: cancelar',
  recordWindow: 'Clic en la ventana a grabar · Esc: cancelar',
};

/**
 * Open the frozen-screen selection overlay on every display.
 * mode: capture | window | ocr | record | gif | recordWindow
 * Resolves with { display, image, rect } (rect null = whole display),
 * { window } for window modes, or null when cancelled.
 */
async function selectOnScreen(mode) {
  if (busy || overlays.length || (recording && mode !== 'recordWindow')) return null;
  busy = true;
  let shots;
  try {
    shots = await withOwnWindowsHidden(grabDisplays);
  } catch (err) {
    busy = false;
    reportError('No se pudo capturar la pantalla', err);
    return null;
  }
  const windowMode = mode === 'window' || mode === 'recordWindow';
  const windowsPromise = windowMode ? windowsApi.listWindows().catch(() => []) : null;
  const focusDisplay = cursorDisplay();
  return new Promise((resolve) => {
    overlayRequest = { mode, resolve, windows: null };
    overlays = shots.map(({ display, image }) => {
      const win = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
        frame: false, show: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true,
        hasShadow: false, backgroundColor: '#000000', webPreferences: webPrefs(),
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds(display.bounds); // Windows may clamp the initial size
      win.__klip = { display, image };
      win.loadFile(path.join(RENDERER, 'overlay.html'));
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('overlay:init', {
          mode: windowMode ? 'window' : mode,
          lockWindowMode: mode === 'recordWindow',
          allowWindowToggle: mode === 'capture' || mode === 'record',
          hint: OVERLAY_HINTS[mode],
          dataUrl: 'data:image/jpeg;base64,' + image.toJPEG(90).toString('base64'),
          width: display.bounds.width, height: display.bounds.height,
          magnifier: S.capture.magnifier, crosshair: S.capture.crosshair,
        });
      });
      win.once('ready-to-show', () => {
        win.show();
        if (display.id === focusDisplay.id) win.focus();
      });
      return win;
    });
    if (windowsPromise) windowsPromise.then(sendWindowsToOverlays);
  });
}

function sendWindowsToOverlays(list) {
  if (!overlayRequest) return;
  overlayRequest.windows = list;
  overlays.forEach((w) => {
    if (w.isDestroyed()) return;
    const b = w.__klip.display.bounds;
    // rects relative to this display, so the overlay can draw them directly
    const local = list.map((win) => ({
      id: win.id, name: win.name,
      rect: { x: win.rect.x - b.x, y: win.rect.y - b.y, width: win.rect.width, height: win.rect.height },
    }));
    w.webContents.send('overlay:windows', local);
  });
}

function finishOverlay(result) {
  const req = overlayRequest;
  overlayRequest = null;
  overlays.forEach((w) => !w.isDestroyed() && w.destroy());
  overlays = [];
  busy = false;
  req?.resolve(result);
}

ipcMain.on('overlay:done', (event, rect) => {
  const win = overlays.find((w) => w.webContents === event.sender);
  if (!win) return;
  const { display, image } = win.__klip;
  const r = rect && rect.width >= 2 && rect.height >= 2 ? clampRect(rect, display) : null;
  finishOverlay({ display, image, rect: r });
});

ipcMain.on('overlay:pickWindow', (_event, id) => {
  const win = overlayRequest?.windows?.find((w) => w.id === id);
  if (win) finishOverlay({ window: win });
});

ipcMain.on('overlay:wantWindows', () => {
  if (!overlayRequest) return;
  if (overlayRequest.windows) return sendWindowsToOverlays(overlayRequest.windows);
  windowsApi.listWindows().catch(() => []).then(sendWindowsToOverlays);
});

ipcMain.on('overlay:cancel', () => finishOverlay(null));

// ================================================================ screenshot actions

async function captureArea() {
  const sel = await selectOnScreen('capture');
  if (!sel) return;
  if (sel.window) return finishWindowCapture(sel.window);
  if (sel.rect) lastArea = { displayId: sel.display.id, rect: sel.rect };
  finishCapture(sel.rect ? cropToRect(sel.image, sel.display, sel.rect) : sel.image);
}

async function captureWindow() {
  const sel = await selectOnScreen('window');
  if (sel?.window) await finishWindowCapture(sel.window);
}

async function finishWindowCapture(win) {
  try {
    let image = await windowsApi.windowImage(win);
    if (!image) {
      // Fallback: crop the window's rectangle out of a fresh screenshot.
      const shots = await withOwnWindowsHidden(grabDisplays);
      const center = { x: win.rect.x + win.rect.width / 2, y: win.rect.y + win.rect.height / 2 };
      const d = screen.getDisplayNearestPoint(center);
      const shot = shots.find((s) => s.display.id === d.id);
      image = cropToRect(shot.image, d, clampRect({ ...win.rect, x: win.rect.x - d.bounds.x, y: win.rect.y - d.bounds.y }, d));
    }
    finishCapture(S.capture.windowShadow ? windowsApi.withShadow(image) : image, { forcePng: S.capture.windowShadow });
  } catch (err) {
    reportError('No se pudo capturar la ventana', err);
  }
}

async function captureFullscreen() {
  if (busy || overlays.length) return;
  busy = true;
  try {
    const shots = await withOwnWindowsHidden(grabDisplays);
    const target = cursorDisplay();
    const shot = shots.find((s) => s.display.id === target.id) || shots[0];
    await finishCapture(shot.image);
  } catch (err) {
    reportError('No se pudo capturar la pantalla', err);
  } finally {
    busy = false;
  }
}

async function capturePreviousArea() {
  if (!lastArea) return captureArea();
  if (busy || overlays.length) return;
  busy = true;
  try {
    const shots = await withOwnWindowsHidden(grabDisplays);
    const shot = shots.find((s) => s.display.id === lastArea.displayId);
    busy = false;
    if (!shot) return captureArea();
    finishCapture(cropToRect(shot.image, shot.display, lastArea.rect));
  } catch (err) {
    busy = false;
    reportError('No se pudo capturar el área anterior', err);
  }
}

function timerCapture(seconds = S.capture.timerSeconds) {
  notify('Klip', `Captura de pantalla completa en ${seconds} s`);
  setTimeout(captureFullscreen, seconds * 1000);
}

async function finishCapture(image, { forcePng = false } = {}) {
  if (image.isEmpty()) return reportError('La captura salió vacía', new Error('imagen vacía'));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jpg = S.capture.format === 'jpg' && !forcePng;
  const file = path.join(ensureDir(S.general.screenshotDir), `Klip ${timestamp()}.${jpg ? 'jpg' : 'png'}`);
  fs.writeFileSync(file, jpg ? image.toJPEG(S.capture.jpgQuality) : image.toPNG());
  captures.set(id, { id, kind: 'image', file, image });
  if (S.general.autoCopy) await copyImage(image);
  switch (S.general.afterCapture) {
    case 'editor': openEditor(id); break;
    case 'pin': openPin(id); break;
    case 'none': notify('Captura guardada', path.basename(file)); break;
    default: showQuickWindow(id);
  }
  return id;
}

function updateCapture(id, image) {
  const cap = captures.get(id);
  if (!cap) return;
  cap.image = image;
  fs.writeFileSync(cap.file, /\.jpe?g$/i.test(cap.file) ? image.toJPEG(S.capture.jpgQuality) : image.toPNG());
  quickWindows.forEach((w) => {
    if (!w.isDestroyed() && w.__klipId === id) w.webContents.send('quick:init', quickPayload(cap));
  });
}

async function saveAs(id, image) {
  const cap = captures.get(id);
  const isVideo = cap?.kind === 'video';
  const ext = isVideo ? path.extname(cap.file).slice(1) : 'png';
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: isVideo ? 'Guardar grabación' : 'Guardar captura',
    defaultPath: cap ? cap.file : path.join(S.general.screenshotDir, `Klip ${timestamp()}.png`),
    filters: isVideo
      ? [{ name: ext.toUpperCase(), extensions: [ext] }]
      : [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }],
  });
  if (canceled || !filePath) return false;
  if (isVideo) {
    fs.copyFileSync(cap.file, filePath);
  } else {
    const img = image || cap.image;
    fs.writeFileSync(filePath, /\.jpe?g$/i.test(filePath) ? img.toJPEG(S.capture.jpgQuality) : img.toPNG());
  }
  return true;
}

// ================================================================ OCR

async function ocrArea() {
  const sel = await selectOnScreen('ocr');
  if (!sel) return;
  const image = sel.rect ? cropToRect(sel.image, sel.display, sel.rect) : sel.image;
  await runOcr(image);
}

/** Recognise text, copy it, and show it in the result window. */
async function runOcr(image) {
  try {
    const result = await ocr.recognize(image, { language: S.ocr.language, keepLineBreaks: S.ocr.keepLineBreaks });
    if (!result.text.trim()) {
      notify('Klip — OCR', 'No se encontró texto en la selección.');
      return result;
    }
    await copyText(result.text);
    openOcrResult(result);
    return result;
  } catch (err) {
    reportError('Falló el reconocimiento de texto', err);
    return null;
  }
}

function openOcrResult(result) {
  const area = cursorDisplay().workArea;
  const win = new BrowserWindow({
    width: 460, height: 340, x: area.x + area.width - 480, y: area.y + area.height - 360,
    frame: false, resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#1e1e24',
    webPreferences: webPrefs(),
  });
  win.__klipHideOnCapture = true;
  win.loadFile(path.join(RENDERER, 'ocr.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('ocr:init', result));
  win.once('ready-to-show', () => win.show());
}

ipcMain.handle('ocr:copy', (_e, text) => copyText(String(text ?? '')));

// ================================================================ quick access

function quickPayload(cap) {
  if (cap.kind === 'video') {
    return { id: cap.id, kind: 'video', dataUrl: cap.poster || '', label: cap.label, timeoutMs: S.general.quickTimeoutSec * 1000 };
  }
  const size = cap.image.getSize();
  const thumb = cap.image.resize({ width: Math.min(size.width, QUICK_W * 2) });
  return {
    id: cap.id, kind: 'image', dataUrl: thumb.toDataURL(), label: `${size.width} × ${size.height}`,
    timeoutMs: S.general.quickTimeoutSec * 1000,
  };
}

function layoutQuickWindows() {
  const area = screen.getPrimaryDisplay().workArea;
  const x = S.general.quickPosition === 'right' ? area.x + area.width - QUICK_W - QUICK_MARGIN : area.x + QUICK_MARGIN;
  let y = area.y + area.height - QUICK_MARGIN;
  quickWindows.forEach((w) => {
    y -= QUICK_H;
    if (!w.isDestroyed()) w.setBounds({ x, y, width: QUICK_W, height: QUICK_H });
    y -= 10;
  });
}

function showQuickWindow(id) {
  const cap = captures.get(id);
  const win = new BrowserWindow({
    width: QUICK_W, height: QUICK_H, frame: false, show: false, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true,
    hasShadow: false, webPreferences: webPrefs(),
  });
  win.__klipId = id;
  win.__klipHideOnCapture = true;
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(RENDERER, 'quick.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('quick:init', {
    ...quickPayload(cap), side: S.general.quickPosition,
  }));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    const i = quickWindows.indexOf(win);
    if (i >= 0) quickWindows.splice(i, 1);
    layoutQuickWindows();
  });
  quickWindows.push(win);
  while (quickWindows.length > 5) quickWindows[0].close();
  layoutQuickWindows();
}

ipcMain.handle('quick:action', async (event, { id, action }) => {
  const cap = captures.get(id);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!cap) { win?.close(); return false; }
  switch (action) {
    case 'copy':
      return cap.kind === 'image' ? copyImage(cap.image) : false;
    case 'save':
      return saveAs(id);
    case 'edit':
      if (cap.kind !== 'image') return false;
      openEditor(id); win?.close();
      return true;
    case 'pin':
      if (cap.kind !== 'image') return false;
      openPin(id); win?.close();
      return true;
    case 'ocr':
      return cap.kind === 'image' ? Boolean(await runOcr(cap.image)) : false;
    case 'open':
      shell.openPath(cap.file);
      return true;
    case 'reveal':
      shell.showItemInFolder(cap.file);
      return true;
    case 'delete':
      fs.rmSync(cap.file, { force: true });
      captures.delete(id);
      win?.close();
      return true;
    case 'close':
      win?.close();
      return true;
    default:
      return false;
  }
});

ipcMain.on('quick:drag', (event, id) => {
  const cap = captures.get(id);
  if (!cap || !fs.existsSync(cap.file)) return;
  const icon = cap.kind === 'image' ? cap.image.resize({ width: 96 }) : createIcon(64);
  event.sender.startDrag({ file: cap.file, icon });
});

// ================================================================ pin

function openPin(id) {
  const cap = captures.get(id);
  const display = cursorDisplay();
  const size = cap.image.getSize();
  let w = size.width / display.scaleFactor;
  let h = size.height / display.scaleFactor;
  const max = Math.min(display.workArea.width * 0.8 / w, display.workArea.height * 0.8 / h, 1);
  w = Math.round(w * max); h = Math.round(h * max);
  const win = new BrowserWindow({
    width: w, height: h,
    x: Math.round(display.workArea.x + (display.workArea.width - w) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - h) / 2),
    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true, show: false, transparent: true,
    webPreferences: webPrefs(),
  });
  win.__klipId = id;
  win.__klipAspect = w / h;
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(RENDERER, 'pin.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('pin:init', { id, dataUrl: cap.image.toDataURL() }));
  win.once('ready-to-show', () => win.show());
}

ipcMain.on('pin:move', (event, { x, y }) => {
  BrowserWindow.fromWebContents(event.sender)?.setPosition(Math.round(x), Math.round(y));
});

ipcMain.on('pin:zoom', (event, factor) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !win.__klipAspect) return;
  const b = win.getBounds();
  const width = Math.max(60, Math.min(4000, Math.round(b.width * factor)));
  const height = Math.round(width / win.__klipAspect);
  win.setBounds({ x: b.x + Math.round((b.width - width) / 2), y: b.y + Math.round((b.height - height) / 2), width, height });
});

ipcMain.on('pin:opacity', (event, delta) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setOpacity(Math.max(0.2, Math.min(1, win.getOpacity() + delta)));
});

ipcMain.on('pin:menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const id = win.__klipId;
  const cap = captures.get(id);
  if (!cap) return;
  Menu.buildFromTemplate([
    { label: 'Copiar', click: () => copyImage(cap.image) },
    { label: 'Guardar como…', click: () => saveAs(id) },
    { label: 'Extraer texto (OCR)', click: () => runOcr(cap.image) },
    { label: 'Editar', click: () => { openEditor(id); win.close(); } },
    { type: 'separator' },
    { label: 'Cerrar', click: () => win.close() },
  ]).popup({ window: win });
});

ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.on('window:move', (event, { x, y }) => {
  BrowserWindow.fromWebContents(event.sender)?.setPosition(Math.round(x), Math.round(y));
});
ipcMain.on('renderer:ready', (_e, page) => readyPages.add(String(page)));

// ================================================================ editor

function openEditor(id) {
  const cap = captures.get(id);
  if (!cap || cap.kind !== 'image') return;
  const area = cursorDisplay().workArea;
  const win = new BrowserWindow({
    width: Math.min(1280, area.width - 80), height: Math.min(860, area.height - 60),
    minWidth: 760, minHeight: 480, title: 'Klip — Editor', icon: createIcon(64),
    backgroundColor: '#1e1e24', show: false, autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  win.setMenu(null);
  win.loadFile(path.join(RENDERER, 'editor.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('editor:init', { id, dataUrl: cap.image.toDataURL() }));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
}

ipcMain.handle('editor:export', async (event, { id, dataUrl, mode }) => {
  if (!captures.has(id) || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) return false;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (mode === 'copy') return copyImage(image);
  if (mode === 'saveAs') return saveAs(id, image);
  if (mode === 'ocr') return Boolean(await runOcr(image));
  if (mode === 'pin') { updateCapture(id, image); openPin(id); return true; }
  if (mode === 'done') {
    updateCapture(id, image);
    await copyImage(image);
    BrowserWindow.fromWebContents(event.sender)?.close();
    return true;
  }
  return false;
});

function openFromFile() {
  dialog.showOpenDialog({
    title: 'Abrir imagen en el editor', properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }],
  }).then(({ canceled, filePaths }) => {
    if (canceled || !filePaths[0]) return;
    const image = nativeImage.createFromPath(filePaths[0]);
    if (image.isEmpty()) return reportError('No se pudo abrir la imagen', new Error(filePaths[0]));
    const id = `${Date.now()}-file`;
    captures.set(id, { id, kind: 'image', file: path.join(ensureDir(S.general.screenshotDir), `Klip ${timestamp()}.png`), image });
    openEditor(id);
  });
}

function openLastInEditor() {
  const last = [...captures.values()].reverse().find((c) => c.kind === 'image');
  if (last) openEditor(last.id);
  else notify('Klip', 'Todavía no hay capturas en esta sesión.');
}

// ================================================================ recording

/** Source handed to getDisplayMedia() by the recorder window. */
let pendingDisplaySource = null;

function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const pending = pendingDisplaySource;
    pendingDisplaySource = null;
    if (!pending) return callback(null);
    const streams = { video: pending.source };
    if (pending.systemAudio) streams.audio = 'loopback';
    callback(streams);
  });
}

function recordingDims(width, height) {
  const maxH = S.recording.maxHeight;
  let w = width, h = height;
  if (maxH && h > maxH) { w = (w * maxH) / h; h = maxH; }
  // H.264 needs even dimensions
  return { width: Math.max(2, Math.floor(w / 2) * 2), height: Math.max(2, Math.floor(h / 2) * 2) };
}

/** kind: area | fullscreen | window ; gif: boolean */
async function toggleRecording(kind, gif = false) {
  if (recording) return stopRecording();
  let target = null;
  if (kind === 'fullscreen') {
    target = { display: cursorDisplay(), rect: null };
  } else if (kind === 'window') {
    const sel = await selectOnScreen('recordWindow');
    if (!sel?.window) return;
    target = { window: sel.window };
  } else {
    const sel = await selectOnScreen(gif ? 'gif' : 'record');
    if (!sel) return;
    target = sel.window ? { window: sel.window } : { display: sel.display, rect: sel.rect };
  }
  try {
    await beginRecording(target, gif);
  } catch (err) {
    cleanupRecording();
    reportError('No se pudo iniciar la grabación', err);
  }
}

async function beginRecording(target, gif) {
  let source, frameRect, cropDip = null, displayBounds = null, outSize;
  if (target.window) {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    source = sources.find((s) => s.id === target.window.id);
    if (!source) throw new Error('La ventana ya no existe');
    frameRect = target.window.rect;
    outSize = recordingDims(target.window.physical.width, target.window.physical.height);
  } else {
    const { display, rect } = target;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    displayBounds = { width: display.bounds.width, height: display.bounds.height };
    cropDip = rect;
    const r = rect || { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height };
    frameRect = { x: display.bounds.x + r.x, y: display.bounds.y + r.y, width: r.width, height: r.height };
    outSize = recordingDims(Math.round(r.width * display.scaleFactor), Math.round(r.height * display.scaleFactor));
  }
  if (gif) {
    const scale = Math.min(1, S.recording.gifMaxWidth / outSize.width);
    outSize = { width: Math.max(2, Math.round(outSize.width * scale)), height: Math.max(2, Math.round(outSize.height * scale)) };
  }

  recording = { gif, startedAt: 0, pausedMs: 0, pausedAt: 0, paused: false, frameRect, windows: [] };

  // Recorder: hidden window that owns the MediaStream and the encoder.
  const rec = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true,
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  recording.recorder = rec;
  recording.windows.push(rec);
  await rec.loadFile(path.join(RENDERER, 'recorder.html'));

  // Frame around the recorded area + countdown (excluded from the capture).
  const fullscreen = !target.window && !cropDip;
  if (!fullscreen) recording.windows.push(openFrameWindow(frameRect));
  const bar = openControlBar(frameRect, fullscreen);
  recording.bar = bar;
  recording.windows.push(bar);
  if (S.recording.webcam) recording.windows.push(openWebcamWindow(frameRect));

  tray?.setImage(createIcon(32, { recording: true }));
  tray?.setToolTip('Klip — grabando (clic para detener)');

  const countdown = SMOKE ? 0 : S.recording.countdown;
  for (let n = countdown; n > 0; n--) {
    if (!recording) return;
    recording.windows.forEach((w) => !w.isDestroyed() && w.webContents.send('rec:countdown', n));
    await sleep(1000);
  }
  if (!recording) return;
  recording.windows.forEach((w) => !w.isDestroyed() && w.webContents.send('rec:countdown', 0));

  pendingDisplaySource = { source, systemAudio: S.recording.systemAudio && !gif };
  rec.webContents.send('recorder:start', {
    gif,
    fps: gif ? S.recording.gifFps : S.recording.fps,
    crop: cropDip, displayBounds,
    width: outSize.width, height: outSize.height,
    bitrate: S.recording.videoBitrateMbps * 1_000_000,
    microphone: S.recording.microphone && !gif, microphoneId: S.recording.microphoneId,
    maxSeconds: gif ? S.recording.gifMaxSeconds : 0,
  });
}

function openFrameWindow(r) {
  const b = 4; // border thickness, drawn just outside the recorded area
  const win = new BrowserWindow({
    x: Math.round(r.x - b), y: Math.round(r.y - b), width: Math.round(r.width + b * 2), height: Math.round(r.height + b * 2),
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false, enableLargerThanScreen: true, webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true); // never appears in the recording
  win.loadFile(path.join(RENDERER, 'frame.html'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function openControlBar(r, fullscreen) {
  const W = 420, H = 46;
  const display = screen.getDisplayNearestPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const wa = display.workArea;
  let x = Math.round(r.x + r.width / 2 - W / 2);
  let y = fullscreen ? wa.y + wa.height - H - 20 : Math.round(r.y + r.height + 12);
  if (!fullscreen && y + H > wa.y + wa.height) y = Math.round(r.y - H - 12);
  if (y < wa.y) y = wa.y + 12;
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - W - 8);
  const win = new BrowserWindow({
    x, y, width: W, height: H, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false, minimizable: false, maximizable: false,
    fullscreenable: false, webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  win.loadFile(path.join(RENDERER, 'bar.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('bar:init', {
    gif: recording?.gif, microphone: S.recording.microphone, systemAudio: S.recording.systemAudio,
    hotkeyStop: accelLabel(S.hotkeys[recording?.gif ? 'recordGif' : 'recordArea']),
  }));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function openWebcamWindow(r) {
  const size = 180;
  const display = screen.getDisplayNearestPoint({ x: r.x, y: r.y });
  const x = Math.round(Math.min(r.x + r.width - size - 16, display.workArea.x + display.workArea.width - size - 16));
  const y = Math.round(Math.min(r.y + r.height - size - 16, display.workArea.y + display.workArea.height - size - 16));
  const win = new BrowserWindow({
    x, y, width: size, height: size, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false, webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(RENDERER, 'webcam.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('webcam:init', { deviceId: S.recording.webcamId }));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function broadcastRecState() {
  if (!recording) return;
  const state = {
    paused: recording.paused, startedAt: recording.startedAt, pausedMs: recording.pausedMs,
    pausedAt: recording.pausedAt,
  };
  recording.windows.forEach((w) => !w.isDestroyed() && w.webContents.send('rec:state', state));
}

function stopRecording() {
  if (!recording) return;
  if (!recording.startedAt) return cancelRecording(); // still counting down
  recording.recorder.webContents.send('recorder:stop');
}

function cancelRecording() {
  if (!recording) return;
  const rec = recording.recorder;
  if (recording.startedAt && !rec.isDestroyed()) rec.webContents.send('recorder:cancel');
  else cleanupRecording();
}

function togglePause() {
  if (!recording?.startedAt) return;
  recording.recorder.webContents.send(recording.paused ? 'recorder:resume' : 'recorder:pause');
}

function cleanupRecording() {
  pendingDisplaySource = null;
  if (recording) recording.windows.forEach((w) => !w.isDestroyed() && w.destroy());
  recording = null;
  tray?.setImage(createIcon(32));
  tray?.setToolTip('Klip — capturas de pantalla');
}

ipcMain.on('recorder:started', () => {
  if (!recording) return;
  recording.startedAt = Date.now();
  broadcastRecState();
});

ipcMain.on('recorder:paused', (_e, paused) => {
  if (!recording) return;
  if (paused) recording.pausedAt = Date.now();
  else { recording.pausedMs += Date.now() - recording.pausedAt; recording.pausedAt = 0; }
  recording.paused = paused;
  broadcastRecState();
});

ipcMain.on('recorder:error', (_e, message) => {
  cleanupRecording();
  reportError('La grabación falló', new Error(message));
});

ipcMain.on('recorder:cancelled', cleanupRecording);

ipcMain.handle('recorder:finished', async (_e, { bytes, ext, poster, durationMs }) => {
  const gif = recording?.gif;
  cleanupRecording();
  const id = `${Date.now()}-rec`;
  const file = path.join(ensureDir(S.general.recordingDir), `Klip ${timestamp()}.${ext}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  const secs = Math.round(durationMs / 100) / 10;
  const bytesOnDisk = fs.statSync(file).size;
  const size = bytesOnDisk < 1048576 ? `${Math.max(1, Math.round(bytesOnDisk / 1024))} KB` : `${(bytesOnDisk / 1048576).toFixed(1)} MB`;
  captures.set(id, { id, kind: 'video', file, poster, label: `${gif ? 'GIF' : ext.toUpperCase()} · ${secs} s · ${size}` });
  if (!SMOKE) showQuickWindow(id);
  return file;
});

ipcMain.on('bar:action', (_e, action) => {
  if (action === 'stop') stopRecording();
  else if (action === 'pause') togglePause();
  else if (action === 'cancel') cancelRecording();
});

// ================================================================ settings window

function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show(); settingsWin.focus();
    if (tab) settingsWin.webContents.send('settings:tab', tab);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 860, height: 680, minWidth: 720, minHeight: 520, title: 'Klip — Configuración',
    icon: createIcon(64), backgroundColor: '#1e1e24', show: false, autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'), tab ? { hash: tab } : undefined);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  // While the window is focused, global hotkeys are suspended so recording a
  // new shortcut does not trigger the old action.
  settingsWin.on('focus', () => globalShortcut.unregisterAll());
  settingsWin.on('blur', registerHotkeys);
  settingsWin.on('closed', () => { settingsWin = null; registerHotkeys(); });
}

ipcMain.handle('settings:get', () => ({
  settings: S,
  defaults: settingsStore.defaults(),
  actions: settingsStore.HOTKEY_ACTIONS,
  hotkeyErrors,
  openAtLogin: app.getLoginItemSettings().openAtLogin,
  version: app.getVersion(),
}));

ipcMain.handle('settings:save', (_e, { settings: next, openAtLogin }) => {
  S = settingsStore.save(next);
  if (typeof openAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin });
  hotkeyErrors = testHotkeys();
  layoutQuickWindows();
  return { settings: S, hotkeyErrors };
});

ipcMain.handle('settings:pickFolder', async (_e, current) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin, {
    title: 'Elegir carpeta', defaultPath: current || undefined, properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('settings:ocrLanguages', () => ocr.languages().catch(() => []));
ipcMain.handle('settings:openFolder', (_e, dir) => (dir ? shell.openPath(ensureDir(dir)) : ''));

// ================================================================ hotkeys & tray

const ACTION_HANDLERS = {
  area: captureArea,
  fullscreen: captureFullscreen,
  window: captureWindow,
  previousArea: capturePreviousArea,
  timerFullscreen: () => timerCapture(),
  recordArea: () => toggleRecording('area'),
  recordFullscreen: () => toggleRecording('fullscreen'),
  recordWindow: () => toggleRecording('window'),
  recordGif: () => toggleRecording('area', true),
  recordPause: togglePause,
  ocr: ocrArea,
  openLast: openLastInEditor,
  openFolder: () => shell.openPath(ensureDir(S.general.screenshotDir)),
  settings: () => openSettings(),
};

function accelLabel(accel) {
  return accel ? accel.replace('CommandOrControl', 'Ctrl') : '';
}

/** Register every configured hotkey; returns the ids that could not be registered. */
function registerAllHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  const seen = new Set();
  for (const { id } of settingsStore.HOTKEY_ACTIONS) {
    const accel = S.hotkeys[id];
    if (!accel) continue;
    let ok = false;
    try {
      ok = !seen.has(accel) && globalShortcut.register(accel, () => ACTION_HANDLERS[id]());
    } catch {
      ok = false; // malformed accelerator
    }
    if (ok) seen.add(accel);
    else failed.push(id);
  }
  return failed;
}

const settingsFocused = () => Boolean(settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused());

/** Normal registration; skipped while the settings window is capturing keys. */
function registerHotkeys() {
  if (settingsFocused()) return hotkeyErrors;
  return (hotkeyErrors = registerAllHotkeys());
}

/** Check which hotkeys are free, then re-suspend them if settings has focus. */
function testHotkeys() {
  const failed = registerAllHotkeys();
  if (settingsFocused()) globalShortcut.unregisterAll();
  return failed;
}

function buildTrayMenu() {
  const hk = (id) => (S.hotkeys[id] ? `\t${accelLabel(S.hotkeys[id])}` : '');
  if (recording) {
    return Menu.buildFromTemplate([
      { label: 'Detener grabación', click: stopRecording },
      { label: recording.paused ? 'Reanudar' : 'Pausar', click: togglePause, enabled: Boolean(recording.startedAt) },
      { label: 'Cancelar grabación', click: cancelRecording },
    ]);
  }
  return Menu.buildFromTemplate([
    { label: `Capturar área${hk('area')}`, click: captureArea },
    { label: `Capturar ventana${hk('window')}`, click: captureWindow },
    { label: `Capturar pantalla completa${hk('fullscreen')}`, click: captureFullscreen },
    { label: `Capturar área anterior${hk('previousArea')}`, click: capturePreviousArea },
    {
      label: 'Temporizador',
      submenu: [3, 5, 10].map((s) => ({ label: `Pantalla completa en ${s} s`, click: () => timerCapture(s) })),
    },
    { type: 'separator' },
    { label: `Grabar área (MP4)${hk('recordArea')}`, click: () => toggleRecording('area') },
    { label: `Grabar ventana (MP4)${hk('recordWindow')}`, click: () => toggleRecording('window') },
    { label: `Grabar pantalla completa (MP4)${hk('recordFullscreen')}`, click: () => toggleRecording('fullscreen') },
    { label: `Grabar área como GIF${hk('recordGif')}`, click: () => toggleRecording('area', true) },
    { type: 'separator' },
    { label: `Extraer texto (OCR)${hk('ocr')}`, click: ocrArea },
    { type: 'separator' },
    { label: 'Abrir imagen en el editor…', click: openFromFile },
    { label: `Abrir última captura en el editor${hk('openLast')}`, click: openLastInEditor, enabled: captures.size > 0 },
    { label: 'Abrir carpeta de capturas', click: () => shell.openPath(ensureDir(S.general.screenshotDir)) },
    { label: 'Abrir carpeta de grabaciones', click: () => shell.openPath(ensureDir(S.general.recordingDir)) },
    { type: 'separator' },
    { label: `Configuración…${hk('settings')}`, click: () => openSettings() },
    { label: 'Atajos de teclado…', click: () => openSettings('hotkeys') },
    { type: 'separator' },
    { label: 'Salir de Klip', click: () => app.quit() },
  ]);
}

// ================================================================ smoke test

async function smokeTest() {
  const report = {};
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (ev, ...rest) => {
      const level = ev?.level ?? rest[0];
      if (level === 'error' || level === 3 || level === 'warning' || level === 2) {
        console.log('RENDERER', level, ev?.message ?? rest[1]);
      }
    });
    wc.on('preload-error', (_ev, p, err) => console.log('PRELOAD_ERROR', p, err));
  });
  const step = async (name, fn) => {
    try { report[name] = await fn(); } catch (err) { report[name] = `ERROR ${err.message}`; }
  };
  await step('screenshot', async () => {
    const shots = await grabDisplays();
    const id = await finishCapture(shots[0].image);
    const cap = captures.get(id);
    return `${JSON.stringify(cap.image.getSize())} clipboard=${await clipboard.has('image/png')}`;
  });
  await step('ocrLanguages', async () => (await ocr.languages()).map((l) => l.tag).join(','));
  await step('ocrScreenshot', async () => {
    const cap = [...captures.values()][0];
    const r = await ocr.recognize(cap.image, { language: S.ocr.language });
    return `${r.lines} líneas (${r.language}) muestra="${r.text.slice(0, 60).replace(/\s+/g, ' ')}"`;
  });
  await step('windows', async () => {
    const list = await windowsApi.listWindows();
    if (!list.length) return 'ninguna ventana';
    const img = await windowsApi.windowImage(list[0]);
    const shadow = img ? windowsApi.withShadow(img).getSize() : null;
    return `${list.length} ventanas; primera="${list[0].name}" img=${JSON.stringify(img?.getSize())} conSombra=${JSON.stringify(shadow)}`;
  });
  const recordFor = (gif) => new Promise((resolve, reject) => {
    const display = screen.getPrimaryDisplay();
    const rect = { x: 0, y: 0, width: Math.min(800, display.bounds.width), height: Math.min(450, display.bounds.height) };
    const onDone = (_e, file) => resolve(file);
    beginRecording({ display, rect }, gif).then(async () => {
      const t0 = Date.now();
      while (recording && !recording.startedAt && Date.now() - t0 < 8000) await sleep(100);
      if (!recording?.startedAt) return reject(new Error('el grabador no arrancó'));
      await sleep(2500);
      stopRecording();
      const t1 = Date.now();
      while (Date.now() - t1 < 20000) {
        const last = [...captures.values()].pop();
        if (last.kind === 'video' && last.file.endsWith(gif ? '.gif' : '.mp4') && !recording) return onDone(null, last);
        await sleep(200);
      }
      reject(new Error('la grabación no terminó'));
    }, reject);
  });
  await step('recordMp4', async () => {
    const c = await recordFor(false);
    const head = fs.readFileSync(c.file).subarray(4, 8).toString('latin1');
    return `${path.basename(c.file)} ${c.label} bytes=${fs.statSync(c.file).size} box=${head}`;
  });
  await step('recordGif', async () => {
    const c = await recordFor(true);
    const head = fs.readFileSync(c.file).subarray(0, 6).toString('latin1');
    return `${path.basename(c.file)} ${c.label} bytes=${fs.statSync(c.file).size} header=${head}`;
  });
  await step('pages', async () => {
    const img = [...captures.values()].find((c) => c.kind === 'image');
    openEditor(img.id);
    openPin(img.id);
    openSettings();
    openOcrResult({ text: 'prueba', lines: 1, language: 'es-MX' });
    showQuickWindow(img.id);
    await sleep(3500);
    return [...readyPages].sort().join(',');
  });
  await step('editorTools', async () => {
    const ed = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Klip — Editor'));
    if (!ed) return 'ERROR editor no abierto';
    return ed.webContents.executeJavaScript(`(() => {
      const st = { color: '#ff3b30', width: 5, dashed: false, shadow: true };
      const box = (type, x, extra = {}) => ({ type, ...st, x1: x, y1: 40, x2: x + 120, y2: 140, ...extra });
      const list = [
        { type: 'arrow', ...st, heads: 'both', x1: 20, y1: 200, x2: 220, y2: 260 },
        { type: 'curve', ...st, heads: 'end', dashed: true, x1: 20, y1: 300, x2: 260, y2: 300, cx: 140, cy: 220 },
        { type: 'line', ...st, x1: 300, y1: 200, x2: 420, y2: 260 },
        box('rect', 20, { fill: false }), box('ellipse', 160, { fill: true }), box('hlbox', 300),
        box('pixelate', 440), box('blur', 580), box('spotlight', 720), box('sticker', 860, { emoji: '✅' }),
        { type: 'magnify', ...st, zoom: 2, x1: 400, y1: 300, x2: 460, y2: 340, bx: 600, by: 340 },
        { type: 'pen', ...st, points: [{ x: 500, y: 200 }, { x: 540, y: 240 }, { x: 580, y: 210 }] },
        { type: 'highlight', ...st, points: [{ x: 600, y: 200 }, { x: 700, y: 200 }] },
        { type: 'text', x: 20, y: 380, size: 30, color: '#0a84ff', style: 'label', shadow: true, text: 'Etiqueta\\nde prueba' },
        { type: 'text', x: 300, y: 380, size: 30, color: '#ffcc00', style: 'outline', shadow: false, text: 'Contorno' },
        { type: 'counter', color: '#34c759', width: 5, shadow: true, x: 700, y: 400 },
        { type: 'counter', color: '#ff3b30', width: 5, shadow: false, cstyle: 'outline', x: 780, y: 400 },
        { type: 'counter', color: '#0a84ff', width: 5, shadow: true, cstyle: 'letters', x: 860, y: 400 },
        { type: 'counter', color: '#ff9500', width: 5, shadow: false, cstyle: 'letters-outline', x: 940, y: 400 },
      ];
      list.forEach((o) => addObject(o));
      // select + move + resize + duplicate + undo/redo + delete
      selectedId = objects[3].id; translate(selected(), 5, 5); duplicateSelected(); deleteSelected();
      undo(); redo();
      const hits = ['arrow','curve','rect','text','counter','magnify'].map((t) => {
        const o = objects.find((x) => x.type === t); const b = boxOf(o);
        return t + ':' + Boolean(pick({ x: b.x + 2, y: b.y + b.height / 2 }) || pick({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
      });
      const curve = objects.find((x) => x.type === 'curve');
      hits.push('curveMid:' + Boolean(pick({ x: 140, y: 260 })));
      const url = exportDataUrl();
      window.__klipExport = url;
      return 'objetos=' + objects.length + ' png=' + Math.round(url.length / 1024) + 'KB undo=' + undoStack.length + ' hits=' + hits.join(',');
    })()`).then(async (summary) => {
      if (process.env.KLIP_SMOKE_KEEP) {
        const url = await ed.webContents.executeJavaScript('window.__klipExport');
        const out = path.join(app.getPath('temp'), 'klip-editor-test.png');
        fs.writeFileSync(out, nativeImage.createFromDataURL(url).toPNG());
        return `${summary} archivo=${out}`;
      }
      return summary;
    });
  });
  report.hotkeyErrors = hotkeyErrors.join(',') || 'ninguno';
  for (const [k, v] of Object.entries(report)) console.log(`SMOKE ${k}: ${v}`);
  // remove the smoke files (KLIP_SMOKE_KEEP=1 keeps them for inspection)
  if (!process.env.KLIP_SMOKE_KEEP) for (const c of captures.values()) fs.rmSync(c.file, { force: true });
  else for (const c of captures.values()) console.log(`SMOKE kept: ${c.file}`);
  app.exit(0);
}

// ================================================================ README screenshots

/** Demo content for screenshots: a fake dashboard, so no real desktop is shown. */
const DEMO_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font:15px "Segoe UI",sans-serif;background:#f4f5fb;color:#1d1d2b}
  .top{height:56px;background:#fff;display:flex;align-items:center;gap:14px;padding:0 24px;box-shadow:0 1px 0 #e3e4ee}
  .logo{width:28px;height:28px;border-radius:8px;background:#5b5bf7}.top b{font-size:17px}.sp{flex:1}
  .btn{background:#5b5bf7;color:#fff;border-radius:8px;padding:9px 18px;font-weight:600}
  .grid{display:grid;grid-template-columns:2fr 1fr;gap:20px;padding:24px}
  .card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h2{margin:0 0 4px;font-size:18px}.muted{color:#7b7c92;font-size:13px}
  .bars{display:flex;align-items:flex-end;gap:16px;height:250px;margin-top:20px}
  .bars div{flex:1;border-radius:8px 8px 0 0;background:#c9c9ff}.bars .hi{background:#5b5bf7}
  .labels{display:flex;gap:16px;margin-top:8px;color:#7b7c92;font-size:12px}.labels span{flex:1;text-align:center}
  .row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #eee}
  .kpi{font-size:34px;font-weight:700;margin:6px 0}.up{color:#1f9d55;font-weight:600}
</style></head><body>
<div class="top"><div class="logo"></div><b>Panel de ventas</b><span class="muted">Trimestre 3 · 2026</span><div class="sp"></div><div class="btn">Exportar informe</div></div>
<div class="grid">
 <div class="card"><h2>Ingresos mensuales</h2><div class="muted">En miles de dólares</div>
  <div class="bars"><div style="height:45%"></div><div style="height:60%"></div><div style="height:52%"></div><div style="height:70%"></div><div class="hi" style="height:92%"></div><div style="height:66%"></div></div>
  <div class="labels"><span>Abr</span><span>May</span><span>Jun</span><span>Jul</span><span>Ago</span><span>Sep</span></div></div>
 <div class="card"><h2>Resumen</h2><div class="kpi">$ 184 320</div><div class="up">▲ 12,4 % vs. trimestre anterior</div>
  <div class="row"><span>Clientes nuevos</span><b>248</b></div><div class="row"><span>Ticket medio</span><b>$ 742</b></div>
  <div class="row"><span>Contacto</span><b>ana.garcia@ejemplo.com</b></div><div class="row"><span>Tarjeta</span><b>4111 2222 3333 4444</b></div></div>
</div></body></html>`;

async function renderDemoImage() {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { sandbox: true, offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DEMO_HTML)}`);
  await sleep(600);
  const img = await win.webContents.capturePage();
  win.destroy();
  return img;
}

async function shoot(win, file, dir) {
  await sleep(900);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, file), img.toPNG());
  return `${file} ${JSON.stringify(img.getSize())}`;
}

async function screenshotMode(dir) {
  ensureDir(dir);
  const out = [];
  const image = await renderDemoImage();
  const id = 'demo';
  captures.set(id, { id, kind: 'image', file: path.join(app.getPath('temp'), 'klip-demo.png'), image });

  // 1. Editor with a typical annotated screenshot
  openEditor(id);
  await sleep(1500);
  const ed = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Klip — Editor'));
  ed.setSize(1280, 860);
  await ed.webContents.executeJavaScript(`(() => {
    const st = { width: 5, dashed: false, shadow: true };
    addObject({ type: 'rect', ...st, color: '#ff3b30', fill: false, x1: 1098, y1: 10, x2: 1274, y2: 46 });
    addObject({ type: 'curve', ...st, color: '#ff3b30', heads: 'end', x1: 960, y1: 96, x2: 1150, y2: 52, cx: 1090, cy: 104 });
    addObject({ type: 'text', x: 650, y: 78, size: 28, color: '#ff3b30', style: 'label', shadow: true, text: 'Descarga el informe' });
    addObject({ type: 'counter', color: '#5b5bf7', width: 6, shadow: true, cstyle: 'filled', x: 545, y: 200 });
    addObject({ type: 'hlbox', ...st, color: '#ffcc00', x1: 868, y1: 128, x2: 1060, y2: 178 });
    addObject({ type: 'counter', color: '#5b5bf7', width: 6, shadow: true, cstyle: 'filled', x: 1085, y: 152 });
    addObject({ type: 'magnify', ...st, color: '#5b5bf7', zoom: 2, x1: 893, y1: 180, x2: 1010, y2: 206, bx: 960, by: 560 });
    addObject({ type: 'blur', ...st, color: '#ff3b30', x1: 1050, y1: 300, x2: 1244, y2: 375 });
    addObject({ type: 'sticker', emoji: '🔒', color: '#000', width: 0, x1: 1005, y1: 318, x2: 1045, y2: 358 });
    addObject({ type: 'counter', color: '#5b5bf7', width: 6, shadow: true, cstyle: 'filled', x: 985, y: 338 });
    ui.bg.click();
    selectedId = null; setTool('arrow'); render(); fit();
  })()`);
  out.push(await shoot(ed, 'editor.png', dir));

  // 2. Quick-access card
  showQuickWindow(id);
  await sleep(800);
  const quick = quickWindows[quickWindows.length - 1];
  out.push(await shoot(quick, 'quick.png', dir));
  quick.close();

  // 3. Settings: hotkeys and recording tabs
  openSettings('hotkeys');
  await sleep(1500);
  settingsWin.setSize(900, 760);
  out.push(await shoot(settingsWin, 'settings-hotkeys.png', dir));
  settingsWin.webContents.send('settings:tab', 'recording');
  out.push(await shoot(settingsWin, 'settings-recording.png', dir));

  // 4. OCR result
  openOcrResult({ text: 'Panel de ventas\r\nTrimestre 3 · 2026\r\nIngresos mensuales\r\n$ 184 320\r\n▲ 12,4 % vs. trimestre anterior', lines: 5, language: 'es-MX' });
  await sleep(800);
  const ocrWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('ocr.html'));
  out.push(await shoot(ocrWin, 'ocr.png', dir));

  // 5. Recording control bar
  const bar = new BrowserWindow({ width: 420, height: 46, frame: false, transparent: true, show: true, skipTaskbar: true, webPreferences: webPrefs() });
  await bar.loadFile(path.join(RENDERER, 'bar.html'));
  bar.webContents.send('bar:init', { gif: false, microphone: true, systemAudio: true, hotkeyStop: 'Ctrl+Shift+5' });
  bar.webContents.send('rec:state', { paused: false, startedAt: Date.now() - 83000, pausedMs: 0, pausedAt: 0 });
  out.push(await shoot(bar, 'recording-bar.png', dir));

  out.forEach((l) => console.log(`SHOT ${l}`));
  app.exit(0);
}

// ================================================================ app shell

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Chromium logs "DxgiDuplicatorController failed" whenever GPU desktop
  // duplication is unavailable (VMs, RDP, basic display drivers) and then
  // falls back to GDI capture. Keep its console to fatal errors only.
  app.commandLine.appendSwitch('log-level', '3');
  app.on('second-instance', () => captureArea());
  app.setAppUserModelId('dev.klip.app');
  app.whenReady().then(() => {
    S = settingsStore.load();
    setupDisplayMediaHandler();
    tray = new Tray(createIcon(32));
    tray.setToolTip('Klip — capturas de pantalla');
    tray.on('click', () => (recording ? stopRecording() : captureArea()));
    tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
    hotkeyErrors = registerHotkeys();
    if (SMOKE) return smokeTest();
    if (process.env.KLIP_SCREENSHOTS) return screenshotMode(process.env.KLIP_SCREENSHOTS);
    if (hotkeyErrors.length) {
      const names = hotkeyErrors.map((id) => settingsStore.HOTKEY_ACTIONS.find((a) => a.id === id)?.label).join(', ');
      notify('Klip — atajos ocupados', `No se pudieron registrar: ${names}. Cámbialos en Configuración.`);
    } else {
      notify('Klip está activo', `${accelLabel(S.hotkeys.area)}: área · ${accelLabel(S.hotkeys.window)}: ventana · ` +
        `${accelLabel(S.hotkeys.recordArea)}: grabar · ${accelLabel(S.hotkeys.ocr)}: OCR`);
    }
  });
  app.on('window-all-closed', () => {}); // tray app: stay alive
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
