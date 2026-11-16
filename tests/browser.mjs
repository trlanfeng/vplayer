import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, stat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve('artifacts');
const fixtures = join(root, 'fixtures');
await mkdir(fixtures, { recursive: true });
try { await stat(join(fixtures, 'index.m3u8')); }
catch {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '132', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '650k', '-g', '144', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_segment_filename', join(fixtures, 'segment%03d.ts'), join(fixtures, 'index.m3u8')], { timeout: 120000 });
}
// Real alternate rendition and audio fixtures exercise Video.js's built-in menus.
try { await stat(join(fixtures, 'low.m3u8')); }
catch {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(fixtures, 'index.m3u8'), '-vf', 'scale=320:180', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '220k', '-g', '144', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_segment_filename', join(fixtures, 'low%03d.ts'), join(fixtures, 'low.m3u8')], { timeout: 120000 });
}
for (const [name, frequency] of [['audio-main', '440'], ['audio-alt', '880']]) {
  try { await stat(join(fixtures, name + '.m3u8')); }
  catch {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`, '-t', '132', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_segment_filename', join(fixtures, name + '%03d.ts'), join(fixtures, name + '.m3u8')], { timeout: 120000 });
  }
}
let active = 0, peak = 0;
const requests = [];
let base;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/watch') {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'fixture=playback; Path=/; SameSite=Lax');
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地 HLS 播放测试</title><body><h1>HLS fixture</h1><button id="discover">发现视频</button><script>document.querySelector("button").onclick=()=>fetch("/stream",{headers:{Authorization:"Bearer fixture-token"}}).then(r=>r.text())</script></body></html>');
    return;
  }
  if (path === '/forbidden.m3u8') { res.writeHead(403); res.end('Forbidden'); return; }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  requests.push({ path, headers: req.headers });
  // A real protected fixture: captured Authorization + Referer and browser cookies must survive handoff.
  if (req.headers.authorization !== 'Bearer fixture-token' || req.headers.referer !== `${base}/watch` || !req.headers.cookie?.includes('fixture=playback')) {
    res.writeHead(403); res.end('Missing request context'); return;
  }
  try {
    let file;
    if (path === '/stream' || path === '/multi.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      if (path === '/stream') {
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"\n/media/index.m3u8\n');
        return;
      }
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="audio"\n/media/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="audio"\n/media/low.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="主音轨",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="/media/audio-main.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="备用音轨",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="/media/audio-alt.m3u8"\n');
      return;
    }
    file = await readFile(join(fixtures, basename(path)));
    if (path.endsWith('.ts')) {
      active++; peak = Math.max(peak, active);
      let completed = false;
      const release = () => { if (!completed) { completed = true; active--; } };
      res.on('close', release);
      await new Promise(resolve => setTimeout(resolve, 220));
      if (!res.destroyed) { res.setHeader('Content-Type', 'video/mp2t'); res.end(file); }
      release();
    } else { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(file); }
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'vplayer-test-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
});
const pageErrors = [];
context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
const results = [];
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const origin = `chrome-extension://${id}`;
  const web = await context.newPage();
  await web.goto(`${base}/watch`);
  await web.locator('#discover').click();
  let sources, sourceTabId;
  for (let i = 0; i < 100; i++) {
    const all = await worker.evaluate(() => chrome.storage.session.get(null));
    const entry = Object.entries(all).find(([key, value]) => key.startsWith('sources:') && value.some(s => s.url.endsWith('/stream')));
    if (entry) { sources = entry[1]; sourceTabId = Number(entry[0].slice(8)); break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(sources?.length, 1, 'extensionless playlist is detected');
  assert.equal(sources[0].authorization, 'Bearer fixture-token');
  assert.equal(sources[0].referer, `${base}/watch`);
  results.push('Detected extensionless HLS by MIME; captured request context.');

  let popup = await context.newPage();
  await popup.goto(`${origin}/popup.html`);
  // Emulate the toolbar popup's active source tab, then use its actual source card.
  await popup.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), sourceTabId);
  await popup.reload();
  await popup.locator('.source-card').waitFor();
  await popup.setViewportSize({ width: 390, height: 620 });
  await popup.screenshot({ path: join(root, 'popup-sources.png') });
  const newPage = context.waitForEvent('page');
  await popup.locator('.source-card').click();
  const player = await newPage;
  player.on('console', msg => { if (msg.type() === 'error') console.log('PLAYER:', msg.text().slice(0, 250)); });
  await player.waitForLoadState('domcontentloaded');
  await player.waitForFunction(() => document.querySelector('#video')?.currentTime > 2, null, { timeout: 30000 });
  assert.equal(await player.locator('#error-panel').isVisible(), false);
  assert.ok(peak >= 2, `real downloads are concurrent: peak ${peak}`);
  assert.ok(peak <= 4, `real concurrency is capped at four: peak ${peak}`);
  results.push(`Played authenticated HLS with cookies and Referer; peak concurrent downloads: ${peak}.`);

  await player.waitForFunction(() => Number(document.querySelector('#cached-ahead')?.firstChild?.textContent) > 60);
  await player.evaluate(() => document.querySelector('#video').pause());
  const beforeSeek = requests.filter(r => r.path.endsWith('.ts')).length;
  await player.evaluate(() => { const v = document.querySelector('#video'); v.currentTime = 78; return v.play(); });
  await player.waitForFunction(() => { const v = document.querySelector('#video'); return v.currentTime > 80 && !v.seeking; });
  assert.ok(Number(await player.locator('#cache-hits').textContent()) > 0);
  results.push('Seeked to a prefetched segment and resumed from local cache.');
  await player.locator('[data-value="2"]').click();
  assert.equal(await player.locator('[data-value="2"]').getAttribute('aria-pressed'), 'true');
  await player.locator('#ahead').selectOption('30');
  await player.locator('#prefetch').uncheck();
  assert.equal(await player.locator('#prefetch').isChecked(), false);
  results.push('Concurrency, look-ahead and prefetch controls work.');
  await player.locator('#prefetch').check();
  await player.locator('#ahead').selectOption('120');
  await player.locator('[data-value="4"]').click();
  await player.evaluate(() => document.querySelector('#video').pause());
  await player.locator('#video-skin').hover();
  await player.waitForFunction(() => {
    const controls = document.querySelector('#video-skin').shadowRoot.querySelector('media-controls-content');
    return getComputedStyle(controls).opacity === '1';
  });
  assert.equal(await player.locator('media-playback-rate-radio-group').count(), 1);
  assert.equal(await player.locator('media-quality-radio-group').count(), 1);
  assert.equal(await player.locator('media-audio-track-radio-group').count(), 1);
  for (const [seconds, target] of [[-60, 20], [-15, 5], [15, 20], [60, 80]]) {
    await player.locator(`#seek-controls media-seek-button[seconds="${seconds}"]`).click();
    await player.waitForFunction(target => {
      const v = document.querySelector('#video');
      return !v.seeking && Math.abs(v.currentTime - target) < 0.5 && v.paused;
    }, target);
  }
  await player.locator('#seek-controls media-seek-button[seconds="-60"]').click();
  await player.locator('#seek-controls media-seek-button[seconds="-60"]').click();
  await player.waitForFunction(() => document.querySelector('#video').currentTime === 0 && !document.querySelector('#video').seeking);
  await player.locator('#seek-controls media-seek-button[seconds="60"]').click();
  await player.locator('#seek-controls media-seek-button[seconds="60"]').click();
  await player.locator('#seek-controls media-seek-button[seconds="60"]').click();
  await player.waitForFunction(() => {
    const v = document.querySelector('#video'); return v.currentTime === v.duration;
  });
  await player.locator('#video').evaluate(v => { v.currentTime = 80; });
  await player.waitForFunction(() => !document.querySelector('#video').seeking);
  results.push('Video.js built-in seek buttons preserve pause and clamp all four offsets to media boundaries.');

  const timeline = player.locator('media-time-slider');
  const bar = await timeline.boundingBox();
  await player.mouse.move(bar.x + bar.width * 0.25, bar.y + bar.height / 2);
  await player.waitForFunction(() => {
    const thumb = document.querySelector('#video-skin').shadowRoot.querySelector('media-slider-thumbnail');
    const image = thumb?.querySelector('img') || thumb?.shadowRoot?.querySelector('img');
    return image?.complete && image.naturalWidth > 0 && image.src.startsWith('blob:');
  }, null, { timeout: 20000 });
  assert.equal(await player.locator('#video').evaluate(v => v.currentTime), 80, 'hover preview does not seek the player');
  assert.equal(await player.locator('#video').evaluate(v => v.paused), true);
  await player.screenshot({ path: join(root, 'player-preview.png'), fullPage: true });
  results.push('Video.js timeline renders an on-demand frame through its thumbnail track without moving playback.');
  const firstPreview = await player.locator('media-slider-thumbnail img').getAttribute('src');
  await player.mouse.move(bar.x + bar.width * 0.7, bar.y + bar.height / 2);
  await player.waitForFunction(previous => {
    const img = document.querySelector('#video-skin').shadowRoot.querySelector('media-slider-thumbnail img');
    return img?.complete && img.naturalWidth > 0 && img.src.startsWith('blob:') && img.src !== previous;
  }, firstPreview, { timeout: 20000 });
  assert.equal(await player.locator('#video').evaluate(v => v.currentTime), 80);
  const bandwidth = await player.locator('#video').evaluate(v => v.engine.bandwidthEstimate);
  assert.ok(bandwidth < 100_000_000, 'cache hits do not inflate adaptive bandwidth to disk-read speeds');

  await player.locator('media-fullscreen-button').click();
  await player.waitForFunction(() => document.fullscreenElement !== null);
  await player.locator('media-fullscreen-button').click();
  await player.waitForFunction(() => document.fullscreenElement === null);
  results.push('Video.js fullscreen enters and exits with its controls intact.');
  await player.locator('#video-skin').hover();
  await player.screenshot({ path: join(root, 'player-desktop.png'), fullPage: true });
  await player.setViewportSize({ width: 680, height: 1000 });
  await player.waitForTimeout(200);
  assert.equal(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await player.screenshot({ path: join(root, 'player-compact.png'), fullPage: true });
  results.push('Desktop and compact layouts fit the viewport.');

  const multiPage = context.waitForEvent('page');
  await player.evaluate(source => chrome.runtime.sendMessage({ type: 'OPEN_PLAYER', source }), { ...sources[0], url: `${base}/multi.m3u8` });
  const multi = await multiPage;
  await multi.waitForFunction(() => document.querySelector('#video')?.currentTime > 1);
  await multi.locator('#video').evaluate(v => v.pause());
  await multi.locator('#video-skin').hover();
  await multi.getByRole('button', { name: '设置', exact: true }).click();
  await multi.getByRole('menuitem', { name: /画质/ }).click();
  await multi.getByRole('menuitemradio', { name: /180p/ }).click();
  await multi.waitForFunction(() => document.querySelector('#video').engine.manualLevel === 0);
  await multi.locator('#source-host').click();
  await multi.getByRole('button', { name: '设置', exact: true }).click();
  await multi.getByRole('menuitem', { name: /音频/ }).click();
  await multi.getByRole('menuitemradio', { name: /备用音轨/ }).click();
  await multi.waitForFunction(() => document.querySelector('#video').engine.audioTrack === 1);
  await multi.locator('#source-host').click();
  await multi.getByRole('button', { name: '设置', exact: true }).click();
  await multi.getByRole('menuitem', { name: /速度/ }).click();
  await multi.getByRole('menuitemradio', { name: /^1\.5×$/ }).click();
  assert.equal(await multi.locator('#video').evaluate(v => v.playbackRate), 1.5);
  results.push('Built-in quality, alternate audio and playback speed menus control the actual HLS media.');

  await multi.close();


  // Opening popup.html in a regular tab has no active source tab. Check manual input and empty-state UI.
  if (popup.isClosed()) popup = await context.newPage();
  await popup.bringToFront();
  await popup.goto(`${origin}/popup.html`);
  await popup.setViewportSize({ width: 390, height: 620 });
  await popup.waitForTimeout(200);
  await popup.screenshot({ path: join(root, 'popup-empty.png') });
  const deniedPage = context.waitForEvent('page');
  await popup.locator('#manual-url').fill(`${base}/forbidden.m3u8`);
  await popup.locator('button[type="submit"]').click();
  const denied = await deniedPage;
  await denied.locator('#error-panel').waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await denied.locator('#error-message').textContent(), /403/);
  results.push('Manual URL entry and actionable HTTP 403 errors work.');

  // Page navigation clears stale discovery entries.
  await web.goto(`${base}/watch?next=1`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await worker.evaluate(key => chrome.storage.session.get(key), `sources:${sourceTabId}`))[`sources:${sourceTabId}`], undefined);
  results.push('Navigation clears the source list for that tab.');
  assert.deepEqual(pageErrors, [], 'no unhandled page errors');
  await writeFile(join(root, 'browser-results.json'), JSON.stringify({ results, peakConcurrency: peak, requestsBeforeSeek: beforeSeek, pageErrors }, null, 2));
  console.log(results.join('\n'));
} catch (error) {
  for (const [i, page] of context.pages().entries()) {
    await page.screenshot({ path: join(root, `failure-${i}.png`), fullPage: true }).catch(() => {});
    console.log('PAGE', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0, 1600));
  }
  console.log('REQUEST COUNTS', requests.reduce((map, r) => { map[r.path] = (map[r.path] || 0) + 1; return map; }, {}));
  console.log('PAGE ERRORS', pageErrors);
  throw error;
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
