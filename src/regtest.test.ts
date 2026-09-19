import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { DATA, dataDir, ROOT } from './regtest.js';

test('the drill only ever touches <repo>/data, whatever directory it is started from', () => {
  assert.ok(isAbsolute(ROOT) && existsSync(join(ROOT, 'package.json')), 'ROOT is the repository root');
  assert.equal(DATA, join(ROOT, 'data'));
  assert.equal(dataDir('alice'), join(ROOT, 'data', 'alice'));
  const cwd = process.cwd();
  process.chdir('/');
  try {
    assert.equal(DATA, join(ROOT, 'data'), 'changing the working directory must not move it');
  } finally {
    process.chdir(cwd);
  }
});
