const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  RAW_EXTENSIONS, captureFromTags, dateFromTags, folderName, isWithin, scan, archive, copyVerified,
} = require('../electron/archive.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardexpress-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'card');
  const destination = path.join(dir, 'library');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  return { dir, source, destination };
}
const idle = () => {};
const signal = () => new AbortController().signal;
const fields = { location: '上海浦东', theme: '万圣夜主题', model: '小西' };

test('supports Sony, Canon, Nikon, Hasselblad and ignores JPEG', () => {
  for (const ext of ['.arw', '.cr2', '.cr3', '.nef', '.3fr', '.fff', '.dng']) {
    assert.ok(RAW_EXTENSIONS.has(ext));
  }
  assert.equal(RAW_EXTENSIONS.has('.jpg'), false);
  assert.equal(RAW_EXTENSIONS.has('.jpeg'), false);
});

test('uses local capture day, not a UTC date or file timestamp', () => {
  assert.equal(dateFromTags({ DateTimeOriginal: '2026:05:04 00:10:00+08:00' }), '2026-05-04');
  assert.equal(dateFromTags({ DateTimeOriginal: { year: 2026, month: 5, day: 4 } }), '2026-05-04');
  assert.equal(dateFromTags({ FileModifyDate: '2026:05:04 12:00:00' }), null);
  assert.equal(dateFromTags({ DateTimeOriginal: '2026:02:30 10:00:00' }), null);
  assert.equal(dateFromTags({ CreateDate: '2024:02:29 10:00:00' }), '2024-02-29');
});

test('reports camera wall-clock time without inventing missing seconds or times', () => {
  assert.deepEqual(captureFromTags({ DateTimeOriginal: '2026:05:04 00:10:02+08:00' }), { date: '2026-05-04', time: '00:10:02' });
  assert.deepEqual(captureFromTags({ CreateDate: '2026-05-04T01:23' }), { date: '2026-05-04', time: '01:23' });
  assert.deepEqual(captureFromTags({ DateTimeOriginal: { year: 2026, month: 5, day: 4 } }), { date: '2026-05-04', time: null });
});

test('folder names follow requested format and reject path injection', () => {
  assert.equal(folderName('2026-05-04', fields), '20260504_上海浦东_万圣夜主题_小西');
  for (const bad of ['../test', 'a\\b', 'a:b', '', 'x?', 'x.']) {
    assert.throws(() => folderName('2026-05-04', { ...fields, location: bad }));
  }
  assert.throws(() => folderName('../', fields));
  assert.throws(() => folderName('2026-05-04', {
    location: '沪'.repeat(60), theme: '夜'.repeat(60), model: '西'.repeat(60),
  }), /过长/);
});

test('path containment is component-aware', () => {
  assert.equal(isWithin('/card', '/card/DCIM/1.ARW'), true);
  assert.equal(isWithin('/card', '/card'), true);
  assert.equal(isWithin('/card', '/card-other/1.ARW'), false);
  assert.equal(isWithin('/card', '/library'), false);
});

test('scans recursively, handles uppercase RAW, skips JPG and symlinks', async t => {
  const { source } = await fixture(t);
  await fs.mkdir(path.join(source, 'DCIM'));
  await fs.writeFile(path.join(source, 'DCIM', 'one.ARW'), 'raw1');
  await fs.writeFile(path.join(source, 'two.3FR'), 'raw2');
  await fs.writeFile(path.join(source, 'three.FFF'), 'raw3');
  await fs.writeFile(path.join(source, 'ignored.JPG'), 'jpeg');
  await fs.symlink(path.join(source, 'DCIM'), path.join(source, 'loop'));
  const result = await scan(source, async () => ({ DateTimeOriginal: '2026:05:04 14:10:00' }), idle, signal());
  assert.equal(result.files.length, 3);
  assert.ok(result.files.every(file => file.date === '2026-05-04'));
});

test('JPG-only scans both JPEG extensions and archives only selected JPG originals', async t => {
  const { source, destination } = await fixture(t);
  await fs.mkdir(path.join(source, 'DCIM'));
  await fs.writeFile(path.join(source, 'DCIM', 'shot.JPG'), 'original jpeg');
  await fs.writeFile(path.join(source, 'other.JpEg'), 'jpeg with no date');
  await fs.writeFile(path.join(source, 'DCIM', 'shot.ARW'), 'raw counterpart');
  await fs.writeFile(path.join(source, 'unrelated.png'), 'png');
  const reads = [];
  const jpgScan = await scan(source, async file => {
    const name = path.basename(file);
    reads.push(name);
    return name === 'shot.JPG' ? { DateTimeOriginal: '2026:05:04 12:00:00' } : {};
  }, idle, signal(), 4, 'jpg');
  assert.deepEqual(reads.sort(), ['other.JpEg', 'shot.JPG']);
  assert.ok(jpgScan.files.every(file => file.format === 'jpg'));
  const shot = jpgScan.files.find(file => file.date);
  assert.equal(jpgScan.files.find(file => file.name === 'other.JpEg').date, null);
  const result = await archive({ ...jpgScan, fileIds: [shot.id], destination, mode: 'reuse' }, idle, signal());
  assert.deepEqual(result.failed, []);
  assert.deepEqual(await fs.readdir(destination), ['shot.JPG']);
  assert.equal(await fs.readFile(path.join(destination, 'shot.JPG'), 'utf8'), 'original jpeg');
  await assert.rejects(scan(source, () => {}, idle, signal(), 4, 'both'), /图片格式模式无效/);
});

test('unknown metadata is listed, not silently assigned a filesystem date', async t => {
  const { source } = await fixture(t);
  await fs.writeFile(path.join(source, 'unknown.NEF'), 'raw');
  const result = await scan(source, async () => { throw new Error('bad metadata'); }, idle, signal());
  assert.equal(result.files[0].date, null);
  assert.equal(result.files[0].metadataError, 'bad metadata');
});

test('date scan limits parallel reads and reports all attempts', async t => {
  const { source } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => fs.writeFile(path.join(source, `${i}.ARW`), 'raw')));
  let inFlight = 0, peak = 0;
  const updates = [];
  const result = await scan(source, async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 8));
    inFlight--;
    return { DateTimeOriginal: '2026:05:04' };
  }, update => updates.push(update), signal(), 3);
  assert.equal(peak, 3);
  assert.equal(result.files.length, 12);
  assert.equal(updates.at(-1).done, 12);
});

test('scan streams a previewable batch before all metadata reads finish', async t => {
  const { source } = await fixture(t);
  await fs.writeFile(path.join(source, 'first.ARW'), 'raw');
  await fs.writeFile(path.join(source, 'second.ARW'), 'raw');
  let resume;
  const hold = new Promise(resolve => { resume = resolve; });
  let received;
  const firstBatch = new Promise(resolve => { received = resolve; });
  const batches = [];
  const result = scan(source, async file => {
    if (file.endsWith('second.ARW')) await hold;
    return { DateTimeOriginal: '2026:05:04', PreviewImage: 'binary' };
  }, idle, signal(), 2, 'raw', batch => {
    batches.push(batch);
    received(batch);
  });
  try {
    const [photo] = await Promise.race([firstBatch, result.then(() => { throw Error('No early batch'); })]);
    assert.equal(photo.name, 'first.ARW');
    assert.deepEqual(photo.previewHints, ['PreviewImage']);
  } finally { resume(); }
  const complete = await result;
  assert.equal(complete.files.length, 2);
  assert.deepEqual(batches.flat().map(file => file.id).sort(), complete.files.map(file => file.id).sort());
});

test('copies selected dates only, verifies content, preserves originals and avoids overwrite', async t => {
  const { source, destination } = await fixture(t);
  await fs.mkdir(path.join(source, 'camera2'));
  await fs.writeFile(path.join(source, 'photo.ARW'), 'sony raw data');
  await fs.writeFile(path.join(source, 'camera2', 'photo.ARW'), 'another camera data');
  await fs.writeFile(path.join(source, 'other.3FR'), 'hasselblad data');
  await fs.writeFile(path.join(source, 'ignored.JPG'), 'jpeg');
  const scanned = await scan(source, async file => ({
    DateTimeOriginal: file.endsWith('.3FR') ? '2026:05:05 12:00:00' : '2026:05:04 12:00:00',
  }), idle, signal());
  const request = { ...scanned, destination, fields, dates: ['2026-05-04'] };
  const result = await archive(request, idle, signal());
  assert.equal(result.failed.length, 0);
  assert.equal(result.copied.length, 2);
  assert.deepEqual((await fs.readdir(path.join(destination, folderName('2026-05-04', fields)))).sort(),
    ['photo (1).ARW', 'photo.ARW']);
  assert.equal(await fs.readFile(path.join(source, 'photo.ARW'), 'utf8'), 'sony raw data');
  const repeated = await archive(request, idle, signal());
  assert.equal(repeated.copied.length, 2);
  assert.equal((await fs.readdir(path.join(destination, folderName('2026-05-04', fields)))).length, 4);
});

test('prevents copying back into source card', async t => {
  const { source } = await fixture(t);
  await assert.rejects(archive({
    source, destination: source, files: [], dates: ['2026-05-04'], fields,
  }, idle, signal()), /不能位于源存储卡/);
});

test('copies only the chosen photo IDs, even within one capture day', async t => {
  const { source, destination } = await fixture(t);
  for (const name of ['first.NEF', 'second.3FR', 'unknown.ARW']) await fs.writeFile(path.join(source, name), name);
  const scanned = await scan(source, async file => file.endsWith('.ARW') ? {} : { DateTimeOriginal: '2026:05:04 10:00:00' }, idle, signal());
  const request = { ...scanned, destination, fields };
  const wanted = scanned.files.find(file => file.name === 'second.3FR');
  const unknown = scanned.files.find(file => !file.date);
  for (const id of [unknown.id, 'stale-id']) {
    await assert.rejects(archive({ ...request, fileIds: [wanted.id, id] }, idle, signal()), /已失效或没有拍摄日期/);
    assert.deepEqual(await fs.readdir(destination), []);
  }
  const result = await archive({ ...request, fileIds: [wanted.id] }, idle, signal());
  assert.deepEqual(result.copied.map(file => file.name), ['second.3FR']);
  assert.deepEqual(await fs.readdir(path.join(destination, folderName(wanted.date, fields))), ['second.3FR']);
});

test('reuse copies selected files from multiple days directly and never overwrites', async t => {
  const { source, destination } = await fixture(t);
  const target = path.join(destination, 'existing');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'first.NEF'), 'keep');
  for (const name of ['first.NEF', 'second.3FR', 'unselected.ARW']) await fs.writeFile(path.join(source, name), name);
  const scanned = await scan(source, async file => ({ DateTimeOriginal: file.endsWith('.3FR') ? '2026:05:05' : '2026:05:04' }), idle, signal());
  const request = { ...scanned, mode: 'reuse', fileIds: scanned.files.filter(file => !file.name.startsWith('unselected')).map(file => file.id) };
  await assert.rejects(archive({ ...request, destination: path.join(destination, 'missing') }, idle, signal()), /无法访问归档目标/);
  await assert.rejects(archive({ ...request, destination: source }, idle, signal()), /不能位于源存储卡/);
  assert.deepEqual(await fs.readdir(destination), ['existing']);
  const result = await archive({ ...request, destination: target }, idle, signal());
  assert.equal(result.copied.length, 2);
  assert.equal(result.destination, await fs.realpath(target));
  assert.deepEqual((await fs.readdir(target)).sort(), ['first (1).NEF', 'first.NEF', 'second.3FR']);
  assert.equal(await fs.readFile(path.join(target, 'first.NEF'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(target, 'first (1).NEF'), 'utf8'), 'first.NEF');
});

test('detects source changes after scanning', async t => {
  const { source, destination } = await fixture(t);
  const input = path.join(source, 'one.NEF');
  await fs.writeFile(input, 'original');
  await assert.rejects(copyVerified(input, destination, 'one.NEF', { size: 1, modified: 0 }), /发生变化/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test('interruption retains completed results and stops before another file', async t => {
  const { source, destination } = await fixture(t);
  await fs.writeFile(path.join(source, 'one.NEF'), 'one');
  await fs.writeFile(path.join(source, 'two.NEF'), 'two');
  const scanned = await scan(source, async () => ({ DateTimeOriginal: '2026:05:04 10:00:00' }), idle, signal());
  const controller = new AbortController();
  let checks = 0;
  const result = await archive({ ...scanned, destination, fields, dates: ['2026-05-04'], checkLocations: async () => {
    if (++checks === 2) controller.abort();
  } }, idle, controller.signal);
  assert.equal(result.cancelled, true);
  assert.equal(result.copied.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal((await fs.readdir(path.dirname(result.copied[0].path))).length, 1);
});

test('cancellation never starts another file', async t => {
  const { source, destination } = await fixture(t);
  await fs.writeFile(path.join(source, 'one.CR3'), 'raw');
  const scanned = await scan(source, async () => ({ DateTimeOriginal: '2026:05:04 10:00:00' }), idle, signal());
  const controller = new AbortController();
  controller.abort();
  const result = await archive({ ...scanned, destination, fields, dates: ['2026-05-04'] }, idle, controller.signal);
  assert.equal(result.cancelled, true);
  assert.equal(result.copied.length, 0);
});

test('rejects an archive folder symlink escaping the target directory', async t => {
  const { source, destination, dir } = await fixture(t);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(source, 'one.FFF'), 'raw');
  const scanned = await scan(source, async () => ({ DateTimeOriginal: '2026:05:04 10:00:00' }), idle, signal());
  await fs.symlink(outside, path.join(destination, folderName('2026-05-04', fields)));
  const result = await archive({ ...scanned, destination, fields, dates: ['2026-05-04'] }, idle, signal());
  assert.equal(result.failed.length, 1);
  assert.deepEqual(await fs.readdir(outside), []);
});
