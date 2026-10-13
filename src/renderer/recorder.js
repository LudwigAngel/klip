// Hidden page that owns the screen stream during a recording.
// MP4: MediaRecorder (H.264 + AAC) on the stream, or on a cropped canvas.
// GIF: frames are sampled from the canvas and encoded live with gifenc,
// so there is no seeking or post-processing pass at the end.
import { GIFEncoder, quantize, applyPalette } from '../../node_modules/gifenc/dist/gifenc.esm.js';

const api = window.klip;
let rec = null;

const MIME_AUDIO = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const MIME_VIDEO = ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];

function pickMime(hasAudio) {
  return (hasAudio ? MIME_AUDIO : MIME_VIDEO).find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function waitForVideo(video) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('el vídeo de la pantalla no llegó')), 8000);
    const check = () => {
      if (video.videoWidth > 0) { clearTimeout(t); resolve(); } else requestAnimationFrame(check);
    };
    video.onloadedmetadata = check;
    check();
  });
}

function activeMs() {
  if (!rec) return 0;
  const now = rec.pausedAt || performance.now();
  return now - rec.t0 - rec.pausedTotal;
}

async function start(opts) {
  const tracks = [];
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: opts.fps, max: opts.fps } },
    audio: !opts.gif,
  });
  tracks.push(...display.getTracks());

  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = display;
  await video.play();
  await waitForVideo(video);

  const W = opts.width, H = opts.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: opts.gif, alpha: false });
  ctx.imageSmoothingQuality = 'high';

  // Source rectangle in video pixels (crop is in DIP relative to the display).
  const srcRect = () => {
    if (opts.crop && opts.displayBounds) {
      const sx = video.videoWidth / opts.displayBounds.width;
      const sy = video.videoHeight / opts.displayBounds.height;
      return [opts.crop.x * sx, opts.crop.y * sy, opts.crop.width * sx, opts.crop.height * sy];
    }
    return [0, 0, video.videoWidth, video.videoHeight];
  };
  const draw = () => {
    const [sx, sy, sw, sh] = srcRect();
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  };

  rec = {
    opts, video, canvas, ctx, tracks, t0: performance.now(), pausedTotal: 0, pausedAt: 0,
    timer: 0, poster: '', audioCtx: null,
  };
  draw();
  rec.poster = posterOf(canvas);

  if (opts.gif) {
    rec.gif = GIFEncoder();
    rec.frames = 0;
    const delay = Math.round(1000 / opts.fps);
    rec.timer = setInterval(() => {
      if (!rec || rec.pausedAt) return;
      draw();
      const { data } = ctx.getImageData(0, 0, W, H);
      const palette = quantize(data, 256, { format: 'rgb444' });
      const index = applyPalette(data, palette, 'rgb444');
      rec.gif.writeFrame(index, W, H, { palette, delay });
      rec.frames += 1;
      if (opts.maxSeconds && activeMs() >= opts.maxSeconds * 1000) stop();
    }, delay);
    api.recorderStarted();
    return;
  }

  // MP4 path: crop/scale through the canvas only when needed.
  const vw = video.videoWidth, vh = video.videoHeight;
  const needsCanvas = Boolean(opts.crop) || Math.abs(vw - W) > 2 || Math.abs(vh - H) > 2;
  let videoTrack;
  if (needsCanvas) {
    rec.timer = setInterval(() => { if (rec && !rec.pausedAt) draw(); }, 1000 / opts.fps);
    videoTrack = canvas.captureStream(opts.fps).getVideoTracks()[0];
    tracks.push(videoTrack);
  } else {
    videoTrack = display.getVideoTracks()[0];
  }

  // Mix system audio (loopback) and the microphone into one track.
  const audioSources = display.getAudioTracks().length ? [new MediaStream(display.getAudioTracks())] : [];
  if (opts.microphone) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: opts.microphoneId ? { deviceId: { exact: opts.microphoneId } } : { echoCancellation: true, noiseSuppression: true },
      });
      tracks.push(...mic.getTracks());
      audioSources.push(mic);
    } catch (err) {
      console.warn('Micrófono no disponible:', err.message);
    }
  }
  let audioTrack = null;
  if (audioSources.length === 1) {
    audioTrack = audioSources[0].getAudioTracks()[0];
  } else if (audioSources.length > 1) {
    rec.audioCtx = new AudioContext();
    const dest = rec.audioCtx.createMediaStreamDestination();
    audioSources.forEach((s) => rec.audioCtx.createMediaStreamSource(s).connect(dest));
    audioTrack = dest.stream.getAudioTracks()[0];
  }

  const stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
  const mimeType = pickMime(Boolean(audioTrack));
  rec.mimeType = mimeType;
  rec.chunks = [];
  rec.media = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: opts.bitrate, audioBitsPerSecond: 160_000 });
  rec.media.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.media.onerror = (e) => fail(e.error || new Error('MediaRecorder falló'));
  rec.media.start(1000);
  api.recorderStarted();
}

function posterOf(canvas) {
  const p = document.createElement('canvas');
  const scale = Math.min(1, 560 / canvas.width);
  p.width = Math.max(1, Math.round(canvas.width * scale));
  p.height = Math.max(1, Math.round(canvas.height * scale));
  p.getContext('2d').drawImage(canvas, 0, 0, p.width, p.height);
  return p.toDataURL('image/jpeg', 0.8);
}

function releaseMedia() {
  if (!rec) return;
  clearInterval(rec.timer);
  rec.tracks.forEach((t) => t.stop());
  rec.audioCtx?.close();
  rec.video.srcObject = null;
}

async function stop() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  const durationMs = activeMs();
  try {
    if (rec.gif) {
      releaseMedia();
      rec.gif.finish();
      const bytes = rec.gif.bytes();
      const done = rec;
      rec = null;
      await api.recorderFinished({ bytes, ext: 'gif', poster: done.poster, durationMs });
      return;
    }
    await new Promise((resolve) => {
      rec.media.onstop = resolve;
      if (rec.media.state !== 'inactive') rec.media.stop(); else resolve();
    });
    releaseMedia();
    const blob = new Blob(rec.chunks, { type: rec.mimeType || 'video/webm' });
    const ext = (rec.mimeType || '').startsWith('video/mp4') ? 'mp4' : 'webm';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const poster = rec.poster;
    rec = null;
    await api.recorderFinished({ bytes, ext, poster, durationMs });
  } catch (err) {
    fail(err);
  }
}

function cancel() {
  if (rec?.media && rec.media.state !== 'inactive') {
    rec.media.ondataavailable = null;
    rec.media.onstop = null;
    rec.media.stop();
  }
  releaseMedia();
  rec = null;
  api.recorderCancelled();
}

function setPaused(paused) {
  if (!rec || rec.stopping || Boolean(rec.pausedAt) === paused) return;
  if (paused) {
    rec.pausedAt = performance.now();
    rec.media?.pause();
  } else {
    rec.pausedTotal += performance.now() - rec.pausedAt;
    rec.pausedAt = 0;
    rec.media?.resume();
  }
  api.recorderPaused(paused);
}

function fail(err) {
  try { releaseMedia(); } catch { /* already released */ }
  rec = null;
  api.recorderError(err?.message || String(err));
}

api.onRecorderStart((opts) => start(opts).catch(fail));
api.onRecorderStop(() => stop());
api.onRecorderCancel(() => cancel());
api.onRecorderPause(() => setPaused(true));
api.onRecorderResume(() => setPaused(false));
api.ready('recorder');
