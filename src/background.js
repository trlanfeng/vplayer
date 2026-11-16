import { httpUrl, isPlaylist } from './common.js';
import { hydrateEpisodeContext, refreshEpisodeCatalog, resolveEpisode, cancelEpisodeResolution } from './episode-resolver.js';

const requestInfo = new Map();
const writes = new Map();
const episodeRequests = new Map();
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
const sourceKey = tabId => `sources:${tabId}`;

function serialized(tabId, work) {
  const prior = writes.get(tabId) || Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  writes.set(tabId, next);
  next.finally(() => { if (writes.get(tabId) === next) writes.delete(tabId); }).catch(() => {});
  return next;
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0 || details.type !== 'main_frame') return;
  serialized(details.tabId, async () => {
    await chrome.storage.session.remove(sourceKey(details.tabId));
    await chrome.action.setBadgeText({ tabId: details.tabId, text: '' }).catch(() => {});
  }).catch(() => {});
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] });

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (details.tabId < 0 || details.initiator === extensionOrigin) return;
  const headers = Object.fromEntries((details.requestHeaders || []).map(h => [h.name.toLowerCase(), h.value]));
  requestInfo.set(details.requestId, {
    referer: headers.referer || '', origin: headers.origin || '', authorization: headers.authorization || '',
    requestedAt: requestInfo.get(details.requestId)?.requestedAt || details.timeStamp,
    originalUrl: requestInfo.get(details.requestId)?.originalUrl || details.url,
  });
  if (requestInfo.size > 500) requestInfo.delete(requestInfo.keys().next().value);
}, { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest', 'media', 'other'] }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.initiator === extensionOrigin) return;
  const type = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  if (!isPlaylist(details.url, type)) return;
  const context = requestInfo.get(details.requestId) || {};
  serialized(details.tabId, async () => {
    const key = sourceKey(details.tabId);
    const stored = (await chrome.storage.session.get(key))[key] || [];
    const source = {
      url: details.url, ...context, detectedAt: Date.now(),
      pageUrl: context.referer || details.initiator || '',
      frameId: details.frameId, statusCode: details.statusCode,
    };
    const list = [source, ...stored.filter(s => s.url !== source.url)].slice(0, 40);
    await chrome.storage.session.set({ [key]: list });
    await chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: '#9bea78' }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: details.tabId, text: String(list.length) }).catch(() => {});
  }).catch(() => {});
}, { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);

for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  event.addListener(details => requestInfo.delete(details.requestId), { urls: ['http://*/*', 'https://*/*'] });
}

async function configureHeaders(tabId, source) {
  const headers = [];
  if (httpUrl(source.referer)) headers.push({ header: 'referer', operation: 'set', value: source.referer });
  if (source.origin && httpUrl(source.origin)) headers.push({ header: 'origin', operation: 'set', value: source.origin });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId + 1],
    addRules: headers.length ? [{
      id: tabId + 1, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { tabIds: [tabId], initiatorDomains: [chrome.runtime.id], regexFilter: '^https?://', resourceTypes: ['xmlhttprequest', 'media'] },
    }] : [],
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(extensionOrigin + '/')) return;
  // Record cancellation before any storage await: an immediate cancel can otherwise
  // overtake SWITCH_EPISODE while that handler is still loading its session.
  let switchRequest, cancelledRequest;
  if (message.type === 'SWITCH_EPISODE' && !episodeRequests.has(message.sessionId)) {
    switchRequest = { cancelled: false };
    switchRequest.finished = new Promise(resolve => { switchRequest.finish = resolve; });
    episodeRequests.set(message.sessionId, switchRequest);
  }
  if (message.type === 'CANCEL_EPISODE') {
    cancelledRequest = episodeRequests.get(message.sessionId);
    if (cancelledRequest) cancelledRequest.cancelled = true;
  }
  (async () => {
    if (message.type === 'OPEN_PLAYER') {
      const url = httpUrl(message.source?.url);
      if (!url) throw new Error('请输入有效的 HTTP 或 HTTPS 视频地址。');
      const sessionId = crypto.randomUUID();
      const source = await hydrateEpisodeContext({ ...message.source, url, sourceTabId: message.sourceTabId, createdAt: Date.now() });
      await chrome.storage.session.set({ [`player:${sessionId}`]: source });
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?session=${sessionId}`) });
      await chrome.storage.session.set({ [`playerTab:${tab.id}`]: sessionId });
      return { tabId: tab.id };
    }
    if (message.type === 'PREPARE_PLAYER') {
      let source = (await chrome.storage.session.get(`player:${message.sessionId}`))[`player:${message.sessionId}`];
      if (!source) throw new Error('播放会话已过期，请重新从插件打开视频。');
      if (!sender.tab?.id || !sender.url.startsWith(extensionOrigin + '/player.html')) throw new Error('无效的播放页。');
      if (!source.catalog?.groups.length) {
        source = await hydrateEpisodeContext(source);
        await chrome.storage.session.set({ [`player:${message.sessionId}`]: source });
      }
      await configureHeaders(sender.tab.id, source);
      return { source };
    }
    if (['SWITCH_EPISODE', 'CANCEL_EPISODE', 'REFRESH_EPISODES'].includes(message.type)) {
      if (!sender.tab?.id || !sender.url.startsWith(extensionOrigin + '/player.html') || new URL(sender.url).searchParams.get('session') !== message.sessionId) throw new Error('无效的播放会话。');
      const key = `player:${message.sessionId}`;
      const source = (await chrome.storage.session.get(key))[key];
      if (!source) throw new Error('播放会话已过期，请从原网页重新打开。');
      if (message.type === 'CANCEL_EPISODE') {
        await cancelEpisodeResolution(message.sessionId);
        if (cancelledRequest) await cancelledRequest.finished;
        return {};
      }
      if (message.type === 'REFRESH_EPISODES') {
        const catalog = await refreshEpisodeCatalog(source, message.sessionId);
        const previousGroup = source.catalog?.groups.find(g => g.id === source.catalog.currentGroupId);
        const previousEpisode = previousGroup?.episodes.find(e => e.id === source.catalog.currentEpisodeId);
        const matchingGroup = catalog.groups.find(g => g.id === previousGroup?.id);
        if (matchingGroup) {
          if (!matchingGroup.episodes.length) matchingGroup.episodes = previousGroup.episodes;
          catalog.currentGroupId = matchingGroup.id;
          catalog.currentEpisodeId = matchingGroup.episodes.find(e => e.key === previousEpisode?.key)?.id || '';
        }
        await chrome.storage.session.set({ [key]: { ...source, catalog, catalogError: '' } });
        return { catalog, sourceTabId: source.sourceTabId };
      }
      if (!switchRequest) throw new Error('正在切换，请稍候或先取消。');
      if (switchRequest.cancelled) throw new Error('已取消切换。');
      const nextSource = await resolveEpisode(message.sessionId, source, message.selection || {}, () => switchRequest.cancelled);
      if (switchRequest.cancelled) throw new Error('已取消切换。');
      await chrome.tabs.get(sender.tab.id);
      await configureHeaders(sender.tab.id, nextSource);
      if (!switchRequest.cancelled) await chrome.storage.session.set({ [key]: nextSource });
      if (switchRequest.cancelled) {
        await configureHeaders(sender.tab.id, source);
        await chrome.storage.session.set({ [key]: source });
        throw new Error('已取消切换。');
      }
      return { source: nextSource };
    }
    throw new Error('未知操作。');
  })().then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message })).finally(() => {
    if (switchRequest) {
      if (episodeRequests.get(message.sessionId) === switchRequest) episodeRequests.delete(message.sessionId);
      switchRequest.finish();
    }
  });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  serialized(tabId, async () => {
    const key = `playerTab:${tabId}`;
    const id = (await chrome.storage.session.get(key))[key];
    const pending = episodeRequests.get(id);
    if (pending) pending.cancelled = true;
    if (id) await cancelEpisodeResolution(id);
    if (pending) await pending.finished;
    await chrome.storage.session.remove([sourceKey(tabId), key, ...(id ? [`player:${id}`] : [])]);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId + 1] });
  }).catch(() => {});
});
