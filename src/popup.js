import { httpUrl } from './common.js';

const $ = id => document.getElementById(id);
let currentTab;
let lastSignature = '';

async function open(source, sourceTabId) {
  $('popup-error').hidden = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_PLAYER', source, sourceTabId });
    if (!result.ok) throw new Error(result.error);
    if (Number.isInteger(sourceTabId)) {
      await chrome.scripting.executeScript({
        target: { tabId: sourceTabId, allFrames: true },
        func: () => { document.querySelectorAll('video').forEach(video => video.pause()); },
      }).catch(() => {});
    }
    window.close();
  } catch (error) { $('popup-error').textContent = error.message; $('popup-error').hidden = false; }
}

async function render() {
  if (!currentTab?.id) return;
  const key = `sources:${currentTab.id}`;
  const sources = (await chrome.storage.session.get(key))[key] || [];
  const signature = JSON.stringify(sources.map(s => s.url));
  if (signature === lastSignature) return;
  lastSignature = signature;
  $('source-count').textContent = sources.length;
  $('empty').hidden = sources.length > 0;
  $('source-list').replaceChildren();
  sources.forEach((source, index) => {
    const card = document.createElement('button');
    card.className = 'source-card';
    const badge = document.createElement('span');
    badge.className = 'source-badge'; badge.textContent = 'HLS';
    const info = document.createElement('span'); info.className = 'source-info';
    const title = document.createElement('strong'); title.textContent = `视频源 ${String(index + 1).padStart(2, '0')}`;
    const host = document.createElement('span'); host.textContent = new URL(source.url).hostname;
    const filename = document.createElement('small');
    filename.textContent = new URL(source.url).pathname.split('/').pop() || '播放列表';
    info.append(title, host, filename);
    const arrow = document.createElement('span'); arrow.className = 'source-arrow'; arrow.textContent = '↗';
    card.append(badge, info, arrow);
    card.title = '在 VPlayer 中播放';
    card.addEventListener('click', () => open({ ...source, title: currentTab.title || '网页视频', pageUrl: currentTab.url || source.pageUrl }, currentTab.id));
    $('source-list').append(card);
  });
}

$('manual-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = httpUrl($('manual-url').value.trim());
  if (!url) { $('popup-error').textContent = '请输入 HTTP 或 HTTPS 地址。'; $('popup-error').hidden = false; return; }
  open({ url, title: '自定义视频源' });
});

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('page-title').textContent = currentTab?.title || '打开一个有视频的网页';
  await render();
}
init().catch(error => { $('popup-error').textContent = error.message; $('popup-error').hidden = false; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[`sources:${currentTab?.id}`]) render();
});
