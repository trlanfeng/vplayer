import test from 'node:test';
import assert from 'node:assert/strict';
import { findSourceTabId, hydrateEpisodeContext, readEpisodeCatalog } from '../src/episode-resolver.js';

const pageUrl = 'https://www.xn--wcv59z.com/py/6z4zQd/4';
const media = 'https://media.test/4/index.m3u8';
function browser({ tabs = [], stored = {}, read } = {}) {
  globalThis.chrome = {
    tabs: {
      async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('Tab closed'); return tab; },
      async query() { return tabs; },
    },
    storage: { session: { async get(keys) { return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]])); } } },
    scripting: { executeScript: read || (async () => [{ frameId: 0, result: { pageUrl, groups: [{ id: 'line', episodes: [{ key: '4' }] }] } }]) },
  };
}

test('legacy sessions recover their originating tab from the saved page URL', async () => {
  browser({ tabs: [{ id: 12, url: pageUrl }] });
  const recovered = await hydrateEpisodeContext({ url: media, pageUrl });
  assert.equal(recovered.sourceTabId, 12);
  assert.equal(recovered.catalog.groups.length, 1);
  assert.equal(recovered.catalogError, '');
});

test('a reopened original page replaces a stale tab id', async () => {
  browser({ tabs: [{ id: 21, url: pageUrl }] });
  assert.equal(await findSourceTabId({ url: media, pageUrl, sourceTabId: 3 }), 21);
});

test('duplicate page tabs prefer the one that actually requested this video', async () => {
  browser({ tabs: [{ id: 21, url: pageUrl }, { id: 22, url: pageUrl }], stored: { 'sources:22': [{ url: media }] } });
  assert.equal(await findSourceTabId({ url: media, pageUrl }), 22);
});

test('unrelated pages are never chosen just because they are on the same site', async () => {
  browser({ tabs: [{ id: 21, url: 'https://www.xn--wcv59z.com/py/other/1' }] });
  const recovered = await hydrateEpisodeContext({ url: media, pageUrl });
  assert.equal(recovered.sourceTabId, undefined);
  assert.match(recovered.catalogError, /没有找到对应的原网页/);
});

test('reading a valid main-frame catalog does not inject into inaccessible subframes', async () => {
  let calls = 0;
  browser({ read: async ({ target }) => {
    calls++;
    if (target.allFrames) throw new Error('Restricted child frame');
    assert.deepEqual(target.frameIds, [0]);
    return [{ frameId: 0, result: { groups: [{ id: 'main', episodes: [] }] } }];
  } });
  assert.equal((await readEpisodeCatalog(21)).frameId, 0);
  assert.equal(calls, 1);
});

test('permission failures report a reading error instead of claiming a pasted URL', async () => {
  browser({ tabs: [{ id: 12, url: pageUrl }], read: async () => { throw new Error('Permission denied'); } });
  const recovered = await hydrateEpisodeContext({ url: media, pageUrl });
  assert.equal(recovered.sourceTabId, 12);
  assert.match(recovered.catalogError, /读取原网页失败/);
});

test('a standalone m3u8 without webpage metadata stays unassociated', async () => {
  browser();
  const recovered = await hydrateEpisodeContext({ url: media });
  assert.equal(recovered.sourceTabId, undefined);
  assert.equal(recovered.catalogError, '');
});
