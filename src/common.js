export function httpUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function isPlaylist(url, contentType = '') {
  return /\.m3u8(?:$|[?#])/i.test(url) || /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i.test(contentType);
}

export function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][i]}`;
}

export function clock(value) {
  if (!Number.isFinite(value) || value < 0) return '00:00';
  const s = Math.floor(value);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

export function fragmentDescriptor(fragment) {
  const url = httpUrl(fragment?.url);
  if (!url) return null;
  const start = fragment.byteRangeStartOffset;
  const end = fragment.byteRangeEndOffset;
  return {
    url,
    range: Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null,
    start: Number.isFinite(fragment.start) ? fragment.start : 0,
    duration: fragment.duration || 0,
  };
}

export function segmentKey(item) {
  return `${item.url}|${item.range ? item.range.join('-') : 'full'}`;
}
