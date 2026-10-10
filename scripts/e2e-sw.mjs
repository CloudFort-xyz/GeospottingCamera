// Service-worker update test: with GitHub Pages-like HTTP caching (max-age=600),
// deploying a new version must result in the page running the new HTML *and*
// the new JS together — never a mix, never stuck on the old version.
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createStaticServer } from './serve.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const site = mkdtempSync(join(tmpdir(), 'site-'));
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons']) cpSync(join(repo, f), join(site, f), { recursive: true });
const patch = (f, fn) => writeFileSync(join(site, f), fn(readFileSync(join(site, f), 'utf8')));
const setBuild = (n) => {
  patch('sw.js', (s) => s.replace(/^const VERSION = .*$/m, `const VERSION = 'test-${n}';`));
  patch('index.html', (s) => s.replace(/<meta name="test-build"[^>]*>\n?|<\/head>/, (m) => `<meta name="test-build" content="${n}">\n${m === '</head>' ? m : ''}`));
  patch('js/app.js', (s) => s.replace(/\nwindow\.__testBuild = \d+;\n$|$/, `\nwindow.__testBuild = ${n};\n`));
};
setBuild(1);

const server = createStaticServer(site, { cacheControl: 'max-age=600' });
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => { console.error('pageerror', e); process.exitCode = 1; });
const builds = () => page.evaluate(() => ({
  html: document.querySelector('meta[name=test-build]')?.content,
  js: window.__testBuild,
}));

try {
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the SW; everything is also in the HTTP cache
  assert.deepEqual(await builds(), { html: '1', js: 1 });

  setBuild(2); // "deploy"
  // The app reloads itself once the new version is installed (or the user taps the banner).
  await page.reload();
  // Until the user accepts, the running page must stay entirely on the old build.
  assert.deepEqual(await builds(), { html: '1', js: 1 });
  await page.waitForSelector('#update-banner:not([hidden])', { timeout: 15000 });
  console.log('Update banner shown; old build still consistent');
  await page.click('#update-reload');
  await page.waitForFunction(() => window.__testBuild === 2, null, { timeout: 15000 });
  assert.deepEqual(await builds(), { html: '2', js: 2 });

  // And it still works offline afterwards, on the new version.
  await page.context().setOffline(true);
  await page.reload();
  assert.deepEqual(await builds(), { html: '2', js: 2 });
  console.log('SW update OK');
} finally {
  await browser.close();
  server.close();
}
