'use strict';
const video = document.getElementById('v');
const err = document.getElementById('err');
window.klip.onWebcamInit(async ({ deviceId }) => {
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: 480, height: 480 } : { width: 480, height: 480 },
      audio: false,
    });
  } catch (e) {
    err.textContent = `Cámara no disponible: ${e.message}`;
  }
});
window.klip.ready('webcam');
