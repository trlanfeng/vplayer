import { clock } from './common.js';

export function skipBounds(duration, intro, outro) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const start = Number.isFinite(intro) && intro > 0 && intro < duration ? intro : 0;
  const end = Number.isFinite(outro) && outro > 0 && outro < duration ? duration - outro : duration;
  // Different edits and short specials must never be skipped in their entirety.
  return { start, end: end > start ? end : duration };
}

export function createSkipControls({ video, sessionId, episodes, toast }) {
  const $ = id => document.getElementById(id);
  const key = `skip:${sessionId}`;
  let intro = 0, outro = 0, enabled = true;
  let live, metadata = false, introDone = false, advanced = false;
  let saving = Promise.resolve();
  const ready = () => metadata && live === false && Number.isFinite(video.duration) && video.duration > 0;

  function render() {
    $('auto-skip').checked = enabled;
    $('mark-intro').disabled = $('mark-outro').disabled = !ready();
    $('clear-skip').disabled = !intro && !outro;
    $('mark-intro').textContent = intro ? `片头 ${clock(intro)}` : '片头';
    $('mark-outro').textContent = outro ? `片尾 ${clock(outro)}` : '片尾';
    $('mark-intro').title = `${intro ? `片头跳至 ${clock(intro)}。` : ''}在片头结束处点击，后续剧集自动跳过片头`;
    $('mark-outro').title = `${outro ? `片尾跳过最后 ${clock(outro)}。` : ''}在片尾开始处点击，自动跳过片尾并播放下一集`;
    const marks = `${intro ? `片头跳至 ${clock(intro)}` : '片头未标记'} · ${outro ? `片尾跳过最后 ${clock(outro)}` : '片尾未标记'}`;
    $('skip-status').textContent = `${marks}${live === true ? ' · 直播不支持跳过' : enabled ? '' : ' · 自动跳过与连播已关闭'}`;
  }

  function save() {
    const value = { intro, outro, enabled };
    saving = saving.then(() => chrome.storage.session.set({ [key]: value })).catch(() => {
      toast('标记暂时无法保存，刷新后需要重新标记。');
    });
  }

  function advance(fromOutro) {
    if (advanced || episodes.isBusy()) return;
    advanced = true;
    if (fromOutro) video.pause();
    if (!episodes.hasNext()) {
      if (fromOutro) toast('已跳过片尾，当前线路没有下一集。');
      return;
    }
    toast(fromOutro ? '已跳过片尾，正在读取下一集…' : '播放完成，正在读取下一集…');
    // One attempt per playback prevents timeupdate/ended from repeating a failed
    // or cancelled resolution. The existing episode UI offers manual retry.
    void episodes.playNext().catch(() => toast('自动连播失败，请点击下一集重试。'));
  }

  function check(force = false) {
    if (!enabled || !ready() || episodes.isBusy() || video.seeking || (video.paused && !force)) return;
    const bounds = skipBounds(video.duration, intro, outro);
    if (!introDone) {
      introDone = true;
      if (video.currentTime < bounds.start) {
        video.currentTime = bounds.start;
        toast(`已跳过片头，从 ${clock(bounds.start)} 开始播放。`);
        return;
      }
    }
    if (bounds.end < video.duration && video.currentTime >= bounds.end) advance(true);
  }

  function mark(kind) {
    if (!ready()) return;
    const position = video.currentTime;
    if (!Number.isFinite(position) || position <= 0 || position >= video.duration) {
      toast('请先将进度移到片头结束或片尾开始的位置。');
      return;
    }
    if ((kind === 'intro' && outro > 0 && position >= video.duration - outro) ||
        (kind === 'outro' && position <= intro)) {
      toast('片头结束位置必须早于片尾开始位置，请清除标记后重试。');
      return;
    }
    if (kind === 'intro') { intro = position; introDone = true; }
    else outro = video.duration - position;
    enabled = true;
    advanced = false;
    render(); save();
    toast(kind === 'intro' ? `已标记片头：${clock(intro)}` : `已标记片尾：最后 ${clock(outro)}`);
    check(true);
  }

  $('mark-intro').addEventListener('click', () => mark('intro'));
  $('mark-outro').addEventListener('click', () => mark('outro'));
  $('clear-skip').addEventListener('click', () => {
    intro = outro = 0;
    render(); save();
    toast('已清除片头片尾标记。');
  });
  $('auto-skip').addEventListener('change', () => {
    enabled = $('auto-skip').checked;
    introDone = false; advanced = false;
    render(); save(); check();
  });
  video.addEventListener('loadedmetadata', () => { metadata = true; render(); check(); });
  video.addEventListener('durationchange', () => { render(); check(); });
  for (const event of ['timeupdate', 'playing', 'seeked']) video.addEventListener(event, () => check());
  video.addEventListener('ended', () => { if (enabled && ready()) advance(false); });

  return {
    async init() {
      if (sessionId) {
        try {
          const stored = (await chrome.storage.session.get(key))[key];
          if (stored) {
            intro = Number.isFinite(stored.intro) && stored.intro > 0 ? stored.intro : 0;
            outro = Number.isFinite(stored.outro) && stored.outro > 0 ? stored.outro : 0;
            enabled = stored.enabled !== false;
          }
        } catch { toast('暂时无法读取已保存的片头片尾标记。'); }
      }
      render();
    },
    reset(startPosition = -1) {
      live = undefined; metadata = false;
      introDone = startPosition >= 0; advanced = false;
      render();
    },
    setLive(value) { live = value; render(); check(); },
  };
}
