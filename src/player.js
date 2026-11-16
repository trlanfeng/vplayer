import Hls from 'hls.js';
import { bytes, clock, fragmentDescriptor, segmentKey } from './common.js';
import { SegmentCache } from './cache.js';
import { SegmentScheduler } from './scheduler.js';
import { createFragmentLoader } from './loader.js';
import { createEpisodeControls } from './episode-controls.js';

const $ = id => document.getElementById(id);
const video = $('video');
const sessionId = new URL(location.href).searchParams.get('session');
const settings = { concurrency: 4, ahead: 120, prefetch: true };
let source, cache, scheduler, hls, videoDetails, audioDetails;
let planned = [], stalled = 0, hasPlayed = false, waiting = false, fatal = false, toastTimer, retrying = false;
let selectedLevel = 0;
const speeds = Array(36).fill(0);
const episodeControls = createEpisodeControls({
  sessionId,
  getPosition: () => video.currentTime,
  async onSwitch(nextSource, startPosition) {
    scheduler?.close();
    hls?.destroy(); hls = undefined;
    cache?.db?.close();
    source = nextSource;
    $('video-title').textContent = source.title || '网页视频';
    document.title = `${source.title || '视频'} · VPlayer`;
    $('source-host').textContent = new URL(source.url).hostname;
    stalled = 0;
    speeds.fill(0);
    cache = new SegmentCache(source.cacheId || sessionId);
    await cache.init();
    await start(startPosition);
  },
});

function state(text, error = false) {
  $('state').classList.toggle('error', error);
  $('state').querySelector('span').textContent = text;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}

function showError(message) {
  fatal = true;
  state('连接遇到问题', true);
  $('error-message').textContent = message;
  $('error-panel').hidden = false;
  $('placeholder-title').textContent = '暂时无法连接';
  $('placeholder-detail').textContent = '请查看下方提示后重试。';
  scheduler?.cancelPrefetch();
}

function saveSettings() {
  chrome.storage.local.set({ settings }).catch(() => {});
}

function setConcurrency(value) {
  settings.concurrency = Number(value);
  for (const button of document.querySelectorAll('#concurrency-options button')) {
    const selected = Number(button.dataset.value) === settings.concurrency;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  scheduler?.setConcurrency(settings.concurrency);
}

function aheadText() {
  $('ahead-label').textContent = `预加载窗口 · ${settings.ahead >= 60 ? `${settings.ahead / 60} 分钟` : `${settings.ahead} 秒`}`;
}

function plan() {
  if (!scheduler || fatal) return;
  const position = video.currentTime;
  const items = [];
  for (const details of [videoDetails, audioDetails]) {
    for (const frag of details?.fragments || []) {
      if (frag.gap || frag.start + frag.duration <= position || frag.start > position + settings.ahead) continue;
      const item = fragmentDescriptor(frag);
      if (!item) continue;
      if (frag.initSegment) {
        const init = fragmentDescriptor(frag.initSegment);
        if (init) items.push({ ...init, start: frag.start - 0.01 });
      }
      items.push(item);
    }
  }
  // Interleave audio and video in playback order; do not starve an alternate audio track.
  const unique = new Map(items.sort((a, b) => a.start - b.start).map(item => [segmentKey(item), item]));
  // Leave space for recently played segments and in-flight downloads. A five-minute
  // window at high bitrates must not continually evict and re-download itself.
  const candidates = [...unique.values()].slice(0, 500);
  const bitrate = hls?.levels[selectedLevel]?.bitrate || 5_000_000;
  let actualBytesPerSecond = bitrate / 8;
  for (const item of candidates) {
    const size = cache.entries.get(segmentKey(item))?.size;
    if (size && item.duration) actualBytesPerSecond = Math.max(actualBytesPerSecond, size / item.duration);
  }
  let estimated = 0;
  planned = [];
  for (const item of candidates) {
    const size = cache.entries.get(segmentKey(item))?.size || (item.range ? item.range[1] - item.range[0] : Math.max(128 * 1024, item.duration * actualBytesPerSecond * 1.25));
    if (estimated + size > cache.capacity * 0.7 && planned.length) break;
    estimated += size;
    planned.push(item);
  }
  if (settings.prefetch) scheduler.plan(planned);
  else scheduler.cancelPrefetch();
}

function bufferedAhead() {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) >= video.currentTime) return video.buffered.end(i) - video.currentTime;
  }
  return 0;
}

function cachedAheadFor(details) {
  if (!details) return Infinity;
  let end = video.currentTime;
  for (const frag of details.fragments) {
    if (frag.start + frag.duration <= video.currentTime) continue;
    if (frag.start > end + 0.5 || frag.gap) break;
    const item = fragmentDescriptor(frag);
    if (!item || !cache.has(segmentKey(item))) break;
    if (frag.initSegment) {
      const init = fragmentDescriptor(frag.initSegment);
      if (init && !cache.has(segmentKey(init))) break;
    }
    end = frag.start + frag.duration;
  }
  return Math.max(0, end - video.currentTime);
}

function updateStats() {
  if (!scheduler) return;
  const speed = scheduler.speed;
  const formatted = bytes(speed).split(' ');
  $('speed').replaceChildren(document.createTextNode(formatted[0]));
  const unit = document.createElement('span'); unit.textContent = `${formatted[1]}/s`; $('speed').append(unit);
  speeds.push(speed); speeds.shift();
  const max = Math.max(...speeds, 1);
  document.querySelectorAll('.speed-bars i').forEach((bar, i) => { bar.style.height = `${Math.max(3, speeds[i] / max * 29)}px`; });
  $('active-count').textContent = `${scheduler.active} / ${settings.concurrency}`;
  $('buffered').firstChild.textContent = Math.floor(bufferedAhead());
  const continuous = Math.min(cachedAheadFor(videoDetails), cachedAheadFor(audioDetails));
  $('cached-ahead').firstChild.textContent = Number.isFinite(continuous) ? Math.floor(continuous) : 0;
  $('cache-size').textContent = bytes(cache.bytes);
  $('storage-progress').value = cache.bytes;
  $('cache-mode').textContent = cache.mode === 'disk' ? '磁盘 · IndexedDB' : '内存 · 32 MB 上限';
  $('storage-progress').max = cache.capacity;
  document.querySelector('.storage-amount > span').textContent = ` / ${bytes(cache.capacity)}`;
  $('downloaded').textContent = `已接收 ${bytes(scheduler.transferred)}`;
  $('cache-hits').textContent = scheduler.hits;
  $('stalls').textContent = stalled;
  const map = $('segment-map');
  map.replaceChildren();
  const visible = planned.filter(item => item.duration > 0);
  const groups = Math.min(visible.length || 32, 64);
  for (let i = 0; i < groups; i++) {
    const group = visible.slice(Math.floor(i * visible.length / groups), Math.floor((i + 1) * visible.length / groups));
    const bar = document.createElement('span');
    const ready = group.length && group.every(item => cache.has(segmentKey(item)));
    const loading = group.some(item => scheduler.jobs.get(segmentKey(item))?.active);
    bar.className = `segment ${ready ? 'ready' : loading ? 'loading' : ''}`;
    if (group.length) bar.title = `${clock(group[0].start)} · ${ready ? '已缓存' : loading ? '下载中' : '待下载'}`;
    map.append(bar);
  }
  const count = visible.filter(item => cache.has(segmentKey(item))).length;
  $('cache-summary').textContent = visible.length ? `${count} / ${visible.length} 个分片` : '等待播放列表';
}

function syncAudioOptions() {
  const tracks = hls.audioTracks;
  $('audio-field').hidden = tracks.length < 2;
  $('audio').replaceChildren(...tracks.map((track, index) => new Option(track.name || track.lang || `音轨 ${index + 1}`, index)));
  $('audio').value = String(hls.audioTrack);
}

async function start(startPosition = -1) {
  fatal = false;
  $('error-panel').hidden = true;
  $('video-placeholder').hidden = false;
  $('placeholder-title').textContent = '正在连接视频源';
  $('placeholder-detail').textContent = '为接下来的播放，提前准备。';
  state('连接中');
  hls?.destroy();
  scheduler?.close();
  videoDetails = audioDetails = undefined;
  planned = []; hasPlayed = waiting = false;
  const headers = url => source.authorization && new URL(url).origin === new URL(source.url).origin ? { Authorization: source.authorization } : {};
  scheduler = new SegmentScheduler(cache, { concurrency: settings.concurrency, headers });
  if (!Hls.isSupported()) { showError('当前浏览器不支持此播放引擎，请使用较新版本的 Chrome 或 Edge。'); return; }
  const instance = hls = new Hls({
    autoStartLoad: false,
    enableWorker: true,
    workerPath: chrome.runtime.getURL('vendor/hls.worker.js'),
    fLoader: createFragmentLoader(scheduler),
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    maxBufferSize: 40 * 1024 * 1024,
    backBufferLength: 30,
    lowLatencyMode: false,
    xhrSetup(xhr, url) {
      xhr.withCredentials = true;
      for (const [name, value] of Object.entries(headers(url))) xhr.setRequestHeader(name, value);
    },
  });
  let recoveries = 0;
  instance.on(Hls.Events.MEDIA_ATTACHED, () => instance.loadSource(source.url));
  instance.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    // Fix the rendition explicitly: cache-hit latency is not a bandwidth estimate.
    const choices = data.levels.map((level, index) => ({ level, index }));
    const preferred = choices.filter(({ level }) => !level.height || level.height <= 720).sort((a, b) => b.level.bitrate - a.level.bitrate)[0] || choices[0];
    selectedLevel = preferred?.index || 0;
    $('quality').replaceChildren(...choices.map(({ level, index }) => new Option(`${level.height ? `${level.height}p` : '原始画质'}${level.bitrate ? ` · ${(level.bitrate / 1e6).toFixed(1)} Mbps` : ''}`, index)));
    $('quality').disabled = choices.length < 2;
    $('quality').value = String(selectedLevel);
    instance.startLevel = selectedLevel;
    instance.loadLevel = selectedLevel;
    instance.startLoad(startPosition);
    state('正在缓冲');
    syncAudioOptions();
    video.play().catch(() => { if (!fatal) toast('视频已准备，点击播放按钮开始观看。'); });
  });
  instance.on(Hls.Events.LEVEL_LOADED, (_, data) => {
    if (data.level !== selectedLevel) return;
    videoDetails = data.details;
    $('stream-type').textContent = data.details.live ? 'LIVE · 直播' : 'HLS · 点播';
    plan();
  });
  instance.on(Hls.Events.AUDIO_TRACK_LOADED, (_, data) => {
    if (data.id === instance.audioTrack) { audioDetails = data.details; plan(); }
  });
  instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudioOptions);
  instance.on(Hls.Events.AUDIO_TRACK_SWITCHING, () => { audioDetails = undefined; scheduler.cancelPrefetch(); });
  instance.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 2) { instance.recoverMediaError(); return; }
    instance.stopLoad();
    let message = '视频源连接失败。请返回原网页刷新视频，再从插件重新打开；也可以降低并发数后重试。';
    const code = data.response?.code;
    if ([401, 403, 410].includes(code)) message = `视频源拒绝访问（HTTP ${code}）。链接可能已过期，或需要原网站的登录状态，请返回原网页重新打开视频。`;
    else if (code === 404) message = '视频地址不存在（HTTP 404），请检查地址或从原网页重新捕获。';
    else if (/manifestParsing|manifestIncompatible|codec|keySystem/i.test(data.details)) message = '这个视频源的格式、编码或授权方式暂不受支持。第一版面向普通 HLS 点播与直播，不支持 DRM 授权视频。';
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) message = '浏览器无法解码这个视频，请尝试其他画质或视频源。';
    showError(message);
  });
  instance.attachMedia(video);
}

async function init() {
  document.querySelector('.speed-bars').replaceChildren(...speeds.map(() => document.createElement('i')));
  const stored = (await chrome.storage.local.get('settings')).settings;
  if (stored) {
    if ([1, 2, 4, 6, 8].includes(stored.concurrency)) settings.concurrency = stored.concurrency;
    if ([30, 120, 300].includes(stored.ahead)) settings.ahead = stored.ahead;
    if (typeof stored.prefetch === 'boolean') settings.prefetch = stored.prefetch;
  }
  setConcurrency(settings.concurrency);
  $('ahead').value = settings.ahead;
  $('prefetch').checked = settings.prefetch;
  aheadText();
  if (!sessionId) { showError('请点击浏览器工具栏中的 VPlayer，从发现的视频列表打开，或粘贴 m3u8 地址。'); return; }
  const prepared = await chrome.runtime.sendMessage({ type: 'PREPARE_PLAYER', sessionId });
  if (!prepared.ok) throw new Error(prepared.error);
  source = prepared.source;
  episodeControls.setSource(source);
  $('video-title').textContent = source.title || '网页视频';
  document.title = `${source.title || '视频'} · VPlayer`;
  $('source-host').textContent = new URL(source.url).hostname;
  cache = new SegmentCache(source.cacheId || sessionId);
  await cache.init();
  await start();
}

document.querySelectorAll('#concurrency-options button').forEach(button => button.addEventListener('click', () => {
  setConcurrency(button.dataset.value); saveSettings(); updateStats();
}));
$('ahead').addEventListener('change', () => { settings.ahead = Number($('ahead').value); aheadText(); saveSettings(); plan(); });
$('prefetch').addEventListener('change', () => { settings.prefetch = $('prefetch').checked; saveSettings(); plan(); });
$('quality').addEventListener('change', () => {
  if (!hls) return;
  selectedLevel = Number($('quality').value);
  videoDetails = undefined; planned = [];
  scheduler.cancelPrefetch();
  hls.currentLevel = selectedLevel;
  toast('正在切换画质，重新准备后续分片。');
});
$('audio').addEventListener('change', () => { if (hls) hls.audioTrack = Number($('audio').value); });
$('retry').addEventListener('click', async () => {
  if (!source || !cache || retrying) return;
  retrying = true;
  try { await start(); } catch (error) { showError(error.message); } finally { retrying = false; }
});
$('copy-url').addEventListener('click', async () => {
  if (!source) return;
  try { await navigator.clipboard.writeText(source.url); toast('视频地址已复制'); } catch { toast('复制失败，请检查浏览器的剪贴板权限。'); }
});
$('clear-cache').addEventListener('click', async () => {
  if (!cache) return;
  $('clear-cache').disabled = true;
  const enabled = settings.prefetch;
  settings.prefetch = false;
  scheduler?.cancelPrefetch();
  try { await cache.clear(); toast('已清除本视频缓存；播放所需内容会继续下载。'); }
  catch { toast('缓存暂时无法清除，请稍后重试。'); }
  finally { settings.prefetch = enabled; $('clear-cache').disabled = false; plan(); updateStats(); }
});
video.addEventListener('loadeddata', () => { $('video-placeholder').hidden = true; });
video.addEventListener('playing', () => { hasPlayed = true; waiting = false; if (!fatal) state('流畅播放中'); });
video.addEventListener('waiting', () => {
  if (hasPlayed && !video.seeking && !video.paused && !waiting) { stalled++; waiting = true; }
  if (!fatal) state('正在缓冲');
});
video.addEventListener('pause', () => { if (!fatal) state('已暂停'); });
video.addEventListener('ended', () => { if (!fatal) state('播放完成'); scheduler?.cancelPrefetch(); });
video.addEventListener('seeking', () => { waiting = false; scheduler?.cancelPrefetch(); plan(); });
video.addEventListener('seeked', () => { if (!fatal) state(video.paused ? '已暂停' : '流畅播放中'); });
window.addEventListener('pagehide', () => { scheduler?.close(); hls?.destroy(); });
setInterval(() => { if (!video.ended) plan(); updateStats(); }, 1000);
init().catch(error => showError(error.message));
