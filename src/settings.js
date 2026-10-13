'use strict';
// Persistent settings stored as JSON in %APPDATA%\Klip\settings.json.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** Every action that can have a global hotkey, in display order. */
const HOTKEY_ACTIONS = [
  { id: 'area', label: 'Capturar área', group: 'Captura' },
  { id: 'fullscreen', label: 'Capturar pantalla completa', group: 'Captura' },
  { id: 'window', label: 'Capturar ventana', group: 'Captura' },
  { id: 'previousArea', label: 'Capturar área anterior', group: 'Captura' },
  { id: 'timerFullscreen', label: 'Pantalla completa con temporizador', group: 'Captura' },
  { id: 'recordArea', label: 'Grabar área (MP4) / detener', group: 'Grabación' },
  { id: 'recordFullscreen', label: 'Grabar pantalla completa (MP4) / detener', group: 'Grabación' },
  { id: 'recordWindow', label: 'Grabar ventana (MP4) / detener', group: 'Grabación' },
  { id: 'recordGif', label: 'Grabar área como GIF / detener', group: 'Grabación' },
  { id: 'recordPause', label: 'Pausar / reanudar grabación', group: 'Grabación' },
  { id: 'ocr', label: 'Extraer texto de un área (OCR)', group: 'Texto' },
  { id: 'openLast', label: 'Abrir última captura en el editor', group: 'Otros' },
  { id: 'openFolder', label: 'Abrir carpeta de capturas', group: 'Otros' },
  { id: 'settings', label: 'Abrir configuración', group: 'Otros' },
];

function defaults() {
  return {
    version: 1,
    general: {
      autoCopy: true,
      afterCapture: 'quick', // quick | editor | pin | none
      quickTimeoutSec: 20, // 0 = never auto-close
      quickPosition: 'left', // left | right
      screenshotDir: path.join(app.getPath('pictures'), 'Klip'),
      recordingDir: path.join(app.getPath('videos'), 'Klip'),
      notifications: true,
    },
    capture: {
      format: 'png', // png | jpg
      jpgQuality: 92,
      windowShadow: true,
      magnifier: true,
      crosshair: true,
      timerSeconds: 5,
    },
    recording: {
      fps: 30,
      maxHeight: 0, // 0 = native, else 1080 / 720
      videoBitrateMbps: 8,
      showCursor: true,
      microphone: false,
      microphoneId: '',
      systemAudio: false,
      webcam: false,
      webcamId: '',
      countdown: 3,
      gifFps: 12,
      gifMaxWidth: 800,
      gifMaxSeconds: 30,
    },
    ocr: {
      language: '', // '' = Windows profile language
      keepLineBreaks: true,
    },
    hotkeys: {
      area: 'CommandOrControl+Shift+2',
      fullscreen: 'CommandOrControl+Shift+1',
      window: 'CommandOrControl+Shift+4',
      previousArea: 'CommandOrControl+Shift+3',
      timerFullscreen: '',
      recordArea: 'CommandOrControl+Shift+5',
      recordFullscreen: 'CommandOrControl+Shift+6',
      recordWindow: '',
      recordGif: 'CommandOrControl+Shift+7',
      recordPause: 'CommandOrControl+Shift+8',
      ocr: 'CommandOrControl+Shift+O',
      openLast: 'CommandOrControl+Shift+E',
      openFolder: '',
      settings: '',
    },
  };
}

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Deep-merge `src` onto `base`, keeping only keys `base` knows and matching types. */
function merge(base, src) {
  if (!src || typeof src !== 'object') return base;
  for (const key of Object.keys(base)) {
    if (!(key in src)) continue;
    const b = base[key], s = src[key];
    if (b && typeof b === 'object' && !Array.isArray(b)) merge(b, s);
    else if (typeof s === typeof b) base[key] = s;
  }
  return base;
}

let current = null;

function load() {
  current = defaults();
  try {
    merge(current, JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    /* first run or unreadable file: keep defaults */
  }
  return current;
}

function get() {
  return current || load();
}

function save(next) {
  current = merge(defaults(), next);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(current, null, 2));
  return current;
}

module.exports = { HOTKEY_ACTIONS, defaults, load, get, save };
