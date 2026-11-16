import { segmentKey } from './common.js';

const aborted = () => new DOMException('已取消', 'AbortError');
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(aborted());
  const abort = () => { clearTimeout(timer); reject(aborted()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export class SegmentScheduler {
  constructor(cache, { concurrency = 4, fetcher = (...args) => globalThis.fetch(...args), headers = () => ({}), timeout = 20000, retries = 2 } = {}) {
    this.cache = cache;
    this.concurrency = concurrency;
    this.fetcher = fetcher;
    this.headers = headers;
    this.timeout = timeout;
    this.retries = retries;
    this.jobs = new Map();
    this.failures = new Map();
    this.wanted = new Set();
    this.active = 0;
    this.transferred = 0;
    this.hits = 0;
    this.completed = 0;
    this.events = [];
    this.closed = false;
  }

  get speed() {
    const cutoff = Date.now() - 5000;
    this.events = this.events.filter(e => e.time >= cutoff);
    return this.events.reduce((sum, e) => sum + e.bytes, 0) / 5;
  }

  setConcurrency(count) {
    this.concurrency = Math.max(1, Math.min(8, Math.floor(Number(count) || 4)));
    this.pump();
  }

  plan(items) {
    this.wanted = new Set(items.map(segmentKey));
    for (const job of this.jobs.values()) {
      if (!job.demanded && !this.wanted.has(job.key)) this.cancel(job);
    }
    items.forEach((item, index) => {
      const key = segmentKey(item);
      if (this.cache.has(key) || (this.failures.get(key) || 0) > Date.now()) return;
      this.enqueue(item, false, index).catch(() => {});
    });
    this.pump();
  }

  request(item, signal, checkCache = true) {
    if (signal?.aborted || this.closed) return Promise.reject(aborted());
    // A disk read needs no network slot and must not cancel a useful prefetch.
    if (checkCache && this.cache.has(segmentKey(item))) {
      return this.cache.get(segmentKey(item)).then(value => {
        if (signal?.aborted || this.closed) throw aborted();
        if (value) { this.hits++; return value; }
        return this.request(item, signal, false);
      });
    }
    const promise = this.enqueue(item, true, -1);
    const key = segmentKey(item);
    const requestedJob = this.jobs.get(key);
    requestedJob.consumers++;
    // A near-term playback request may replace a distant speculative download.
    if (this.active >= this.concurrency && !this.jobs.get(key)?.active) {
      const victim = [...this.jobs.values()].filter(j => j.active && !j.demanded).sort((a, b) => b.priority - a.priority)[0];
      if (victim) this.cancel(victim);
    }
    this.pump();
    if (!signal) return promise.finally(() => { requestedJob.consumers--; });
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (!released) { released = true; requestedJob.consumers--; }
      };
      const onAbort = () => {
        release();
        if (!requestedJob.consumers) this.cancel(requestedJob);
        reject(aborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => { release(); signal.removeEventListener('abort', onAbort); });
    });
  }

  enqueue(item, demanded, priority) {
    if (this.closed) return Promise.reject(aborted());
    const key = segmentKey(item);
    const existing = this.jobs.get(key);
    if (existing && !existing.controller.signal.aborted) {
      existing.demanded ||= demanded;
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }
    const job = { key, item, demanded, priority, consumers: 0, controller: new AbortController(), active: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.set(key, job);
    return job.promise;
  }

  cancel(job) {
    job.controller.abort();
    if (!job.active) {
      job.reject(aborted());
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    }
  }

  pump() {
    if (this.closed) return;
    while (this.active < this.concurrency) {
      const job = [...this.jobs.values()].filter(j => !j.active && !j.controller.signal.aborted).sort((a, b) => a.priority - b.priority)[0];
      if (!job) break;
      job.active = true;
      this.active++;
      this.run(job).then(job.resolve, error => {
        if (error.name !== 'AbortError') this.failures.set(job.key, Date.now() + 15000);
        job.reject(error);
      }).finally(() => {
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.active--;
        this.pump();
      });
    }
  }

  async run(job) {
    const cached = await this.cache.get(job.key);
    if (job.controller.signal.aborted) throw aborted();
    if (cached) { this.hits++; return cached; }
    let result;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try { result = await this.download(job); break; }
      catch (error) {
        if (job.controller.signal.aborted) throw aborted();
        if (attempt === this.retries || [401, 403, 404, 410].includes(error.status)) throw error;
        await delay(350 * 2 ** attempt, job.controller.signal);
      }
    }
    if (job.controller.signal.aborted) throw aborted();
    await this.cache.put(job.key, result).catch(() => {});
    this.completed++;
    this.failures.delete(job.key);
    return result;
  }

  async download(job) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    job.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeout);
    const started = performance.now();
    try {
      const headers = { ...this.headers(job.item.url) };
      if (job.item.range) headers.Range = `bytes=${job.item.range[0]}-${job.item.range[1] - 1}`;
      const response = await this.fetcher(job.item.url, { signal: controller.signal, credentials: 'include', headers });
      if (!response.ok) throw Object.assign(new Error(`分片下载失败：HTTP ${response.status}`), { status: response.status });
      if (job.item.range && response.status !== 206) throw new Error('视频源未正确响应分段范围请求。');
      const first = performance.now();
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error('单个分片超过 128 MB，请换一个视频源。'); }
        chunks.push(value);
        this.transferred += value.byteLength;
        this.events.push({ time: Date.now(), bytes: value.byteLength });
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      return { data: data.buffer, url: response.url || job.item.url, duration: performance.now() - started, ttfb: first - started, cached: false };
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener('abort', abort);
    }
  }

  cancelPrefetch() {
    this.wanted.clear();
    for (const job of this.jobs.values()) if (!job.demanded) this.cancel(job);
  }

  close() {
    this.closed = true;
    for (const job of this.jobs.values()) this.cancel(job);
  }
}
