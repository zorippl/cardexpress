const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ExifTool } = require('exiftool-vendored');
const { dateFromTags } = require('../electron/archive.cjs');
const { readCaptureMetadata, renderEmbeddedPreview, previews } = require('../electron/photo.cjs');

test('bundled ExifTool runs and reads capture metadata without UTC date shifting', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardexpress-exif-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tool = new ExifTool({ maxProcs: 1 });
  t.after(() => tool.end());
  // Synthetic XMP checks the real ExifTool runtime, not RAW camera compatibility.
  const file = path.join(dir, 'capture.xmp');
  await fs.writeFile(file, `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/"
      exif:DateTimeOriginal="2026-05-04T00:10:00+08:00" />
  </rdf:RDF>
</x:xmpmeta>`);
  const tags = await readCaptureMetadata(tool, file);
  assert.equal(dateFromTags(tags), '2026-05-04');
  assert.ok(await tool.version());
});

test('fast scan retries missing original dates without preferring a creation date', async () => {
  const args = [];
  const tool = { readRaw: async (_file, options) => {
    args.push(options.readArgs);
    return options.readArgs.includes('-fast') ? { CreateDate: '2026:05:05' }
      : { DateTimeOriginal: '2026:05:04', CreateDate: '2026:05:05' };
  } };
  assert.equal(dateFromTags(await readCaptureMetadata(tool, 'test.3FR')), '2026-05-04');
  assert.equal(args.length, 2);
  assert.ok(args[0].includes('-fast'));
  assert.ok(!args[1].includes('-fast'));
});

test('preview skips bad embedded images and falls back to the next available JPEG tag', async () => {
  const calls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const image = { isEmpty: () => false, getSize: () => ({ width: 640, height: 480 }),
    resize: ({ width }) => { assert.equal(width, 320); return image; }, toJPEG: () => jpeg };
  const tool = {
    readRaw: async () => ({ ThumbnailImage: 'binary', JpgFromRaw: 'binary' }),
    extractBinaryTagToBuffer: async tag => { calls.push(tag); return tag === 'ThumbnailImage' ? Buffer.from('bad') : jpeg; },
  };
  assert.equal(await renderEmbeddedPreview(tool, { createFromBuffer: () => image }, 'a.3FR', 'thumb'), `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.deepEqual(calls, ['ThumbnailImage', 'JpgFromRaw']);
  assert.equal(await renderEmbeddedPreview({ readRaw: async () => ({}) }, null, 'b.3FR', 'full'), null);
});

test('a thumbnail found during scanning skips tag discovery, with fallback for damaged thumbnails', async () => {
  const calls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let badThumbnail = false;
  const tool = {
    readRaw: async (_file, { readArgs }) => {
      calls.push('lookup');
      assert.ok(!readArgs.includes('-ThumbnailImage'));
      return { PreviewImage: 'binary' };
    },
    extractBinaryTagToBuffer: async tag => {
      calls.push(tag);
      return badThumbnail && tag === 'ThumbnailImage' ? Buffer.from('bad') : jpeg;
    },
  };
  const nativeImage = { createFromBuffer: () => ({
    isEmpty: () => false, getSize: () => ({ width: 160, height: 120 }), toJPEG: () => jpeg,
  }) };
  const expected = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  assert.equal(await renderEmbeddedPreview(tool, nativeImage, 'a.NEF', 'thumb', ['ThumbnailImage']), expected);
  assert.deepEqual(calls, ['ThumbnailImage']);
  calls.length = 0;
  badThumbnail = true;
  assert.equal(await renderEmbeddedPreview(tool, nativeImage, 'a.NEF', 'thumb', ['ThumbnailImage']), expected);
  assert.deepEqual(calls, ['ThumbnailImage', 'lookup', 'PreviewImage']);
});

test('reuses a known small embedded preview without rereading tags or re-encoding it', async () => {
  const calls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const tool = {
    readRaw: async () => { calls.push('lookup'); return {}; },
    extractBinaryTagToBuffer: async tag => { calls.push(tag); return jpeg; },
  };
  const nativeImage = { createFromBuffer: () => ({
    isEmpty: () => false, getSize: () => ({ width: 300, height: 225 }),
    toJPEG: () => { calls.push('encode'); return jpeg; },
  }) };
  assert.equal(await renderEmbeddedPreview(tool, nativeImage, 'a.NEF', 'thumb', ['PreviewImage']), `data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.deepEqual(calls, ['PreviewImage']);
});

test('preview caches missing images and does not read files outside the scanned source', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardexpress-preview-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'card');
  await fs.mkdir(source);
  const input = path.join(source, 'sample.NEF');
  await fs.writeFile(input, 'raw fixture');
  const stat = await fs.stat(input);
  let reads = 0;
  const service = previews({ readRaw: async () => { reads++; return {}; } }, null);
  const photo = { id: 'photo', path: input, size: stat.size, modified: stat.mtimeMs };
  assert.deepEqual(await Promise.all([service.get(source, photo, 'thumb'), service.get(source, photo, 'thumb')]), [null, null]);
  assert.equal(await service.get(source, photo, 'thumb'), null);
  assert.equal(reads, 1);
  service.clear();
  await assert.rejects(service.get(path.join(dir, 'another-card'), photo, 'thumb'), /不在来源文件夹/);
  assert.equal(reads, 1);
});

test('JPG preview falls back to decoding the original and skips RAW tag discovery', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardexpress-jpg-preview-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'sample.JPEG');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await fs.writeFile(input, jpeg);
  const stat = await fs.stat(input);
  const checks = [];
  const image = { isEmpty: () => false, getSize: () => ({ width: 640, height: 480 }),
    resize: ({ width }) => { checks.push(width); return image; }, toJPEG: () => jpeg };
  const service = previews({
    readRaw: async () => { checks.push('RAW discovery'); return {}; },
    extractBinaryTagToBuffer: async tag => { checks.push(tag); return Buffer.from('invalid'); },
  }, {
    createFromPath: file => { assert.equal(file, input); return image; },
    createFromBuffer: buffer => { assert.deepEqual(buffer, jpeg); return image; },
  });
  const photo = { id: 'jpg', path: input, format: 'jpg', size: stat.size, modified: stat.mtimeMs, previewHints: ['ThumbnailImage'] };
  const expected = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  assert.equal(await service.get(dir, photo, 'thumb'), expected);
  assert.equal(await service.get(dir, photo, 'full'), expected);
  assert.deepEqual(checks, ['ThumbnailImage', 320]);
});

test('system previews fall back on missing or unreadable embedded previews and cache the result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardexpress-system-preview-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const photos = [];
  for (const id of ['first', 'second', 'third']) {
    const input = path.join(dir, `${id}.3FR`);
    await fs.writeFile(input, 'raw fixture');
    const stat = await fs.stat(input);
    photos.push({ id, path: input, size: stat.size, modified: stat.mtimeMs });
  }
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const tool = { readRaw: async input => {
    if (input.endsWith('third.3FR')) throw new Error('ExifTool error');
    return {};
  } };
  const service = previews(tool, null, async (input, size) => {
    calls.push([path.basename(input), size]);
    if (input.endsWith('first.3FR')) { started(); await held; }
    return { isEmpty: () => false, toJPEG: () => Buffer.from('preview') };
  });
  const first = service.get(dir, photos[0], 'thumb');
  await firstStarted;
  const second = service.get(dir, photos[1], 'thumb');
  const third = service.get(dir, photos[2], 'full');
  release();
  const expected = 'data:image/jpeg;base64,cHJldmlldw==';
  assert.deepEqual(await Promise.all([first, second, third]), [expected, expected, expected]);
  assert.ok(calls.some(([name, size]) => name === 'third.3FR' && size.width === 2048 && size.height === 2048));
  assert.equal(await service.get(dir, photos[2], 'full'), expected);
  assert.equal(calls.length, 3);
});
