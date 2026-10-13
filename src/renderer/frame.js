'use strict';
const count = document.getElementById('count');
window.klip.onCountdown((n) => { count.textContent = n > 0 ? String(n) : ''; });
window.klip.onRecState((s) => document.body.classList.toggle('paused', s.paused));
window.klip.ready('frame');
