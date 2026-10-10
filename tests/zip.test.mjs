import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, crc32 } from '../js/zip.js';
import { toCsv } from '../js/csv.js';

test('crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('csv quoting', () => {
  assert.equal(toCsv([['a', 'b,c', 'd"e'], [1, null, 'x\ny']]), 'a,"b,c","d""e"\r\n1,,"x\ny"\r\n');
});

test('zip is valid according to unzip', async () => {
  const z = new ZipWriter();
  z.add('photos/één.jpg', new Uint8Array([1, 2, 3, 4, 5]));
  z.add('locations.csv', 'filename,latitude,longitude\r\n');
  const buf = new Uint8Array(await z.finish().arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const f = join(dir, 't.zip');
  writeFileSync(f, buf);
  const out = execFileSync('unzip', ['-t', f]).toString();
  assert.match(out, /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', f, 'locations.csv']).toString(), 'filename,latitude,longitude\r\n');
});
