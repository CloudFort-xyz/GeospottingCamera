import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectGps, toDmsRationals } from '../js/exif.js';

test('DMS rationals round-trip with sub-centimetre precision', () => {
  for (const v of [0, 50.8503396, -33.86882, 179.9999999, -0.0000001, 51.0543422]) {
    const [[d], [m], [s, sd]] = toDmsRationals(v);
    const back = d + m / 60 + s / sd / 3600;
    assert.ok(Math.abs(back - Math.abs(v)) < 1e-7, `${v} -> ${back}`);
    assert.ok(m < 60 && s / sd < 60);
  }
});

test('injected EXIF is readable by Pillow with correct GPS values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exif-'));
  const src = join(dir, 'in.jpg');
  // Create a small JPEG with a JFIF header using Pillow.
  execFileSync('python3', ['-c', `from PIL import Image; Image.new('RGB',(64,48),(200,50,50)).save('${src}', quality=90)`]);
  const meta = {
    lat: 50.8503396, lon: -4.3517103, accuracy: 3.21, altitude: 56.7, heading: 271.5,
    fixTime: Date.UTC(2026, 9, 10, 11, 8, 12, 345), takenAt: Date.UTC(2026, 9, 10, 11, 8, 13),
  };
  const out = injectGps(new Uint8Array(readFileSync(src)), meta);
  const dst = join(dir, 'out.jpg');
  writeFileSync(dst, out);
  const py = `
import json
from PIL import Image
im = Image.open('${dst}'); im.load()
g = im.getexif().get_ifd(0x8825)
dec = lambda v: float(v[0]) + float(v[1])/60 + float(v[2])/3600
print(json.dumps({
  'lat': dec(g[2]) * (1 if g[1]=='N' else -1),
  'lon': dec(g[4]) * (1 if g[3]=='E' else -1),
  'alt': float(g[6]), 'acc': float(g[31]), 'dir': float(g[17]),
  'date': g[29], 'datum': g[18], 'size': im.size,
  'comment': im.info.get('comment', b'').decode(),
}))`;
  const r = JSON.parse(execFileSync('python3', ['-c', py]).toString());
  assert.ok(Math.abs(r.lat - meta.lat) < 1e-7);
  assert.ok(Math.abs(r.lon - meta.lon) < 1e-7);
  assert.equal(r.alt, 56.7);
  assert.equal(r.acc, 3.21);
  assert.equal(r.dir, 271.5);
  assert.equal(r.date, '2026:10:10');
  assert.equal(r.datum, 'WGS-84');
  assert.deepEqual(r.size, [64, 48]);
  assert.match(r.comment, /^GEOSPOT lat=50\.85033960 lon=-4\.35171030 acc=3\.21m/);
});
