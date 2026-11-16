import Hls from 'hls.js';
import { selectTextTrack } from '@videojs/html';

const STEP = 5;
const LIMIT = 96;
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="135"><rect width="240" height="135" fill="#182018"/><text x="120" y="72" text-anchor="middle" font-size="14" fill="#c4d6b8">正在准备画面</text></svg>');

// Video.js renders the timeline preview from this standard thumbnail track.
// A separate, muted decoder supplies missing frames without seeking the player.
export function createPreviewControls({ player, skin, video, status }) {
  let source, config, getLevel, decoder, engine, track, timer, idleTimer;
  let generation = 0, wanted = null, running = false, controller;
  const frames = new Map();
  const failures = new Map();
  const listeners = new AbortController();

  function closeDecoder() {
    engine?.destroy(); engine = undefined;
    if (decoder) {
      decoder.pause(); decoder.removeAttribute('src'); decoder.load();
      decoder = undefined;
    }
  }

  function reset() {
    generation++;
    clearTimeout(timer); clearTimeout(idleTimer);
    controller?.abort(); controller = undefined;
    closeDecoder();
    track?.remove(); track = undefined;
    for (const { url } of frames.values()) URL.revokeObjectURL(url);
    frames.clear(); failures.clear();
    source = config = getLevel = undefined;
    wanted = null; running = false;
    status.textContent = '悬停进度条可预览画面';
  }

  function waitUntil(check, events, signal) {
    return new Promise((resolve, reject) => {
      const target = decoder;
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        for (const name of events) target.removeEventListener(name, update);
        signal.removeEventListener('abort', abort);
        engine?.off(Hls.Events.ERROR, error);
      };
      const finish = error => { cleanup(); error ? reject(error) : resolve(); };
      const update = () => { if (check()) finish(); };
      const abort = () => finish(new DOMException('Preview cancelled', 'AbortError'));
      const error = (_, data) => { if (data.fatal) finish(new Error('Preview unavailable')); };
      for (const name of events) target.addEventListener(name, update);
      signal.addEventListener('abort', abort, { once: true });
      engine.on(Hls.Events.ERROR, error);
      timeout = setTimeout(() => finish(new Error('Preview timeout')), 12000);
      if (signal.aborted) abort(); else update();
    });
  }

  async function extract(time, signal) {
    if (!engine) {
      decoder = document.createElement('video');
      decoder.muted = true; decoder.playsInline = true; decoder.preload = 'auto';
      engine = new Hls({
        ...config, autoStartLoad: false, startPosition: time,
        maxBufferLength: 2, maxMaxBufferLength: 4,
        maxBufferSize: 2 * 1024 * 1024, backBufferLength: 0,
        startLevel: getLevel(), capLevelToPlayerSize: false,
      });
      engine.on(Hls.Events.MANIFEST_PARSED, () => {
        engine.loadLevel = getLevel();
        engine.startLoad(time);
      });
      engine.on(Hls.Events.MEDIA_ATTACHED, () => engine.loadSource(source));
      engine.attachMedia(decoder);
    } else {
      engine.loadLevel = getLevel();
      engine.startLoad(time);
    }
    await waitUntil(() => decoder.readyState >= 1, ['loadedmetadata', 'durationchange'], signal);
    decoder.currentTime = time;
    await waitUntil(() => decoder.readyState >= 2 && !decoder.seeking && Math.abs(decoder.currentTime - time) < 0.5,
      ['loadeddata', 'seeked', 'canplay', 'timeupdate'], signal);
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = Math.max(1, Math.round(240 * decoder.videoHeight / decoder.videoWidth));
    canvas.getContext('2d').drawImage(decoder, 0, 0, canvas.width, canvas.height);
    engine.stopLoad();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.7));
    signal.throwIfAborted();
    if (!blob) throw new Error('Preview image unavailable');
    return blob;
  }

  function publishFrames() {
    // Video.js holds each thumbnail until the next start time, so explicit
    // placeholders prevent an earlier frame appearing at an ungenerated time.
    const markers = new Map([[0, PLACEHOLDER]]);
    for (const [time, frame] of frames) {
      markers.set(time, frame.url);
      if (!frames.has(time + STEP) && time + STEP < video.duration) markers.set(time + STEP, PLACEHOLDER);
    }
    const entries = [...markers].sort((a, b) => a[0] - b[0]);
    const cues = entries.map(([startTime, text], index) => ({
      startTime, endTime: entries[index + 1]?.[0] ?? video.duration, text,
    }));
    track?.remove();
    track = player.store.addTextTrack({ kind: 'metadata', label: 'thumbnails', cues });
  }

  async function generate() {
    if (running || wanted === null || !source || video.streamType === 'live') return;
    const key = wanted;
    if (frames.has(key) || (failures.get(key) || 0) > Date.now()) return;
    clearTimeout(idleTimer);
    running = true;
    const epoch = generation;
    const abort = controller = new AbortController();
    status.textContent = '正在准备画面预览…';
    try {
      const time = Math.min(key + 0.2, Math.max(0, video.duration - 0.1));
      const blob = await extract(time, abort.signal);
      if (epoch !== generation) return;
      const url = URL.createObjectURL(blob);
      frames.set(key, { url });
      while (frames.size > LIMIT) {
        const oldest = frames.keys().next().value;
        const frame = frames.get(oldest);
        URL.revokeObjectURL(frame.url); frames.delete(oldest);
      }
      publishFrames();
      status.textContent = '悬停进度条可预览画面';
    } catch (error) {
      if (epoch !== generation || error.name === 'AbortError') return;
      failures.set(key, Date.now() + 30000);
      closeDecoder();
      status.textContent = '此处画面暂时无法预览，仍可正常拖动进度';
    } finally {
      if (epoch === generation) {
        running = false;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(closeDecoder, 15000);
        if (wanted !== null && wanted !== key) void generate();
      }
    }
  }

  function point(event) {
    // composedPath reaches Video.js components inside a packaged skin without
    // depending on its private classes, markup, or shadow-root layout.
    const slider = event.composedPath().find(node => node.localName === 'media-time-slider');
    if (!slider || !source || !Number.isFinite(video.duration) || video.duration <= 0 || video.streamType === 'live') return;
    const existing = selectTextTrack(player.store.state)?.thumbnailsTrack;
    if (!track && existing?.cues?.length) return;
    if (!track) publishFrames();
    const bounds = slider.getBoundingClientRect();
    if (!bounds.width) return;
    const time = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * video.duration;
    wanted = Math.floor(Math.min(time, Math.max(0, video.duration - 0.1)) / STEP) * STEP;
    clearTimeout(timer); clearTimeout(idleTimer);
    if (frames.has(wanted)) {
      const frame = frames.get(wanted);
      frames.delete(wanted); frames.set(wanted, frame);
      status.textContent = '悬停进度条可预览画面';
      if (!running) idleTimer = setTimeout(closeDecoder, 15000);
    } else timer = setTimeout(() => void generate(), 180);
  }
  skin.addEventListener('pointermove', point, { capture: true, signal: listeners.signal });
  skin.addEventListener('pointerdown', point, { capture: true, signal: listeners.signal });
  skin.addEventListener('pointerleave', () => {
    wanted = null; clearTimeout(timer);
    if (!running) { clearTimeout(idleTimer); idleTimer = setTimeout(closeDecoder, 15000); }
  }, { signal: listeners.signal });

  return {
    reset,
    setSource(url, engineConfig, level) { reset(); source = url; config = engineConfig; getLevel = level; },
    destroy() { reset(); listeners.abort(); },
  };
}
