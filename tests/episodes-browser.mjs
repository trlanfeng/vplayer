import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { scanEpisodePage, inspectPlaybackPage } from '../src/episodes.js';

const root = resolve('artifacts');
await mkdir(root, { recursive: true });
const requests = [], pageRequests = [];
let base;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (/^\/(?:vodplay|py)\//.test(path)) pageRequests.push(path);
  const mac = path.match(/^\/vodplay\/demo-(\d+)-(\d+)\.html$/);
  const py = path.match(/^\/py\/(routeA|routeB)\/(\d+)$/);
  if (mac || py) {
    const line = mac ? mac[1] : py[1];
    const ep = mac ? mac[2] : py[2];
    const header = `<meta charset="utf-8"><title>测试剧 第${ep}集</title><h1>测试剧</h1>`;
    let controls;
    if (mac) {
      controls = '<div class="module-tab-items"><a class="module-tab-item" href="/vodplay/demo-1-1.html"><span>主线路</span><small>4</small></a><a class="module-tab-item" href="/vodplay/demo-2-1.html"><span>备用线路</span><small>2</small></a></div>';
      for (const [source, labels] of [['1', [1, 2, 3, 4]], ['2', [1, 3]]]) {
        controls += '<div class="module-play-list">' + labels.map((label, i) => `<a class="module-play-list-link" href="/vodplay/demo-${source}-${i + 1}.html">第0${label}集</a>`).join('') + '</div>';
      }
    } else {
      controls = `<select id="play-source" onchange="location.href=this.value"><option value="/py/routeA/${ep}" ${line === 'routeA' ? 'selected' : ''}>暴风线路(3)</option><option value="/py/routeB/${ep}" ${line === 'routeB' ? 'selected' : ''}>西瓜线路(3)</option></select><ul>` + [1, 2, 3].map(n => `<li><a href="/py/${line}/${n}" title="第${n}集">${n}</a></li>`).join('') + '</ul>';
    }
    const media = `${base}/hls/${line}/${ep}/master.m3u8`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'episode-session=ok; Path=/; SameSite=Lax');
    res.end(header + controls + `<script>var player_aaaa=${JSON.stringify({ url: media, encrypt: 0 })}; ${ep === '4' ? '' : `fetch(${JSON.stringify(media)},{headers:{Authorization:'Bearer episode-fixture'}}).then(r=>r.text())`}</script>`);
    return;
  }
  const media = path.match(/^\/hls\/([^/]+)\/(\d+)\/(.+)$/);
  if (media) {
    const [, line, ep, file] = media;
    const referer = `${base}${line.startsWith('route') ? `/py/${line}/${ep}` : `/vodplay/demo-${line}-${ep}.html`}`;
    requests.push(path);
    if (req.headers.referer !== referer || req.headers.authorization !== 'Bearer episode-fixture' || !req.headers.cookie?.includes('episode-session=ok')) { res.writeHead(403); res.end('Wrong episode context'); return; }
    if (file === 'master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"\nindex.m3u8\n');
      return;
    }
    try {
      const data = await readFile(join(root, 'fixtures', basename(file)));
      res.setHeader('Content-Type', file.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'vplayer-episodes-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 1080 },
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
});
const results = [], errors = [];
context.on('page', page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push(`Renderer crashed: ${page.url()}`));
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const reference = await context.newPage();
  await reference.route('https://www.555k12.com/**', route => route.fulfill({ contentType: 'text/html', path: resolve('tests/fixtures/555-episodes.html') }));
  await reference.goto('https://www.555k12.com/vodplay/792246-14-1.html');
  const captured = await reference.evaluate(scanEpisodePage);
  assert.equal(captured.groups.length, 16);
  assert.equal(captured.groups.find(g => g.id.endsWith(':14')).label, '高清蓝光');
  assert.equal(captured.groups.find(g => g.id.endsWith(':14')).episodes.length, 10);
  const missing = captured.groups.find(g => g.id.endsWith(':4'));
  assert.equal(missing.episodes.find(e => e.key === '7').action.url, 'https://www.555k12.com/vodplay/792246-4-6.html');
  assert.equal(missing.episodes.some(e => e.key === '6'), false);
  results.push('Parsed actual 555 DOM: 16 source groups, correct names, missing episodes and label-to-link mapping.');
  await reference.close();

  async function openFromPage(path) {
    const web = await context.newPage();
    await web.goto(base + path);
    let tabId;
    for (let i = 0; i < 100; i++) {
      const all = await worker.evaluate(() => chrome.storage.session.get(null));
      const entry = Object.entries(all).find(([key, list]) => key.startsWith('sources:') && list.some(s => s.referer === base + path));
      if (entry) { tabId = Number(entry[0].slice(8)); break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(Number.isInteger(tabId));
    const popup = await context.newPage();
    await popup.goto(origin + '/popup.html');
    await popup.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabId);
    await popup.reload();
    await popup.locator('.source-card').waitFor();
    const nextPage = context.waitForEvent('page');
    await popup.locator('.source-card').first().click();
    const player = await nextPage;
    await player.waitForFunction(() => document.querySelector('video')?.currentTime > 1, null, { timeout: 20000 });
    await player.bringToFront();
    return { web, player, tabId };
  }
  const { web, player } = await openFromPage('/vodplay/demo-1-1.html');
  assert.equal(await player.locator('#episode-list button').count(), 4);
  assert.equal(await player.locator('#episode-source option').count(), 2);
  assert.equal(await player.locator('#episode-list .current').textContent(), '第01集');
  await player.locator('#episode-list button').filter({ hasText: '第02集' }).click();
  await player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('正在播放 主线路 · 第02集'));
  await player.waitForFunction(() => document.querySelector('video').currentTime > 1);
  assert.equal(await player.locator('#error-panel').isVisible(), false);
  assert.ok(requests.some(p => p.startsWith('/hls/1/2/segment')));
  assert.equal(web.url(), `${base}/vodplay/demo-1-1.html`);
  const tabState = await player.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
  assert.equal(tabState[0].url, player.url());
  results.push('Episode switching captures fresh authenticated media in a muted background tab without moving focus or navigating the original page.');

  const source2 = await player.locator('#episode-source option').filter({ hasText: '备用线路' }).getAttribute('value');
  await player.locator('#episode-source').selectOption(source2);
  assert.match(await player.locator('#episode-status').textContent(), /没有第02集/);
  assert.equal(await player.locator('#episode-list button').count(), 2);
  await player.locator('#episode-list button').filter({ hasText: '第03集' }).click();
  await player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('正在播放 备用线路 · 第03集'));
  await player.waitForFunction(() => document.querySelector('video').currentTime > 3);
  assert.ok(requests.some(p => p.startsWith('/hls/2/2/segment')), 'episode label 3 maps to actual link index 2');
  const position = await player.locator('video').evaluate(video => video.currentTime);
  const source1 = await player.locator('#episode-source option').filter({ hasText: '主线路' }).getAttribute('value');
  await player.locator('#episode-source').selectOption(source1);
  await player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('正在播放 主线路 · 第03集'));
  await player.waitForFunction(position => document.querySelector('video').currentTime >= position, position);
  assert.equal(await player.locator('#error-panel').isVisible(), false);
  results.push('Source changes preserve the same episode and playback position; missing episodes require an explicit choice.');

  await player.locator('#next-episode').click();
  await player.locator('#cancel-episode').waitFor({ state: 'visible' });
  await player.locator('#cancel-episode').click();
  await player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('已取消切换，继续播放当前视频'));
  assert.equal(await player.locator('#episode-list .current').textContent(), '第03集');
  await player.locator('#previous-episode').click();
  await player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('正在播放 主线路 · 第02集'));
  results.push('Previous/next controls and cancellation retain the correct current episode.');
  await player.locator('#refresh-episodes').click();
  await player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('列表已更新'));
  assert.equal(await player.locator('#episode-list .current').textContent(), '第02集');
  await player.locator('video').evaluate(video => video.pause());
  await player.screenshot({ path: join(root, 'player-episodes-desktop.png'), fullPage: true });
  await player.setViewportSize({ width: 680, height: 1000 });
  await player.waitForTimeout(200);
  assert.equal(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await player.screenshot({ path: join(root, 'player-episodes-compact.png'), fullPage: true });

  const py = await openFromPage('/py/routeA/1');
  assert.equal(await py.player.locator('#episode-source option').count(), 2);
  assert.equal(await py.player.locator('#episode-list button').count(), 3);
  await py.player.locator('#episode-list button').filter({ hasText: '第2集' }).click();
  await py.player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('正在播放 暴风线路 · 第2集'));
  const alternate = await py.player.locator('#episode-source option').filter({ hasText: '西瓜线路' }).getAttribute('value');
  await py.player.locator('#episode-source').selectOption(alternate);
  await py.player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('正在播放 西瓜线路 · 第2集'));
  await py.player.waitForFunction(() => document.querySelector('video').currentTime > 1);
  assert.ok(requests.some(p => p.startsWith('/hls/routeB/2/segment')));
  assert.equal(await py.player.locator('#error-panel').isVisible(), false);
  results.push('教父-style numeric episode links and native source dropdowns switch sources and reload the correct episode.');

  // Reproduce an old background's stored session: pageUrl exists but sourceTabId
  // and catalog were never sent. The new player must recover the real source tab.
  const legacy = await openFromPage('/py/routeA/1');
  const legacySession = new URL(legacy.player.url()).searchParams.get('session');
  await worker.evaluate(async id => {
    const key = `player:${id}`;
    const stored = (await chrome.storage.session.get(key))[key];
    delete stored.sourceTabId; delete stored.catalog; delete stored.catalogError;
    await chrome.storage.session.set({ [key]: stored });
  }, legacySession);
  await legacy.player.reload();
  await legacy.player.locator('#episode-list button').first().waitFor();
  assert.equal(await legacy.player.locator('#episode-list button').count(), 3);
  assert.equal(await legacy.player.locator('#refresh-episodes').isEnabled(), true);
  // Also recover after the old originating tab has closed and is reopened later.
  await py.web.close();
  await legacy.web.close();
  await worker.evaluate(async id => {
    const key = `player:${id}`;
    const stored = (await chrome.storage.session.get(key))[key];
    delete stored.catalog;
    await chrome.storage.session.set({ [key]: stored });
  }, legacySession);
  await legacy.player.reload();
  await legacy.player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('没有找到对应'));
  assert.equal(await legacy.player.locator('#refresh-episodes').isEnabled(), true);
  const reopened = await context.newPage();
  await reopened.goto(base + '/py/routeA/1');
  await legacy.player.locator('#refresh-episodes').click();
  await legacy.player.waitForFunction(() => document.querySelector('#episode-status').textContent.includes('列表已更新'));
  assert.equal(await legacy.player.locator('#episode-list button').count(), 3);
  await legacy.player.close();
  await reopened.close();
  results.push('Legacy sessions recover missing source-tab metadata; refresh reconnects a reopened source page without restarting playback.');
  await py.player.close();
  await player.locator('#next-episode').click();
  await player.close();
  for (let i = 0; i < 50; i++) {
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    if (!tabs.some(tab => tab.url?.startsWith(base) && tab.mutedInfo?.muted)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(tab => tab.url?.startsWith(base) && tab.mutedInfo?.muted), false);
  for (let i = 0; i < 50; i++) {
    const stored = await worker.evaluate(() => chrome.storage.session.get(null));
    if (!Object.keys(stored).some(key => key.startsWith('player:') || key.startsWith('resolver:'))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(Object.keys(await worker.evaluate(() => chrome.storage.session.get(null))).some(key => key.startsWith('player:') || key.startsWith('resolver:')), false);
  results.push('Closing the player during a switch cleans up its owned resolver tab and session.');
  assert.deepEqual(errors, []);
  await writeFile(join(root, 'episode-results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(results.join('\n'));
} catch (error) {
  for (const [i, page] of context.pages().entries()) {
    console.log('PAGE', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(-3500));
    await page.screenshot({ path: join(root, `episode-failure-${i}.png`), fullPage: true }).catch(() => {});
  }
  console.log('PAGE ERRORS', errors);
  console.log('NAVIGATIONS', pageRequests);
  const currentWorker = context.serviceWorkers()[0];
  if (currentWorker) console.log('TABS', await currentWorker.evaluate(() => chrome.tabs.query({})).then(tabs => tabs.map(t => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status }))));
  throw error;
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
