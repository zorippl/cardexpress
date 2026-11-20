const { test } = require('node:test');
const assert = require('node:assert/strict');

test('selection ranges are inclusive across the whole capture day', async () => {
  const { selectionRanges } = await import('../src/selection.mjs');
  assert.deepEqual(selectionRanges('1-10, 15， 58 – 65', 120), [[0, 10], [14, 15], [57, 65]]);
  assert.deepEqual(selectionRanges(' ', 120), []);
  for (const invalid of ['0', '61-59', '1-121', '5-', '1,,4', '2.5']) assert.throws(() => selectionRanges(invalid, 120));
});
