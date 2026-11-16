import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentScheduler } from '../src/scheduler.js';
import { httpUrl, isPlaylist, segmentKey, fragmentDescriptor } from '../src/common.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const item = n => ({ url: `https://media.test/${n}.ts`, start: n * 6, duration: 6, range: null });
class MemoryCache {
  entries = new Map();
  has(key) { return this.entries.has(key); }
  async get(key) { return this.entries.get(key) || null; }
  async put(key, value) { this.entries.set(key, value); }
}

function network(delay = 25) {
  const state = { active: 0, max: 0, requests: [], aborted: [] };
  state.fetch = (url, options) => new Promise((resolve, reject) => {
    state.requests.push({ url, options });
    state.active++; state.max = Math.max(state.max, state.active);
    const finish = () => { state.active--; options.signal.removeEventListener('abort', abort); };
    const timer = setTimeout(() => { finish(); resolve(new Response(new Uint8Array([1, 2, 3]), { status: options.headers.Range ? 206 : 200 })); }, delay);
    const abort = () => { clearTimeout(timer); finish(); state.aborted.push(url); reject(new DOMException('aborted', 'AbortError')); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });
  return state;
}

async function settle(scheduler) {
  for (let i = 0; i < 400; i++) {
    if (!scheduler.jobs.size && !scheduler.active) return;
    await sleep(5);
  }
  throw new Error('Scheduler did not drain');
}

test('four concurrent downloads respect the cap and populate the cache', async () => {
  const net = network();
  const cache = new MemoryCache();
  const scheduler = new SegmentScheduler(cache, { concurrency: 4, fetcher: net.fetch });
  scheduler.plan(Array.from({ length: 12 }, (_, n) => item(n)));
  await settle(scheduler);
  assert.equal(net.max, 4);
  assert.equal(cache.entries.size, 12);
  assert.equal(scheduler.transferred, 36);
  scheduler.close();
});

test('playback reuses an in-flight prefetch and then reads the cache', async () => {
  const net = network();
  const scheduler = new SegmentScheduler(new MemoryCache(), { fetcher: net.fetch });
  scheduler.plan([item(1)]);
  const [a, b] = await Promise.all([scheduler.request(item(1)), scheduler.request(item(1))]);
  assert.deepEqual(a.data, b.data);
  await settle(scheduler);
  await scheduler.request(item(1));
  assert.equal(net.requests.length, 1);
  assert.equal(scheduler.hits, 1);
  scheduler.close();
});

test('seeking cancels stale speculation and downloads the new window', async () => {
  const net = network(70);
  const cache = new MemoryCache();
  const scheduler = new SegmentScheduler(cache, { concurrency: 2, fetcher: net.fetch });
  scheduler.plan([item(1), item(2), item(3)]);
  await sleep(10);
  scheduler.plan([item(20), item(21)]);
  await settle(scheduler);
  assert.equal(net.aborted.length, 2);
  assert.equal(cache.has(segmentKey(item(3))), false);
  assert.equal(cache.has(segmentKey(item(20))), true);
  assert.equal(cache.has(segmentKey(item(21))), true);
  scheduler.close();
});

test('an urgent playback request preempts distant speculative work', async () => {
  const net = network(70);
  const scheduler = new SegmentScheduler(new MemoryCache(), { concurrency: 2, fetcher: net.fetch });
  scheduler.plan([item(10), item(11)]);
  await sleep(10);
  await scheduler.request(item(0));
  assert.ok(net.aborted.includes(item(11).url));
  assert.equal(net.requests[2].url, item(0).url);
  scheduler.close();
  await settle(scheduler);
});

test('a cache hit does not consume a download slot or cancel an in-flight prefetch', async () => {
  const net = network(70);
  const cache = new MemoryCache();
  cache.entries.set(segmentKey(item(0)), { data: new ArrayBuffer(3) });
  const scheduler = new SegmentScheduler(cache, { concurrency: 2, fetcher: net.fetch });
  scheduler.plan([item(10), item(11)]);
  await sleep(10);
  await scheduler.request(item(0));
  assert.equal(scheduler.active, 2);
  assert.equal(net.aborted.length, 0);
  await settle(scheduler);
  assert.equal(net.requests.length, 2);
  scheduler.close();
});

test('byte ranges are part of identity and sent as HTTP Range headers', async () => {
  const net = network();
  const scheduler = new SegmentScheduler(new MemoryCache(), { fetcher: net.fetch });
  const a = { ...item(0), range: [0, 100] }, b = { ...item(0), range: [100, 200] };
  await Promise.all([scheduler.request(a), scheduler.request(b)]);
  assert.equal(net.requests.length, 2);
  assert.equal(net.requests[0].options.headers.Range, 'bytes=0-99');
  assert.equal(net.requests[1].options.headers.Range, 'bytes=100-199');
  scheduler.close();
});

test('authentication errors fail immediately without repeated requests', async () => {
  let calls = 0;
  const scheduler = new SegmentScheduler(new MemoryCache(), { fetcher: async () => { calls++; return new Response('', { status: 403 }); } });
  await assert.rejects(scheduler.request(item(0)), /HTTP 403/);
  assert.equal(calls, 1);
  scheduler.close();
});

test('temporary server errors are retried and stop after success', async () => {
  let calls = 0;
  const scheduler = new SegmentScheduler(new MemoryCache(), { fetcher: async () => new Response('segment', { status: ++calls === 1 ? 503 : 200 }) });
  await scheduler.request(item(0));
  assert.equal(calls, 2);
  scheduler.close();
});

test('cancelling a request aborts network work and releases its slot', async () => {
  const net = network(100);
  const scheduler = new SegmentScheduler(new MemoryCache(), { fetcher: net.fetch, concurrency: 1 });
  const controller = new AbortController();
  const promise = scheduler.request(item(0), controller.signal);
  await sleep(10);
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  await settle(scheduler);
  assert.equal(net.active, 0);
  assert.equal(scheduler.active, 0);
  scheduler.close();
});

test('cancelling one consumer does not abort another consumer of the same segment', async () => {
  const net = network(50);
  const scheduler = new SegmentScheduler(new MemoryCache(), { fetcher: net.fetch });
  const first = new AbortController();
  const a = scheduler.request(item(0), first.signal);
  const b = scheduler.request(item(0));
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal((await b).data.byteLength, 3);
  assert.equal(net.requests.length, 1);
  assert.equal(net.aborted.length, 0);
  scheduler.close();
});

test('source recognition includes extensionless HLS MIME types and rejects unsafe URLs', () => {
  assert.equal(isPlaylist('https://a.test/video?token=abc', 'application/vnd.apple.mpegurl'), true);
  assert.equal(isPlaylist('https://a.test/video.m3u8?token=abc'), true);
  assert.equal(isPlaylist('https://a.test/video.mp4', 'video/mp4'), false);
  assert.equal(httpUrl('javascript:alert(1)'), null);
  assert.equal(httpUrl('https://user:pass@a.test/stream'), null);
  assert.equal(fragmentDescriptor({ url: 'https://a.test/f', byteRangeStartOffset: 0, byteRangeEndOffset: 20 }).range[0], 0);
});
