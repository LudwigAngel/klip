'use strict';
// The only bridge between Klip's pages and the main process. Pages run
// sandboxed with no Node access; every channel they can touch is listed here.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('klip', {
  ready: (page) => ipcRenderer.send('renderer:ready', page),
  closeWindow: () => ipcRenderer.send('window:close'),
  moveWindow: (x, y) => ipcRenderer.send('window:move', { x, y }),

  // selection overlay
  onOverlayInit: listen('overlay:init'),
  onOverlayWindows: listen('overlay:windows'),
  overlayDone: (rect) => ipcRenderer.send('overlay:done', rect),
  overlayPickWindow: (id) => ipcRenderer.send('overlay:pickWindow', id),
  overlayWantWindows: () => ipcRenderer.send('overlay:wantWindows'),
  overlayCancel: () => ipcRenderer.send('overlay:cancel'),

  // quick access card
  onQuickInit: listen('quick:init'),
  quickAction: (id, action) => ipcRenderer.invoke('quick:action', { id, action }),
  quickDrag: (id) => ipcRenderer.send('quick:drag', id),

  // pinned screenshot
  onPinInit: listen('pin:init'),
  pinMove: (x, y) => ipcRenderer.send('pin:move', { x, y }),
  pinZoom: (factor) => ipcRenderer.send('pin:zoom', factor),
  pinOpacity: (delta) => ipcRenderer.send('pin:opacity', delta),
  pinMenu: () => ipcRenderer.send('pin:menu'),

  // editor
  onEditorInit: listen('editor:init'),
  editorExport: (id, dataUrl, mode) => ipcRenderer.invoke('editor:export', { id, dataUrl, mode }),

  // OCR result
  onOcrInit: listen('ocr:init'),
  ocrCopy: (text) => ipcRenderer.invoke('ocr:copy', text),

  // recording: recorder page
  onRecorderStart: listen('recorder:start'),
  onRecorderStop: listen('recorder:stop'),
  onRecorderCancel: listen('recorder:cancel'),
  onRecorderPause: listen('recorder:pause'),
  onRecorderResume: listen('recorder:resume'),
  recorderStarted: () => ipcRenderer.send('recorder:started'),
  recorderPaused: (paused) => ipcRenderer.send('recorder:paused', paused),
  recorderError: (message) => ipcRenderer.send('recorder:error', String(message)),
  recorderCancelled: () => ipcRenderer.send('recorder:cancelled'),
  recorderFinished: (payload) => ipcRenderer.invoke('recorder:finished', payload),
  // recording: control bar, frame and webcam
  onBarInit: listen('bar:init'),
  barAction: (action) => ipcRenderer.send('bar:action', action),
  onRecState: listen('rec:state'),
  onCountdown: listen('rec:countdown'),
  onWebcamInit: listen('webcam:init'),

  // settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (payload) => ipcRenderer.invoke('settings:save', payload),
  settingsPickFolder: (current) => ipcRenderer.invoke('settings:pickFolder', current),
  settingsOcrLanguages: () => ipcRenderer.invoke('settings:ocrLanguages'),
  settingsOpenFolder: (dir) => ipcRenderer.invoke('settings:openFolder', dir),
  onSettingsTab: listen('settings:tab'),
});
