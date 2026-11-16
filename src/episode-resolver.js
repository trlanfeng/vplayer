import { httpUrl } from './common.js';
import { scanEpisodePage, inspectPlaybackPage, applyEpisodeAction } from './episodes.js';

const operations = new Map();
const cancelled = () => new Error('已取消切换，继续播放当前视频。');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const resolverKey = id => `resolver:${id}`;

export async function readEpisodeCatalog(tabId) {
  if (!Number.isInteger(tabId)) return null;
  // The episode list usually lives in the top document. An unrelated/inaccessible
  // subframe must not prevent us from reading that document.
  const main = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: scanEpisodePage });
  if (main[0]?.result?.groups.length) return { ...main[0].result, frameId: 0 };
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanEpisodePage });
  const useful = results.filter(r => r.result?.groups.length);
  const chosen = useful.find(r => r.frameId === 0) || useful.sort((a, b) => b.result.groups.length - a.result.groups.length)[0];
  return chosen ? { ...chosen.result, frameId: chosen.frameId } : null;
}

export async function findSourceTabId(source) {
  const pageUrl = httpUrl(source.pageUrl);
  if (Number.isInteger(source.sourceTabId)) {
    try {
      const tab = await chrome.tabs.get(source.sourceTabId);
      if (httpUrl(tab.url) && (!pageUrl || httpUrl(tab.url) === pageUrl)) return tab.id;
    } catch {}
  }
  // Older player sessions contain pageUrl, but no sourceTabId. Associate only a
  // matching page (or a tab on that site that actually requested this media).
  if (!pageUrl || pageUrl === httpUrl(source.url)) return null;
  const tabs = await chrome.tabs.query({ url: `${new URL(pageUrl).origin}/*` });
  const stored = await chrome.storage.session.get(tabs.map(tab => `sources:${tab.id}`));
  const exact = tabs.filter(tab => httpUrl(tab.url) === pageUrl);
  const requestedMedia = tab => stored[`sources:${tab.id}`]?.some(item => item.url === source.url || item.originalUrl === source.url);
  return (exact.find(requestedMedia) || exact[0] || tabs.find(requestedMedia))?.id ?? null;
}

export async function hydrateEpisodeContext(source) {
  const next = { ...source };
  try {
    const tabId = await findSourceTabId(source);
    if (!Number.isInteger(tabId)) {
      next.catalogError = httpUrl(source.pageUrl) ? '没有找到对应的原网页标签页。请打开原网页，再点击刷新列表。' : '';
      return next;
    }
    next.sourceTabId = tabId;
    next.catalog = await readEpisodeCatalog(tabId);
    next.catalogError = next.catalog ? '' : '原网页暂未提供可识别的选集。请等网页加载完成后点击刷新列表。';
    if (next.catalog) next.pageUrl = next.catalog.pageUrl;
  } catch {
    next.catalogError = '读取原网页失败，请确认扩展允许访问该网站，然后点击刷新列表重试。';
  }
  return next;
}

export async function cancelEpisodeResolution(sessionId) {
  const operation = operations.get(sessionId);
  if (operation) operation.cancelled = true;
  const key = resolverKey(sessionId);
  const tabId = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  if (Number.isInteger(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
  if (operation) await operation.finished;
}

export async function refreshEpisodeCatalog(source, sessionId) {
  const tabId = (await chrome.storage.session.get(resolverKey(sessionId)))[resolverKey(sessionId)];
  const recoveredId = await findSourceTabId(source);
  if (Number.isInteger(recoveredId)) source.sourceTabId = recoveredId;
  for (const id of [tabId, recoveredId]) {
    try {
      const catalog = await readEpisodeCatalog(id);
      if (catalog) return catalog;
    } catch {}
  }
  throw new Error('无法读取选集。请打开对应的已登录原网页，并确认扩展有访问权限，再点击刷新列表。');
}

export async function resolveEpisode(sessionId, source, selection, isCancelled = () => false) {
  if (operations.has(sessionId)) throw new Error('正在切换，请稍候或先取消。');
  const group = source.catalog?.groups.find(g => g.id === selection.groupId);
  if (!group) throw new Error('没有找到这条线路，请刷新选集。');
  const requested = selection.episodeId ? group.episodes.find(e => e.id === selection.episodeId) : group.episodes.find(e => e.key === selection.episodeKey);
  if (!requested && !group.action) throw new Error('这条线路没有当前集，请在列表中选择其他集数。');
  const operation = { cancelled: false };
  operation.finished = new Promise(resolve => { operation.finish = resolve; });
  operations.set(sessionId, operation);
  let tabId, initialNavigation;
  const deadline = Date.now() + 45000;
  const check = () => {
    if (operation.cancelled || isCancelled() || operations.get(sessionId) !== operation) throw cancelled();
    if (Date.now() > deadline) throw new Error('获取视频超时。原网站可能需要登录、验证或手动播放；可打开原网页检查后重试。');
  };
  const inject = async (func, args = [], frameId) => {
    check();
    return chrome.scripting.executeScript({ target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] }, func, args });
  };
  const waitForPage = async (url, previousDocument) => {
    for (;;) {
      check();
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!previousDocument && tab.status === 'complete' && (!url || tab.url === url)) return;
        // DOM-ready is sufficient; third-party assets may keep the load event pending.
        const rows = await inject(() => ({ ready: document.readyState !== 'loading', url: location.href, marker: globalThis.__vplayerNavigationMarker }), [], 0);
        if (rows[0]?.result.ready && (!previousDocument || rows[0].result.marker !== previousDocument) && (!url || rows[0].result.url === url)) return;
      } catch (error) { if (operation.cancelled) throw error; }
      await sleep(250);
    }
  };
  let navigationTime = Date.now();
  const navigate = async url => {
    check();
    if (!httpUrl(url)) throw new Error('无效的选集链接。');
    if (initialNavigation === url) {
      initialNavigation = undefined;
      await waitForPage(url);
      return;
    }
    await chrome.storage.session.remove(`sources:${tabId}`);
    navigationTime = Date.now();
    const marker = crypto.randomUUID();
    await inject(value => { globalThis.__vplayerNavigationMarker = value; }, [marker], 0).catch(() => {});
    await chrome.tabs.update(tabId, { url });
    await waitForPage(url, marker);
  };
  try {
    const savedTab = (await chrome.storage.session.get(resolverKey(sessionId)))[resolverKey(sessionId)];
    if (Number.isInteger(savedTab)) {
      try { await chrome.tabs.get(savedTab); tabId = savedTab; } catch {}
    }
    if (!Number.isInteger(tabId)) {
      // Navigate at creation, rather than racing a new tab's initial blank document.
      const action = requested?.action || group.action;
      initialNavigation = httpUrl(action?.url || action?.pageUrl || source.catalog.pageUrl);
      if (!initialNavigation) throw new Error('没有找到原网页地址，请刷新选集列表。');
      navigationTime = Date.now();
      const tab = await chrome.tabs.create({ url: initialNavigation, active: false });
      tabId = tab.id;
      await chrome.tabs.update(tabId, { muted: true });
      await chrome.storage.session.set({ [resolverKey(sessionId)]: tabId });
    }
    let episode = requested;
    let catalog;
    if (!episode && group.action) {
      await navigate(group.action.pageUrl || source.catalog.pageUrl);
      const before = await readEpisodeCatalog(tabId);
      const beforeGroup = before?.groups.find(g => g.id === before.currentGroupId);
      const beforeLinks = JSON.stringify(beforeGroup?.episodes.map(e => e.action.url || e.action.selector));
      await inject(applyEpisodeAction, [group.action], source.catalog.frameId || 0).catch(error => {
        // A successful onchange navigation can destroy the execution frame before
        // executeScript returns. The new catalog below confirms whether it worked.
        if (!/frame.*(?:removed|closed)|context.*destroyed/i.test(error.message)) throw error;
      });
      // A source control may navigate, or replace the episode list in place.
      for (;;) {
        check();
        try {
          catalog = await readEpisodeCatalog(tabId);
          const selected = catalog?.groups.find(g => g.id === catalog.currentGroupId);
          const changed = catalog?.pageUrl !== before?.pageUrl || JSON.stringify(selected?.episodes.map(e => e.action.url || e.action.selector)) !== beforeLinks;
          // Setting a select value updates the old DOM before its navigation finishes.
          // Wait for the new source's page/list, or we'd follow the previous source's links.
          if (selected && changed && (selected.id === group.id || selected.label === group.label)) {
            episode = selected.episodes.find(e => e.key === selection.episodeKey);
            if (!episode) throw Object.assign(new Error('这条线路没有当前集，请选择其他线路。'), { missingEpisode: true });
            break;
          }
        } catch (error) { if (error.missingEpisode) throw error; }
        await sleep(300);
      }
    }
    if (episode.action.kind === 'navigate') await navigate(episode.action.url);
    else {
      await navigate(episode.action.pageUrl);
      await chrome.storage.session.remove(`sources:${tabId}`);
      navigationTime = Date.now();
      await inject(applyEpisodeAction, [episode.action], catalog?.frameId || source.catalog.frameId || 0);
    }
    let candidate, latestCatalog, lastHints = [], firstCandidateAt = 0;
    for (;;) {
      check();
      try {
        const rows = await inject(inspectPlaybackPage, [{ nudge: true }]);
        lastHints = rows.flatMap(row => row.result?.urls || []);
        latestCatalog = await readEpisodeCatalog(tabId) || latestCatalog;
        const sources = (await chrome.storage.session.get(`sources:${tabId}`))[`sources:${tabId}`] || [];
        const fresh = sources.filter(s => (s.requestedAt || s.detectedAt) >= navigationTime && s.statusCode >= 200 && s.statusCode < 400);
        candidate = fresh.find(s => lastHints.includes(s.url) || lastHints.includes(s.originalUrl));
        if (candidate) break;
        if (fresh.length) {
          firstCandidateAt ||= Date.now();
          // Prefer the prior media host if a site also requests an unrelated HLS ad.
          candidate = fresh.findLast(s => new URL(s.url).hostname === new URL(source.url).hostname) || fresh.at(-1);
          if (!lastHints.length && Date.now() - firstCandidateAt > 1200) break;
        }
      } catch (error) { if (operation.cancelled) throw error; }
      await sleep(350);
    }
    check();
    await inject(inspectPlaybackPage, [{ pause: true }]).catch(() => {});
    const nextCatalog = structuredClone(latestCatalog || catalog || source.catalog);
    let nextGroup = nextCatalog.groups.find(g => g.id === nextCatalog.currentGroupId) || nextCatalog.groups.find(g => g.id === group.id);
    if (!nextGroup) nextGroup = group;
    const selectedEpisode = nextGroup.episodes.find(e => e.key === episode.key) || episode;
    nextCatalog.currentGroupId = nextGroup.id;
    nextCatalog.currentEpisodeId = selectedEpisode.id;
    const nextSource = {
      ...candidate,
      title: `${nextCatalog.title || source.catalog.title || '网页视频'} · ${selectedEpisode.label}`,
      pageUrl: nextCatalog.pageUrl,
      sourceTabId: source.sourceTabId,
      catalog: nextCatalog,
      cacheId: crypto.randomUUID(),
      episodeLabel: selectedEpisode.label,
      sourceLabel: nextGroup.label,
      createdAt: Date.now(),
    };
    // The caller installs headers and commits this source only after cancellation is checked.
    return nextSource;
  } catch (error) {
    if (Number.isInteger(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
    await chrome.storage.session.remove(resolverKey(sessionId));
    throw error;
  } finally {
    if (operations.get(sessionId) === operation) operations.delete(sessionId);
    operation.finish();
  }
}
