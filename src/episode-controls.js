export function createEpisodeControls({ sessionId, onSwitch, getPosition }) {
  const $ = id => document.getElementById(id);
  let source, shownGroupId, busy = false, attempt = 0, pendingEpisodeId;
  const activeGroup = () => source?.catalog?.groups.find(g => g.id === source.catalog.currentGroupId);
  const activeEpisode = () => activeGroup()?.episodes.find(e => e.id === source.catalog.currentEpisodeId);
  function nextEpisode() {
    const group = activeGroup();
    const index = group?.episodes.findIndex(e => e.id === source.catalog.currentEpisodeId) ?? -1;
    return index < 0 ? undefined : group.episodes[index + 1];
  }
  function status(message, error = false) {
    $('episode-status').textContent = message;
    $('episode-status').classList.toggle('error', error);
  }
  function render() {
    const catalog = source?.catalog;
    const groups = catalog?.groups || [];
    $('episode-controls').hidden = !groups.length;
    $('episodes-panel').classList.toggle('busy', busy);
    $('cancel-episode').hidden = !busy;
    $('cancel-episode').disabled = false;
    $('refresh-episodes').disabled = busy || !(Number.isInteger(source?.sourceTabId) || /^https?:\/\//.test(source?.pageUrl || ''));
    $('episode-source').replaceChildren(...groups.map(g => new Option(`${g.label}${g.episodes.length ? ` · ${g.episodes.length} 集` : ''}`, g.id)));
    if (!groups.some(g => g.id === shownGroupId)) shownGroupId = catalog?.currentGroupId || groups[0]?.id;
    $('episode-source').value = shownGroupId || '';
    $('episode-source').disabled = busy;
    const shown = groups.find(g => g.id === shownGroupId);
    $('episode-count').textContent = shown?.episodes.length ? `${shown.episodes.length} 集` : '';
    $('episode-list').replaceChildren(...(shown?.episodes || []).map(episode => {
      const button = document.createElement('button');
      const current = shown.id === catalog.currentGroupId && episode.id === catalog.currentEpisodeId;
      button.className = `episode-button${current ? ' current' : ''}${busy && episode.id === pendingEpisodeId ? ' pending' : ''}`;
      button.textContent = episode.label;
      button.title = `${shown.label} · ${episode.label}`;
      button.setAttribute('aria-pressed', String(current));
      button.disabled = busy;
      button.addEventListener('click', () => switchTo(shown.id, episode));
      return button;
    }));
    const active = activeGroup();
    const index = active?.episodes.findIndex(e => e.id === catalog.currentEpisodeId) ?? -1;
    $('previous-episode').disabled = busy || index <= 0;
    $('next-episode').disabled = busy || index < 0 || index >= active.episodes.length - 1;
    const pageUrl = source?.pageUrl;
    $('episode-page').hidden = !pageUrl || !/^https?:\/\//.test(pageUrl);
    if (!$('episode-page').hidden) $('episode-page').href = pageUrl;
  }
  async function switchTo(groupId, episode, key = episode?.key) {
    if (busy || !source) return;
    const current = activeEpisode();
    if (groupId === activeGroup()?.id && episode?.id === current?.id) return;
    const ticket = ++attempt;
    const group = source.catalog.groups.find(g => g.id === groupId);
    busy = true; pendingEpisodeId = episode?.id;
    status(`正在后台读取 ${group.label} · ${episode?.label || (key ? `第${key}集` : '当前集')}…`);
    render();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SWITCH_EPISODE', sessionId, selection: { groupId, episodeId: episode?.id, episodeKey: key } });
      if (ticket !== attempt) return;
      if (!result.ok) throw new Error(result.error);
      $('cancel-episode').hidden = true;
      const resumeAt = current?.key === key ? getPosition() : -1;
      await onSwitch(result.source, resumeAt);
      source = result.source;
      shownGroupId = source.catalog.currentGroupId;
      status(`正在播放 ${source.sourceLabel} · ${source.episodeLabel}`);
    } catch (error) {
      if (ticket === attempt) status(`${error.message} 当前视频保持不变。`, true);
    } finally {
      if (ticket === attempt) { busy = false; pendingEpisodeId = undefined; render(); }
    }
  }
  $('episode-source').addEventListener('change', () => {
    shownGroupId = $('episode-source').value;
    const group = source.catalog.groups.find(g => g.id === shownGroupId);
    const current = activeEpisode();
    render();
    if (shownGroupId === activeGroup()?.id) return;
    const match = group.episodes.find(e => e.key === current?.key);
    if (match) switchTo(group.id, match);
    else if (group.action && !group.episodes.length) switchTo(group.id, undefined, current?.key);
    else status(`这条线路没有${current?.label || '当前集'}，请在列表中选择要播放的集数。`);
  });
  for (const [id, direction] of [['previous-episode', -1], ['next-episode', 1]]) {
    $(id).addEventListener('click', () => {
      const group = activeGroup();
      const index = group?.episodes.findIndex(e => e.id === source.catalog.currentEpisodeId) ?? -1;
      const episode = group?.episodes[index + direction];
      if (episode) { shownGroupId = group.id; switchTo(group.id, episode); }
    });
  }
  $('cancel-episode').addEventListener('click', async () => {
    ++attempt;
    $('cancel-episode').disabled = true;
    status('正在取消切换…');
    try { await chrome.runtime.sendMessage({ type: 'CANCEL_EPISODE', sessionId }); }
    finally { busy = false; pendingEpisodeId = undefined; render(); status('已取消切换，继续播放当前视频。'); }
  });
  $('refresh-episodes').addEventListener('click', async () => {
    $('refresh-episodes').disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'REFRESH_EPISODES', sessionId });
      if (!result.ok) throw new Error(result.error);
      source.catalog = result.catalog;
      source.sourceTabId = result.sourceTabId ?? source.sourceTabId;
      source.catalogError = '';
      shownGroupId = source.catalog.currentGroupId;
      status('选集列表已更新。');
    } catch (error) { status(error.message, true); }
    finally { render(); }
  });
  return {
    isBusy: () => busy,
    hasNext: () => Boolean(nextEpisode()),
    async playNext() {
      const episode = nextEpisode();
      if (busy || !episode) return;
      shownGroupId = activeGroup().id;
      await switchTo(shownGroupId, episode);
    },
    setSource(value) {
      source = value;
      shownGroupId = source?.catalog?.currentGroupId;
      render();
      const episode = activeEpisode();
      if (source?.catalog?.groups.length) status(`当前 ${activeGroup()?.label || ''}${episode ? ` · ${episode.label}` : ''}，换源会优先匹配同一集。`);
      else if (source?.catalogError) status(source.catalogError, true);
      else status(source?.pageUrl ? '暂未读取到原网页选集，请点击刷新列表。' : '此视频没有附带原网页信息，请从原网页的视频列表打开以使用选集。');
    },
  };
}
