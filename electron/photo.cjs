const fs = require('node:fs/promises');
const { dateFromTags, isWithin, EMBEDDED_PREVIEW_TAGS } = require('./archive.cjs');

const metadataArgs = ['-DateTimeOriginal', '-CreateDate', '-Make', '-Model', ...EMBEDDED_PREVIEW_TAGS.map(tag => `-${tag}`)];

async function readCaptureMetadata(tool, file, signal) {
  const fast = await tool.readRaw(file, { readArgs: ['-fast', ...metadataArgs] });
  // A slower retry can recover capture tags skipped by fast mode. Do not
  // prefer the fast CreateDate over a DateTimeOriginal found on the retry.
  if (signal?.aborted || dateFromTags({ DateTimeOriginal: fast.DateTimeOriginal })) return fast;
  return tool.readRaw(file, { readArgs: metadataArgs });
}

const previewTags = {
  thumb: EMBEDDED_PREVIEW_TAGS,
  full: ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'PreviewImage2', 'ThumbnailImage'],
};

function jpegData(buffer) {
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

function isJpeg(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function scaledPreview(image, kind) {
  if (image.isEmpty()) return null;
  const maxEdge = kind === 'thumb' ? 320 : 2048;
  const { width, height } = image.getSize();
  if (Math.max(width, height) > maxEdge) {
    image = image.resize({ [width >= height ? 'width' : 'height']: maxEdge, quality: 'best' });
  }
  const jpeg = image.toJPEG(kind === 'thumb' ? 78 : 88);
  return jpeg.length ? jpegData(jpeg) : null;
}

async function embeddedTag(tool, nativeImage, file, kind, tag) {
  try {
    const buffer = await tool.extractBinaryTagToBuffer(tag, file);
    if (buffer.length > 48 * 1024 * 1024 || !isJpeg(buffer)) return null;
    const image = nativeImage.createFromBuffer(buffer);
    // Preserve EXIF orientation and avoid re-encoding when the preview fits.
    if (image.isEmpty()) return null;
    if (kind === 'full' && buffer.length <= 3 * 1024 * 1024) {
      return jpegData(buffer);
    }
    if (kind === 'thumb' && buffer.length <= 64 * 1024) {
      const { width, height } = image.getSize();
      if (Math.max(width, height) <= 320) return jpegData(buffer);
    }
    return scaledPreview(image, kind);
  } catch { /* A malformed or missing embedded image is not a scan error. */ }
  return null;
}

async function renderJpegPreview(tool, nativeImage, real, file, kind) {
  // Standalone JPEGs do not need RAW tag discovery. For thumbnails, use the
  // embedded small image when available so large JPEGs aren't fully decoded.
  if (kind === 'thumb' && file.previewHints?.includes('ThumbnailImage')) {
    const image = await embeddedTag(tool, nativeImage, real, kind, 'ThumbnailImage');
    if (image) return image;
  }
  if (kind === 'full' && file.size <= 3 * 1024 * 1024) {
    const buffer = await fs.readFile(real);
    if (isJpeg(buffer) && !nativeImage.createFromBuffer(buffer).isEmpty()) return jpegData(buffer);
  }
  return scaledPreview(nativeImage.createFromPath(real), kind);
}

async function renderEmbeddedPreview(tool, nativeImage, file, kind, hints = []) {
  const extract = tag => embeddedTag(tool, nativeImage, file, kind, tag);
  let tags = previewTags[kind];
  if (kind === 'thumb' && hints.length) {
    for (const tag of tags) {
      if (!hints.includes(tag)) continue;
      const image = await extract(tag);
      if (image) return image;
    }
    // Fast metadata may miss tags. Keep full discovery as a fallback.
    tags = tags.filter(tag => !hints.includes(tag));
    if (!tags.length) return null;
  }
  const available = await tool.readRaw(file, { readArgs: tags.map(tag => `-${tag}`) });
  for (const tag of tags) {
    if (!available[tag]) continue;
    const image = await extract(tag);
    if (image) return image;
  }
  return null;
}

// System RAW previews can decode a large image even for a small thumbnail.
// Run one at a time and let clicked photos jump ahead of queued thumbnails.
function systemPreviewQueue(createThumbnail) {
  const full = [], thumbs = [];
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (full.length || thumbs.length) {
        const { file, kind, isCurrent, resolve } = full.shift() || thumbs.shift();
        let value = null;
        try {
          if (isCurrent()) {
            const edge = kind === 'thumb' ? 320 : 2048;
            const image = await createThumbnail(file, { width: edge, height: edge });
            if (isCurrent() && !image.isEmpty()) {
              const jpeg = image.toJPEG(kind === 'thumb' ? 78 : 88);
              if (jpeg.length) value = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
            }
          }
        } catch { /* This OS or file might not have a RAW thumbnail provider. */ }
        resolve(value);
      }
    } finally { running = false; }
  }
  return (file, kind, isCurrent) => new Promise(resolve => {
    (kind === 'full' ? full : thumbs).push({ file, kind, isCurrent, resolve });
    void drain();
  });
}

function previews(tool, nativeImage, createSystemThumbnail) {
  const cache = new Map();
  const pending = new Map();
  let cacheSize = 0;
  const maxSize = 32 * 1024 * 1024;
  let generation = 0;
  const systemPreview = createSystemThumbnail && systemPreviewQueue(createSystemThumbnail);
  return {
    clear() { generation++; cache.clear(); pending.clear(); cacheSize = 0; },
    get(root, file, kind) {
      const key = `${file.id}:${kind}`;
      if (cache.has(key)) {
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return Promise.resolve(value);
      }
      if (pending.has(key)) return pending.get(key);
      const current = generation;
      const job = (async () => {
        const real = await fs.realpath(file.path);
        if (!isWithin(root, real)) throw new Error('照片已不在来源文件夹中');
        const stat = await fs.stat(real);
        if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.modified) {
          throw new Error('照片已变化，请重新扫描');
        }
        if (current !== generation) return null;
        let value = null, embeddedError;
        try {
          value = file.format === 'jpg' ? await renderJpegPreview(tool, nativeImage, real, file, kind)
            : await renderEmbeddedPreview(tool, nativeImage, real, kind, file.previewHints);
        }
        catch (error) { embeddedError = error; }
        if (!value && systemPreview && current === generation) {
          value = await systemPreview(real, kind, () => current === generation);
        }
        if (!value && embeddedError && current === generation) throw embeddedError;
        if (current === generation) {
          cache.set(key, value);
          cacheSize += value?.length || 0;
          while (cacheSize > maxSize || cache.size > 240) {
            const oldest = cache.keys().next().value;
            cacheSize -= cache.get(oldest)?.length || 0;
            cache.delete(oldest);
          }
        }
        return value;
      })().finally(() => { if (pending.get(key) === job) pending.delete(key); });
      pending.set(key, job);
      return job;
    },
  };
}

module.exports = { readCaptureMetadata, renderEmbeddedPreview, previews };
