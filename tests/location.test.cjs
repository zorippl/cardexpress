const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { identifyLocation, isSameLocation } = require('../electron/location.cjs');

test('detects missing directories and a different directory at the same path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardexpress-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const selected = path.join(dir, 'card');
  await fs.mkdir(selected);
  const location = await identifyLocation(selected);
  await fs.writeFile(path.join(selected, 'new.NEF'), 'raw');
  assert.equal(await isSameLocation(location), true);
  await fs.rename(selected, path.join(dir, 'previous-card'));
  assert.equal(await isSameLocation(location), false);
  await fs.mkdir(selected);
  assert.equal(await isSameLocation(location), false);
  assert.equal(await isSameLocation(await identifyLocation(selected)), true);
});
