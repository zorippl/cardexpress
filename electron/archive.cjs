const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream, constants } = require('node:fs');

const RAW_EXTENSIONS = new Set([
  '.arw', '.sr2', '.srf', '.cr2', '.cr3', '.crw', '.nef', '.nrw',
  '.3fr', '.fff', '.dng', '.raf', '.orf', '.rw2', '.rwl', '.pef',
  '.ptx', '.srw', '.x3f', '.iiq', '.cap', '.mos', '.mrw', '.erf',
]);
const JPG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const EMBEDDED_PREVIEW_TAGS = ['ThumbnailImage', 'PreviewImage', 'JpgFromRaw', 'OtherImage', 'PreviewImage2'];

function captureFromTags(tags) {
  // Intentionally don't use filesystem times or UTC conversion.
  for (const value of [tags.DateTimeOriginal, tags.CreateDate]) {
    if (!value) continue;
    let year, month, day, hour, minute, second;
    if (typeof value === 'object') {
      ({ year, month, day, hour, minute, second } = value);
    } else {
      const match = String(value).match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
      if (match) [, year, month, day, hour, minute, second] = match.map(Number);
    }
    if (!year || !month || !day) continue;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (year >= 1900 && year <= 9999 && parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) {
      const pad = number => String(number).padStart(2, '0');
      const hasTime = Number.isInteger(hour) && hour >= 0 && hour < 24 &&
        Number.isInteger(minute) && minute >= 0 && minute < 60;
      const hasSeconds = Number.isInteger(second) && second >= 0 && second < 60;
      return { date: `${year}-${pad(month)}-${pad(day)}`,
        time: hasTime ? `${pad(hour)}:${pad(minute)}${hasSeconds ? `:${pad(second)}` : ''}` : null };
    }
  }
  return { date: null, time: null };
}

const dateFromTags = tags => captureFromTags(tags).date;

function validateField(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${name}`);
  const clean = value.trim();
  if (clean.length > 60 || /[<>:"/\\|?*\x00-\x1f]/.test(clean) || /[. ]$/.test(clean) ||
      clean === '.' || clean === '..') {
    throw new Error(`${name}不能包含路径符号、特殊字符，或超过 60 个字符`);
  }
  return clean;
}

function folderName(date, fields) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('拍摄日期无效');
  const name = `${date.replaceAll('-', '')}_${validateField(fields.location, '地点')}_${validateField(fields.theme, '主题')}_${validateField(fields.model, '模特')}`;
  if (Buffer.byteLength(name, 'utf8') > 240) throw new Error('归档文件夹名过长，请缩短地点、主题或模特名称');
  return name;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function scan(source, readMetadata, onProgress, signal, workers = 4, format = 'raw', onFiles) {
  if (format !== 'raw' && format !== 'jpg') throw new Error('图片格式模式无效');
  const extensions = format === 'jpg' ? JPG_EXTENSIONS : RAW_EXTENSIONS;
  const root = await fs.realpath(source);
  const candidates = [];
  const warnings = [];
  async function walk(dir) {
    if (signal.aborted) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (dir === root) throw error;
      warnings.push(`无法读取目录：${dir}（${error.message}）`);
      return;
    }
    for (const entry of entries) {
      if (signal.aborted) return;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        candidates.push(fullPath);
      }
    }
  }
  onProgress({ phase: 'discover', done: 0, total: 0 });
  await walk(root);
  const files = new Array(candidates.length);
  let cursor = 0, done = 0, lastUpdate = 0;
  let batch = [], lastBatch = Date.now(), sentBatch = false;
  function flushBatch() {
    if (!batch.length) return;
    onFiles(batch);
    batch = [];
    lastBatch = Date.now();
    sentBatch = true;
  }
  onProgress({ phase: 'metadata', done, total: candidates.length });
  async function readNext() {
    while (!signal.aborted && cursor < candidates.length) {
      const index = cursor++;
      const filePath = candidates[index];
      const name = path.basename(filePath);
      try {
        const stat = await fs.stat(filePath);
        if (signal.aborted) return;
        let tags = {}, metadataError = null;
        try { tags = await readMetadata(filePath, signal); }
        catch (error) { metadataError = error.message; }
        files[index] = {
          id: crypto.randomUUID(), path: filePath, name, format,
          relativePath: path.relative(root, filePath), size: stat.size,
          modified: stat.mtimeMs, ...captureFromTags(tags),
          camera: [tags.Make, tags.Model].filter(Boolean).join(' '),
          previewHints: EMBEDDED_PREVIEW_TAGS.filter(tag => tags[tag]),
          metadataError,
        };
      } catch (error) { warnings.push(`无法读取文件：${filePath}（${error.message}）`); }
      if (onFiles && files[index] && !signal.aborted) {
        batch.push(files[index]);
        if (!sentBatch || Date.now() - lastBatch >= 200) flushBatch();
      }
      done++;
      if (done === candidates.length || Date.now() - lastUpdate >= 100) {
        lastUpdate = Date.now();
        onProgress({ phase: 'metadata', done, total: candidates.length, current: name });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, candidates.length) }, readNext));
  if (!signal.aborted) flushBatch();
  return { source: root, files: files.filter(Boolean), warnings, cancelled: signal.aborted };
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyVerified(source, destinationDir, name, expected) {
  const stat = await fs.stat(source);
  if (expected && (stat.size !== expected.size || stat.mtimeMs !== expected.modified)) {
    throw new Error('源文件在扫描后发生变化，请重新扫描');
  }
  const sourceHash = await hashFile(source);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let destination;
  let created = false;
  for (let index = 0; index < 10000; index++) {
    destination = path.join(destinationDir, index ? `${base} (${index})${ext}` : name);
    try {
      // COPYFILE_EXCL protects existing files, including collisions from different cameras.
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      created = true;
      break;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    // No destructive overwrite, even if another process creates a file concurrently.
  }
  if (!created) throw new Error('无法分配目标文件名');
  try {
    if (await hashFile(destination) !== sourceHash) throw new Error('SHA-256 校验失败');
    await fs.utimes(destination, stat.atime, stat.mtime);
    return destination;
  } catch (error) {
    await fs.unlink(destination).catch(() => {});
    throw error;
  }
}

async function archive({ source, files, dates, fileIds, destination, fields, mode = 'new', checkLocations }, onProgress, signal) {
  if (mode !== 'new' && mode !== 'reuse') throw new Error('归档模式无效');
  const root = await fs.realpath(source);
  let target;
  try {
    target = await fs.realpath(destination);
    if (!(await fs.stat(target)).isDirectory()) throw new Error('目标不是文件夹');
  } catch (error) {
    throw new Error(`无法访问归档目标，请重新选择文件夹：${error.message}`);
  }
  if (isWithin(root, target)) throw new Error('目标路径不能位于源存储卡内，请选择电脑或其他磁盘');
  const ids = fileIds === undefined ? null : new Set(fileIds);
  const dateSet = new Set(dates);
  const selected = files.filter(file => file.date && (ids ? ids.has(file.id) : dateSet.has(file.date)));
  if (ids && selected.length !== ids.size) throw new Error('部分选中的照片已失效或没有拍摄日期，请重新选择');
  if (!selected.length) throw new Error('请至少选择一张有拍摄日期的照片');
  // Validate all fields before writing anything.
  if (mode === 'new') {
    for (const date of new Set(selected.map(file => file.date))) folderName(date, fields);
  }
  const result = { copied: [], failed: [], cancelled: false, destination: target };
  const folders = new Map();
  for (const file of selected) {
    if (!signal.aborted && checkLocations) await checkLocations();
    if (signal.aborted) { result.cancelled = true; break; }
    onProgress({ phase: 'copy', done: result.copied.length + result.failed.length,
      total: selected.length, current: file.name });
    try {
      let dir = mode === 'reuse' ? target : folders.get(file.date);
      if (!dir) {
        dir = path.join(target, folderName(file.date, fields));
        // Never recreate a missing target or mount point after disconnection.
        try { await fs.mkdir(dir); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const real = await fs.realpath(dir);
        if (!isWithin(target, real) || isWithin(root, real)) {
          throw new Error('归档目录指向了不安全的位置');
        }
        dir = real;
        folders.set(file.date, dir);
      }
      const sourcePath = await fs.realpath(file.path);
      if (!isWithin(root, sourcePath)) throw new Error('源文件已移动到存储卡范围之外');
      const output = await copyVerified(sourcePath, dir, file.name, file);
      result.copied.push({ name: file.name, path: output });
    } catch (error) { result.failed.push({ name: file.name, error: error.message }); }
  }
  if (signal.aborted) result.cancelled = true;
  onProgress({ phase: 'copy', done: result.copied.length + result.failed.length, total: selected.length });
  return result;
}

module.exports = { RAW_EXTENSIONS, EMBEDDED_PREVIEW_TAGS, captureFromTags, dateFromTags, validateField, folderName, isWithin, scan, archive, copyVerified };
