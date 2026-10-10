// End-to-end smoke test: fake camera + spoofed GPS -> capture -> export -> verify ZIP contents.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { server } from './serve.mjs';

await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 50.8503396, longitude: 4.3517103, accuracy: 2.5 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => { console.error('pageerror', e); process.exitCode = 1; });

try {
  await page.goto(base);
  await page.click('#new-project');
  await page.fill('#prompt-input', 'Site survey: Brussels');
  await page.click('#prompt-ok');

  await page.waitForSelector('#view-camera:not([hidden])');
  await page.waitForSelector('#shutter[data-state="ok"]:not([disabled])');
  // Fake an Android absolute orientation: phone upright, rear camera facing east.
  await page.evaluate(() => {
    const fire = () => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 270, beta: 90, gamma: 0, absolute: true }));
    fire();
    window.__compassTimer = setInterval(fire, 100);
  });
  await page.waitForFunction(() => document.querySelector('#compass-text').textContent === '90° E');
  await page.click('#shutter');
  await page.waitForFunction(() => document.querySelector('#shot-count').textContent === '1');
  await page.evaluate(() => clearInterval(window.__compassTimer));

  // Custom camera resolution: the stream restarts at the requested width.
  await page.click('#camera-settings');
  await page.selectOption('#dlg-settings select[name=resolution]', 'custom');
  assert.equal(await page.isVisible('#custom-resolution-row'), true);
  await page.fill('#dlg-settings [name=customResolution]', '1280');
  await page.click('#dlg-settings button[value=save]');
  await page.waitForFunction(() => document.querySelector('#viewfinder').videoWidth === 1280);
  await page.waitForSelector('#shutter:not([disabled])');
  await page.click('#camera-settings');
  assert.equal(await page.inputValue('#dlg-settings select[name=resolution]'), 'custom');
  assert.equal(await page.inputValue('#dlg-settings [name=customResolution]'), '1280');
  assert.match(await page.textContent('#stream-info'), /1280 × 720/);
  await page.click('#dlg-settings button[value=cancel]');

  // Second shot with poor accuracy -> confirmation dialog.
  await context.setGeolocation({ latitude: 50.85041, longitude: 4.35180, accuracy: 25 });
  await page.waitForSelector('#shutter[data-state="coarse"]');
  await page.click('#shutter');
  await page.waitForSelector('#dlg-prompt[open]');
  await page.click('#prompt-ok');
  await page.waitForFunction(() => document.querySelector('#shot-count').textContent === '2');

  // Stationary device: watchPosition goes quiet, fix becomes stale -> shutter must fetch a fresh one.
  await context.setGeolocation({ latitude: 50.8503396, longitude: 4.3517103, accuracy: 2.5 });
  await page.waitForSelector('#shutter[data-state="stale"]', { timeout: 15000 });
  await page.click('#shutter');
  // Emulated geolocation only answers getCurrentPosition when a new position is pushed
  // (a real GNSS receiver delivers one on its own).
  await page.waitForFunction(() => document.querySelector('#gps-text').textContent.startsWith('Getting fresh'));
  await context.setGeolocation({ latitude: 50.8503396, longitude: 4.3517103, accuracy: 2.4 });
  await page.waitForFunction(() => document.querySelector('#shot-count').textContent === '3');
  assert.equal(await page.isVisible('#dlg-prompt[open]'), false);

  await page.click('#last-thumb');
  await page.waitForSelector('#view-project:not([hidden]) #photo-grid li:nth-child(3)');
  // Photo 2 was saved with a poor fix; walk to the right spot and re-set its location.
  await context.setGeolocation({ latitude: 50.85036, longitude: 4.35172, accuracy: 1.8 });
  await page.click('#photo-grid li:nth-child(2)');
  await page.waitForSelector('#dlg-photo[open]');
  await page.waitForFunction(() => /^\d+\.\d m away · /.test(document.querySelector('#live-distance').textContent));
  console.log('Live:', await page.textContent('#live-distance'), '|', await page.textContent('#live-detail'));
  await page.click('#photo-relocate');
  await page.waitForSelector('#dlg-prompt[open]');
  assert.match(await page.textContent('#prompt-message'), /current position \(±1\.8 m\)/);
  await page.click('#prompt-ok');
  await page.waitForFunction(() => document.querySelector('#live-distance').textContent.startsWith('0.0 m away'));
  assert.match(await page.textContent('#photo-info'), /Location set.*moved 7\.9 m from original/);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, 'photo-dialog.png') });
  await page.click('#dlg-photo button[value=close]');

  await page.click('#go-export');
  await page.fill('#dlg-export [name=maxWidth]', '320');
  await page.fill('#dlg-export [name=maxHeight]', '');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-run')]);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const zipPath = join(dir, download.suggestedFilename());
  await download.saveAs(zipPath);
  console.log('Downloaded', download.suggestedFilename());

  console.log(execFileSync('unzip', ['-l', zipPath]).toString());
  const csv = execFileSync('unzip', ['-p', zipPath, 'Site-survey-Brussels/locations.csv']).toString();
  console.log(csv);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'filename,latitude,longitude,accuracy_m,altitude_m,direction_deg,direction_ref,taken_at');
  assert.match(lines[1], /^Site-survey-Brussels_0001\.jpg,50\.85033960,4\.35171030,2\.50,,90\.0,M,/);
  assert.match(lines[2], /^Site-survey-Brussels_0002\.jpg,50\.85036000,4\.35172000,1\.80,/);

  execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir]);
  const info = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open('${dir}/Site-survey-Brussels/Site-survey-Brussels_0001.jpg')
g = im.getexif().get_ifd(0x8825)
d = lambda v: float(v[0]) + float(v[1])/60 + float(v[2])/3600
print(im.size[0], im.size[1], round(d(g[2]), 8), round(d(g[4]), 8), float(g[31]), float(g[17]), g[16])`]).toString().trim();
  console.log('JPEG check:', info);
  const [w, , lat, lon, acc, heading, headingRef] = info.split(' ').map((v, i) => (i === 6 ? v : Number(v)));
  assert.ok(Math.abs(heading - 90) < 0.01, `direction ${heading}`);
  assert.equal(headingRef, 'M');
  assert.equal(w, 320);
  assert.ok(Math.abs(lat - 50.8503396) < 1e-7); // 1e-4 arcsec quantisation (~3 mm)
  assert.ok(Math.abs(lon - 4.3517103) < 1e-7);
  assert.equal(acc, 2.5);
  // Settings: persistent storage request + delete all data (two confirmations).
  await page.keyboard.press('Escape'); // close export dialog
  await page.click('#open-settings');
  await page.waitForFunction(() => document.querySelector('#storage-info').textContent.includes('MB used'));
  console.log('Storage:', await page.textContent('#storage-info'));
  if (await page.isVisible('#persist-storage')) {
    await page.click('#persist-storage');
    await page.waitForFunction(() => document.querySelector('#dlg-prompt[open]') || document.querySelector('#storage-info').textContent.includes('is persistent'));
    if (await page.isVisible('#dlg-prompt[open]')) await page.click('#prompt-ok');
  }
  await page.click('#delete-all');
  await page.waitForSelector('#dlg-prompt[open]');
  assert.match(await page.textContent('#prompt-message'), /1 project and 3 photos/);
  await page.click('#prompt-ok');
  await page.waitForFunction(() => document.querySelector('#prompt-title').textContent === 'Are you absolutely sure?' && document.querySelector('#dlg-prompt[open]'));
  await page.click('#prompt-ok');
  await page.waitForSelector('#view-projects:not([hidden]) #projects-empty:not([hidden])');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#project-list li').length), 0);
  console.log('E2E OK');
} catch (e) {
  await page.screenshot({ path: join(tmpdir(), 'e2e-failure.png') });
  throw e;
} finally {
  await browser.close();
  server.close();
}
