import { build } from 'esbuild';
import { mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await mkdir('dist/icons', { recursive: true });
await build({ entryPoints: ['src/background.js', 'src/popup.js', 'src/player.js', 'src/episodes.js'], outdir: 'dist', bundle: true, format: 'esm', target: 'chrome120', minify: true, legalComments: 'eof' });
for (const file of ['manifest.json', 'popup.html', 'player.html', 'styles.css', 'episodes.css', 'fonts.css', 'INSTALL.md']) await copyFile(file, `dist/${file}`);
await copyFile('node_modules/hls.js/dist/hls.worker.js', 'dist/vendor/hls.worker.js');
await copyFile('node_modules/hls.js/LICENSE', 'dist/HLS-LICENSE.txt');
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
};
for (const size of [16, 48, 128]) {
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size, py = (y + .5) / size;
    const dx = Math.max(.22 - px, 0, px - .78), dy = Math.max(.22 - py, 0, py - .78);
    const inside = dx * dx + dy * dy <= .22 * .22;
    const triangle = px >= .36 && px <= .72 && Math.abs(py - .5) <= (.72 - px) * .65;
    const offset = y * (size * 4 + 1) + x * 4 + 1;
    rows.set(triangle ? [22, 33, 17, 255] : [181, 236, 139, inside ? 255 : 0], offset);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  await writeFile(`dist/icons/${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
console.log(`VPlayer ${pkg.version} built in dist/ (load this folder as an unpacked extension).`);
