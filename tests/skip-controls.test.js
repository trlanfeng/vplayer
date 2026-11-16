import test from 'node:test';
import assert from 'node:assert/strict';
import { skipBounds, createSkipControls } from '../src/skip-controls.js';

test('skip positions adapt to each duration and ignore unsafe ranges', () => {
  assert.deepEqual(skipBounds(120, 10, 15), { start: 10, end: 105 });
  assert.deepEqual(skipBounds(150, 10, 15), { start: 10, end: 135 });
  assert.deepEqual(skipBounds(20, 10, 15), { start: 10, end: 20 });
  assert.deepEqual(skipBounds(8, 10, 15), { start: 0, end: 8 });
  assert.deepEqual(skipBounds(100, NaN, -1), { start: 0, end: 100 });
  for (const duration of [NaN, Infinity, 0, -1]) assert.equal(skipBounds(duration, 10, 15), null);
});

test('skip lifecycle avoids duplicate advances, preserves resume and excludes live streams', async t => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new EventTarget());
    return elements.get(id);
  };
  const oldDocument = globalThis.document, oldChrome = globalThis.chrome;
  t.after(() => { globalThis.document = oldDocument; globalThis.chrome = oldChrome; });
  globalThis.document = { getElementById: element };
  let stored = { intro: 10, outro: 15, enabled: true };
  globalThis.chrome = { storage: { session: {
    get: async key => ({ [key]: stored }),
    set: async value => { stored = Object.values(value)[0]; },
  } } };
  const video = Object.assign(new EventTarget(), {
    duration: 120, currentTime: 0, paused: false, seeking: false,
    pause() { this.paused = true; },
  });
  let calls = 0, busy = false, hasNext = true;
  const controller = createSkipControls({ video, sessionId: 'test', toast() {}, episodes: {
    isBusy: () => busy, hasNext: () => hasNext,
    // Simulate a failed/cancelled resolution that leaves the current media intact.
    playNext: async () => { calls++; },
  } });
  const emit = event => video.dispatchEvent(new Event(event));
  const load = (live = false, resume = -1) => {
    controller.reset(resume); controller.setLive(live);
    emit('loadedmetadata');
  };
  await controller.init();
  load();
  assert.equal(video.currentTime, 10);
  video.currentTime = 2; emit('timeupdate');
  assert.equal(video.currentTime, 2, 'manual rewind is not trapped in an intro skip loop');
  video.currentTime = 106; busy = true; emit('timeupdate');
  assert.equal(calls, 0, 'manual switching owns the transition');
  busy = false; emit('timeupdate'); emit('ended'); emit('ended');
  assert.equal(calls, 1, 'failed/cancelled automatic switching is attempted only once');
  assert.equal(video.paused, true);
  video.currentTime = 3; video.paused = false; load(false, 3);
  assert.equal(video.currentTime, 3, 'same-episode source changes retain resume position');
  load(true); video.currentTime = 119; emit('timeupdate'); emit('ended');
  assert.equal(calls, 1);
  assert.equal(element('mark-intro').disabled, true);
  video.currentTime = 0; load();
  element('auto-skip').checked = false;
  element('auto-skip').dispatchEvent(new Event('change'));
  video.currentTime = 119; emit('timeupdate'); emit('ended');
  assert.equal(calls, 1, 'disabled autoplay does not advance even at the end');
  hasNext = false;
  element('auto-skip').checked = true;
  element('auto-skip').dispatchEvent(new Event('change'));
  assert.equal(video.paused, true, 'last episode stops at the outro');
  assert.equal(calls, 1);
});
