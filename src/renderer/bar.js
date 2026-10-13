'use strict';
const bar = document.getElementById('bar');
const time = document.getElementById('time');
const info = document.getElementById('info');
const pauseBtn = document.getElementById('pause');
let state = null;
let tick = 0;

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function render() {
  if (!state?.startedAt) return;
  const now = state.paused ? state.pausedAt : Date.now();
  time.textContent = fmt(now - state.startedAt - state.pausedMs);
}

window.klip.onBarInit((d) => {
  const parts = [d.gif ? 'GIF' : 'MP4'];
  if (!d.gif && d.microphone) parts.push('🎙 mic');
  if (!d.gif && d.systemAudio) parts.push('🔊 sistema');
  if (d.hotkeyStop) parts.push(`detener: ${d.hotkeyStop}`);
  info.textContent = parts.join(' · ');
});

window.klip.onCountdown((n) => {
  if (n > 0) time.textContent = `en ${n}…`;
});

window.klip.onRecState((s) => {
  state = s;
  bar.classList.toggle('rec', !s.paused);
  bar.classList.toggle('paused', s.paused);
  pauseBtn.disabled = false;
  pauseBtn.textContent = s.paused ? '▶' : '❚❚';
  pauseBtn.setAttribute('aria-label', s.paused ? 'Reanudar' : 'Pausar');
  clearInterval(tick);
  render();
  if (!s.paused) tick = setInterval(render, 250);
});

document.getElementById('stop').addEventListener('click', () => window.klip.barAction('stop'));
document.getElementById('pause').addEventListener('click', () => window.klip.barAction('pause'));
document.getElementById('cancel').addEventListener('click', () => window.klip.barAction('cancel'));
window.klip.ready('bar');
