'use strict';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const statusEl = $('#status');

let saved = null; // last saved settings
let draft = null; // edited copy
let defaults = null;
let actions = [];
let hotkeyErrors = [];
let openAtLogin = false;
let listening = null; // action id being recorded

const clone = (o) => JSON.parse(JSON.stringify(o));
const getPath = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  parts.reduce((o, k) => o[k], obj)[last] = value;
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// ------------------------------------------------------------------ tabs

function showTab(name) {
  if (!$(`[data-panel="${name}"]`)) name = 'general';
  $$('nav [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('[data-panel]').forEach((s) => { s.hidden = s.dataset.panel !== name; });
}
$$('nav [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.klip.onSettingsTab(showTab);

// ------------------------------------------------------------------ form binding

function fillForm() {
  $$('[data-key]').forEach((el) => {
    const v = getPath(draft, el.dataset.key);
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  });
  $('#openAtLogin').checked = openAtLogin;
  updateOutputs();
  renderHotkeys();
}

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number' || el.type === 'range' || el.dataset.type === 'number') {
    const n = Number(el.value);
    const min = el.min !== '' ? Number(el.min) : -Infinity, max = el.max !== '' ? Number(el.max) : Infinity;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : getPath(saved, el.dataset.key);
  }
  return el.value;
}

$$('[data-key]').forEach((el) => {
  const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(evt, () => { setPath(draft, el.dataset.key, readField(el)); updateOutputs(); markDirty(); });
});
$('#openAtLogin').addEventListener('change', markDirty);

function updateOutputs() {
  $('#jpgQualityOut').textContent = `${draft.capture.jpgQuality}%`;
  $('#bitrateOut').textContent = `${draft.recording.videoBitrateMbps} Mbps`;
  $('#jpgQuality').disabled = draft.capture.format !== 'jpg';
  $('#microphoneId').disabled = !draft.recording.microphone;
  $('#webcamId').disabled = !draft.recording.webcam;
}

function isDirty() {
  return JSON.stringify(draft) !== JSON.stringify(saved) || $('#openAtLogin').checked !== openAtLogin;
}
function markDirty() {
  if (isDirty()) setStatus('Hay cambios sin guardar.');
  else setStatus('');
}

$$('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
  const key = `general.${b.dataset.pick}`;
  const dir = await window.klip.settingsPickFolder(getPath(draft, key));
  if (dir) { setPath(draft, key, dir); fillForm(); markDirty(); }
}));
$$('[data-open]').forEach((b) => b.addEventListener('click', () => {
  window.klip.settingsOpenFolder(getPath(draft, `general.${b.dataset.open}`));
}));

// ------------------------------------------------------------------ devices & languages

function fillSelect(select, items, current, placeholder) {
  select.innerHTML = '';
  select.appendChild(new Option(placeholder, ''));
  items.forEach((it) => select.appendChild(new Option(it.label, it.value)));
  if (current && !items.some((i) => i.value === current)) select.appendChild(new Option('(dispositivo guardado, no conectado)', current));
  select.value = current || '';
}

async function loadDevices(askPermission = false) {
  try {
    if (askPermission) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() =>
        navigator.mediaDevices.getUserMedia({ audio: true }));
      s.getTracks().forEach((t) => t.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ value: d.deviceId, label: d.label || `Micrófono ${i + 1}` }));
    const cams = devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ value: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
    fillSelect($('#microphoneId'), mics, draft.recording.microphoneId, 'Predeterminado de Windows');
    fillSelect($('#webcamId'), cams, draft.recording.webcamId, 'Predeterminada');
    if (askPermission) setStatus(`${mics.length} micrófono(s) y ${cams.length} cámara(s) detectados.`);
  } catch (err) {
    setStatus(`No se pudieron listar los dispositivos: ${err.message}`, 'bad');
  }
}
$('#detectDevices').addEventListener('click', () => loadDevices(true));

async function loadOcrLanguages() {
  const langs = await window.klip.settingsOcrLanguages();
  fillSelect($('#ocrLanguage'), langs.map((l) => ({ value: l.tag, label: `${l.name} (${l.tag})` })), draft.ocr.language, 'Idioma de Windows');
}

// ------------------------------------------------------------------ hotkeys

const CODE_KEYS = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', PrintScreen: 'PrintScreen', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backquote: '`', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', NumpadEnter: 'Enter',
};

function keyFromEvent(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^Numpad[0-9]$/.test(c)) return `num${c.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  return CODE_KEYS[c] || null;
}

function accelFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return null; // modifier alone: keep waiting
  const key = keyFromEvent(e);
  if (!key) return { error: `La tecla “${e.key}” no se puede usar.` };
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const standalone = /^F\d+$/.test(key) || key === 'PrintScreen';
  if (!mods.length && !standalone) return { error: 'Añade Ctrl, Alt, Shift o Win a la tecla.' };
  if (mods.length === 1 && mods[0] === 'Shift' && !standalone) return { error: 'Shift solo no basta: añade Ctrl, Alt o Win.' };
  return { accel: [...mods, key].join('+') };
}

const KEY_NAMES = { CommandOrControl: 'Ctrl', Super: 'Win', PrintScreen: 'Impr Pant', Up: '↑', Down: '↓', Left: '←', Right: '→',
  Space: 'Espacio', Delete: 'Supr', Backspace: 'Retroceso', PageUp: 'RePág', PageDown: 'AvPág', Insert: 'Insert', Home: 'Inicio', End: 'Fin' };
const label = (accel) => accel.split('+').map((p) => KEY_NAMES[p] || p).join(' + ');

function conflictsOf(id) {
  const accel = draft.hotkeys[id];
  if (!accel) return [];
  return actions.filter((a) => a.id !== id && draft.hotkeys[a.id] === accel).map((a) => a.label);
}

function renderHotkeys() {
  const root = $('#hotkeys');
  root.innerHTML = '';
  const groups = [...new Set(actions.map((a) => a.group))];
  for (const g of groups) {
    const fs = document.createElement('fieldset');
    fs.className = 'hk-group';
    fs.innerHTML = `<legend>${g}</legend>`;
    for (const a of actions.filter((x) => x.group === g)) {
      const accel = draft.hotkeys[a.id];
      const row = document.createElement('div');
      row.className = 'hk';
      const name = document.createElement('span');
      name.textContent = a.label;
      name.id = `hk-label-${a.id}`;
      const key = document.createElement('button');
      key.className = 'hk-key';
      key.dataset.id = a.id;
      key.setAttribute('aria-describedby', name.id);
      const clear = document.createElement('button');
      clear.className = 'hk-clear';
      clear.textContent = '✕';
      clear.title = 'Quitar atajo';
      clear.setAttribute('aria-label', `Quitar atajo de ${a.label}`);
      clear.addEventListener('click', () => { draft.hotkeys[a.id] = ''; renderHotkeys(); markDirty(); });
      if (listening === a.id) { key.classList.add('listening'); key.textContent = 'Pulsa la combinación…'; }
      else if (!accel) { key.classList.add('empty'); key.textContent = 'Sin atajo'; }
      else key.textContent = label(accel);
      key.addEventListener('click', () => startListening(a.id));
      row.append(name, key, clear);
      const conflicts = conflictsOf(a.id);
      const changed = accel !== saved.hotkeys[a.id];
      let msg = '';
      if (conflicts.length) { key.classList.add('conflict'); msg = `<div class="hk-msg warn">Repetido con: ${conflicts.join(', ')}</div>`; }
      else if (hotkeyErrors.includes(a.id) && !changed && accel) { key.classList.add('taken'); msg = '<div class="hk-msg bad">Otra aplicación ya usa este atajo.</div>'; }
      if (msg) row.insertAdjacentHTML('beforeend', msg);
      fs.appendChild(row);
    }
    root.appendChild(fs);
  }
  if (listening) $(`.hk-key[data-id="${listening}"]`)?.focus();
}

function startListening(id) {
  listening = id;
  renderHotkeys();
  setStatus('Pulsa la nueva combinación de teclas (Esc cancela, Retroceso la deja vacía).');
}

function stopListening() {
  listening = null;
  renderHotkeys();
}

function handleHotkeyKey(e) {
  if (!listening) return false;
  e.preventDefault();
  e.stopPropagation();
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (plain && e.key === 'Escape') { stopListening(); markDirty(); return true; }
  if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
    draft.hotkeys[listening] = '';
    stopListening(); markDirty();
    return true;
  }
  const r = accelFromEvent(e);
  if (!r) return true; // only a modifier so far
  if (r.error) { setStatus(r.error, 'bad'); return true; }
  draft.hotkeys[listening] = r.accel;
  stopListening();
  markDirty();
  return true;
}

window.addEventListener('keydown', handleHotkeyKey, true);
// Windows often delivers Print Screen only as keyup.
window.addEventListener('keyup', (e) => { if (listening && e.code === 'PrintScreen') handleHotkeyKey(e); }, true);
window.addEventListener('blur', () => { if (listening) stopListening(); });

$('#resetHotkeys').addEventListener('click', () => {
  draft.hotkeys = clone(defaults.hotkeys);
  renderHotkeys();
  markDirty();
});

// ------------------------------------------------------------------ save / revert

function validate() {
  for (const a of actions) {
    if (conflictsOf(a.id).length) return `El atajo de “${a.label}” está repetido.`;
  }
  if (!draft.general.screenshotDir.trim() || !draft.general.recordingDir.trim()) return 'Las carpetas no pueden quedar vacías.';
  return '';
}

async function save() {
  const problem = validate();
  if (problem) { setStatus(problem, 'bad'); showTab(problem.includes('atajo') ? 'hotkeys' : 'general'); return; }
  const res = await window.klip.settingsSave({ settings: draft, openAtLogin: $('#openAtLogin').checked });
  saved = clone(res.settings);
  draft = clone(res.settings);
  hotkeyErrors = res.hotkeyErrors;
  openAtLogin = $('#openAtLogin').checked;
  fillForm();
  if (hotkeyErrors.length) {
    const names = hotkeyErrors.map((id) => actions.find((a) => a.id === id)?.label).join(', ');
    setStatus(`Guardado, pero estos atajos están ocupados por otra app: ${names}.`, 'bad');
    showTab('hotkeys');
  } else {
    setStatus('Configuración guardada.', 'ok');
  }
}

$('#save').addEventListener('click', save);
$('#revert').addEventListener('click', () => { draft = clone(saved); fillForm(); setStatus('Cambios descartados.'); });
$('#resetAll').addEventListener('click', () => {
  const keepDirs = { ...draft.general };
  draft = clone(defaults);
  draft.general.screenshotDir = keepDirs.screenshotDir;
  draft.general.recordingDir = keepDirs.recordingDir;
  fillForm();
  setStatus('Valores predeterminados cargados. Pulsa Guardar para aplicarlos.');
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

// ------------------------------------------------------------------ boot

(async () => {
  const data = await window.klip.settingsGet();
  saved = clone(data.settings);
  draft = clone(data.settings);
  defaults = data.defaults;
  actions = data.actions;
  hotkeyErrors = data.hotkeyErrors || [];
  openAtLogin = data.openAtLogin;
  $('#version').textContent = `Versión ${data.version}`;
  fillForm();
  showTab(location.hash.slice(1) || 'general');
  loadDevices(false);
  loadOcrLanguages();
  window.klip.ready('settings');
})();
