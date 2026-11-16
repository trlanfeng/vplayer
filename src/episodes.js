// This function is serialized by chrome.scripting. Keep all DOM helpers inside it.
export function scanEpisodePage() {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const absolute = value => {
    try { const url = new URL(value, location.href); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  };
  const identity = label => {
    const text = clean(label);
    const number = text.match(/(?:第\s*|\bEP(?:ISODE)?\s*)(\d+)\s*(?:[集话期回]|\b)/i) || text.match(/^(\d+)(?:\s*[集话期回])?$/);
    if (number) return String(Number(number[1]));
    return text.replace(/完结|完整版|预告|\s/g, '').toLowerCase();
  };
  const path = element => {
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const siblings = [...(node.parentElement?.children || [])].filter(s => s.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  };
  const labelOf = element => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('small,.badge,.count,.no,script,style').forEach(n => n.remove());
    return clean(copy.textContent).slice(0, 80);
  };
  const routeOf = url => {
    if (!url) return null;
    const parsed = new URL(url);
    const mac = parsed.pathname.match(/\/vodplay\/([^/]+)-(\d+)-(\d+)\.html$/i);
    if (mac) return { family: 'vodplay', series: mac[1], line: mac[2], episode: mac[3] };
    const py = parsed.pathname.match(/\/py\/([^/]+)\/(\d+)\/?$/);
    if (py) return { family: 'py', series: py[1], line: py[1], episode: py[2] };
    return null;
  };
  const currentUrl = new URL(location.href); currentUrl.hash = '';
  const currentRoute = routeOf(currentUrl.href);
  const groups = [];
  const routeGroups = new Map();
  const groupNodes = new Map();
  let currentGroupId = '', currentEpisodeId = '';
  const episodeSelector = '.module-play-list,.stui-content__playlist,.myui-content__list,.playlist,.play-list,.episode-list,.episodes,.anthology-list-play,[data-episodes]';
  const candidates = [...document.querySelectorAll('a[href],button,[role="button"],[data-episode]')].slice(0, 6000);
  for (const node of candidates) {
    const label = labelOf(node);
    if (!label || label.length > 48 || /^(?:上一|下一|首页|尾页|正序|倒序|排序|播放源|线路)/.test(label)) continue;
    const rawHref = node.getAttribute('href');
    const url = rawHref && !/^(?:#|javascript:)/i.test(rawHref) ? absolute(rawHref) : null;
    const route = routeOf(url);
    const container = node.closest(episodeSelector);
    const numberLabel = /^(?:第\s*)?\d+\s*(?:[集话期回]|完结|$)/.test(label) || /^EP(?:ISODE)?\s*\d+/i.test(label);
    const namedLabel = /^(?:正片|全集|完整版|HD|BD|高清|蓝光|[上中下]集)/i.test(label);
    const matchesRoute = route && currentRoute && route.family === currentRoute.family &&
      (route.family === 'vodplay' ? route.series === currentRoute.series : route.series === currentRoute.series);
    if (!(matchesRoute && numberLabel) && !(container && (numberLabel || namedLabel || node.hasAttribute('data-episode')))) continue;
    if (url && new URL(url).origin !== location.origin) continue;
    let group;
    if (matchesRoute) {
      const id = `route:${route.family}:${route.series}:${route.line}`;
      if (!routeGroups.has(id)) {
        group = { id, label: `线路 ${route.line}`, episodes: [] };
        routeGroups.set(id, group); groups.push(group);
      } else group = routeGroups.get(id);
    } else {
      if (!groupNodes.has(container)) {
        const id = `list:${path(container)}`;
        group = { id, label: clean(container.getAttribute('data-name') || container.getAttribute('aria-label')) || `线路 ${groups.length + 1}`, episodes: [] };
        groupNodes.set(container, group); groups.push(group);
      } else group = groupNodes.get(container);
    }
    const id = url || `click:${path(node)}`;
    if (group.episodes.some(e => e.id === id)) continue;
    const key = identity(label);
    const episode = { id, key, label: /^\d+$/.test(label) ? `第${label}集` : label, action: url ? { kind: 'navigate', url } : { kind: 'click', selector: path(node), pageUrl: location.href } };
    group.episodes.push(episode);
    const isCurrent = url ? new URL(url).href.split('#')[0] === currentUrl.href : node.matches('.active,.selected,[aria-current="true"],[aria-selected="true"]');
    if (isCurrent) { currentGroupId = group.id; currentEpisodeId = episode.id; }
  }
  // MacCMS / 555: source names occur in duplicate desktop/mobile tab bars.
  for (const node of document.querySelectorAll('.module-tab-item,.stui-pannel__head a,.myui-panel__head a,[data-source-name]')) {
    const route = routeOf(absolute(node.getAttribute('href') || location.href));
    if (!route || route.family !== 'vodplay' || route.series !== currentRoute?.series) continue;
    const group = routeGroups.get(`route:vodplay:${route.series}:${route.line}`);
    const label = labelOf(node);
    if (group && label && !/^\d+$/.test(label)) group.label = label;
  }
  // Sites such as 教父 expose only the active source's episodes and switch via <select>.
  const sourceSelect = [...document.querySelectorAll('select')].find(select => {
    const options = [...select.options];
    return options.length > 1 && options.filter(o => /线路|播放源|专线|蓝光/.test(o.textContent)).length >= 2;
  });
  if (sourceSelect && groups.length) {
    const activeGroup = groups.find(g => g.id === currentGroupId) || groups[0];
    const selectGroups = [...sourceSelect.options].filter(o => !o.disabled && o.value).map(option => ({
      id: `select:${path(sourceSelect)}:${option.value}`,
      label: clean(option.textContent).replace(/[（(]\s*\d+\s*[)）]\s*$/, ''),
      episodes: option.selected ? activeGroup.episodes : [],
      action: { kind: 'select', selector: path(sourceSelect), value: option.value, pageUrl: location.href },
    }));
    const selected = selectGroups.find(g => g.action.value === sourceSelect.value);
    groups.splice(0, groups.length, ...selectGroups);
    currentGroupId = selected?.id || groups[0]?.id || '';
  }
  for (const group of groups) {
    // Numeric ordering survives a website's reverse-order toggle; labels remain intact.
    if (group.episodes.every(e => /^\d+$/.test(e.key))) group.episodes.sort((a, b) => Number(a.key) - Number(b.key));
    group.episodes = group.episodes.slice(0, 1000);
  }
  const useful = groups.filter(g => g.episodes.length || g.action).slice(0, 50);
  if (!currentGroupId) currentGroupId = useful[0]?.id || '';
  const title = clean(document.querySelector('h1,h2')?.textContent) || document.title;
  return { pageUrl: location.href, title: title.slice(0, 160), groups: useful, currentGroupId, currentEpisodeId };
}

// Read actual media hints without evaluating inline site code or guessing episode URLs.
export function inspectPlaybackPage({ nudge = false, pause = false } = {}) {
  const urls = new Set();
  const add = value => {
    try { const url = new URL(value, location.href); if (/^https?:$/.test(url.protocol) && /\.m3u8(?:$|[?#])/i.test(url.href)) urls.add(url.href); } catch {}
  };
  for (const video of document.querySelectorAll('video')) {
    add(video.currentSrc || video.src);
    if (pause) video.pause();
    else if (nudge) { video.muted = true; video.play().catch(() => {}); }
  }
  document.querySelectorAll('video source').forEach(n => add(n.src));
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent;
    const match = text.match(/(?:var|let|const)\s+player_[\w]+\s*=\s*/);
    if (!match) continue;
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < Math.min(text.length, start + 100000); i++) {
      const char = text[i];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const data = JSON.parse(text.slice(start, i + 1));
          let url = data.url;
          if (Number(data.encrypt) === 2) url = atob(url);
          if (Number(data.encrypt) > 0) { try { url = decodeURIComponent(url); } catch {} }
          add(url);
        } catch {}
        break;
      }
    }
  }
  return { pageUrl: location.href, urls: [...urls].slice(0, 20), ready: document.readyState !== 'loading' };
}

export function applyEpisodeAction(action) {
  const node = document.querySelector(action.selector);
  if (!node) throw new Error('原网页的选集控件已变化，请刷新选集列表。');
  if (action.kind === 'select') {
    if (!(node instanceof HTMLSelectElement) || ![...node.options].some(o => o.value === action.value)) throw new Error('这条线路已经不可用。');
    node.value = action.value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (action.kind === 'click') node.click();
}
