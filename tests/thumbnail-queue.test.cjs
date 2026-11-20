const { test } = require('node:test');
const assert = require('node:assert/strict');

test('thumbnail queue limits IPC and drops stale jobs before reading them', async () => {
  const { thumbnailQueue } = await import('../src/thumbnail-queue.mjs');
  const reads = [];
  const results = [];
  const controls = new Map();
  const enqueue = thumbnailQueue(id => {
    reads.push(id);
    return new Promise((resolve, reject) => controls.set(id, { resolve, reject }));
  });
  const add = id => enqueue(id, image => results.push([id, image]));
  const cancelRunning = add('first');
  add('second');
  const cancelStale = add('old-page');
  assert.deepEqual(reads, ['first', 'second']);
  assert.equal(cancelRunning(), false);
  assert.equal(cancelStale(), true);
  add('new-page');

  controls.get('second').reject(new Error('Unavailable preview'));
  await new Promise(setImmediate);
  assert.deepEqual(reads, ['first', 'second', 'new-page']);
  controls.get('first').resolve('first thumbnail');
  controls.get('new-page').resolve('new thumbnail');
  await new Promise(setImmediate);
  assert.deepEqual(results, [['second', null], ['first', 'first thumbnail'], ['new-page', 'new thumbnail']]);
});
