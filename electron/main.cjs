const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('node:path');
const { ExifTool } = require('exiftool-vendored');
const { scan, archive } = require('./archive.cjs');
const { readCaptureMetadata, previews } = require('./photo.cjs');
const { identifyLocation, isSameLocation } = require('./location.cjs');

let window;
let exiftool;
let previewTool;
let photoPreviews;
let scannedPhotos = new Map();
let currentScan;
let sourceLocation;
let operation;
let operationUsesTarget = false;
let allowedDestination;
let lastOutput;
const locationChecks = new WeakMap();

function progress(payload) {
  if (window && !window.isDestroyed()) window.webContents.send('archive:progress', payload);
}

function publicPhoto({ path: _path, modified: _modified, previewHints: _hints, ...file }) {
  return file;
}

function checkLocation(kind, location) {
  if (!location) return Promise.resolve(false);
  if (locationChecks.has(location)) return locationChecks.get(location);
  const check = (async () => {
    const available = await isSameLocation(location);
    const current = kind === 'source' ? sourceLocation : allowedDestination;
    if (current !== location) return false;
    if (available) return true;
    if (kind === 'source') {
      sourceLocation = null;
      currentScan = null;
      scannedPhotos.clear();
      photoPreviews.clear();
      operation?.abort();
    } else {
      allowedDestination = null;
      lastOutput = null;
      if (operationUsesTarget) operation?.abort();
    }
    if (window && !window.isDestroyed()) window.webContents.send('folder:lost', { kind, path: location.path });
    return false;
  })().finally(() => locationChecks.delete(location));
  locationChecks.set(location, check);
  return check;
}

async function checkCopyPaths(source, target) {
  const [hasSource, hasTarget] = await Promise.all([checkLocation('source', source), checkLocation('target', target)]);
  return hasSource && hasTarget;
}

function registerHandlers() {
  ipcMain.handle('folder:choose', async (_event, kind) => {
    if (!['source', 'target', 'existing'].includes(kind)) throw new Error('目录类型无效');
    if (operation) throw new Error('请先等待当前任务结束');
    const response = await dialog.showOpenDialog(window, {
      title: kind === 'source' ? '选择存储卡或照片文件夹' : kind === 'existing' ? '选择已有归档文件夹' : '选择归档目标路径',
      properties: kind === 'target' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    });
    if (response.canceled) return null;
    const chosen = response.filePaths[0];
    let location;
    try { location = await identifyLocation(chosen); }
    catch { throw new Error('所选文件夹已无法访问，请重新选择'); }
    if (operation) throw new Error('请先等待当前任务结束');
    if (kind !== 'source') allowedDestination = { ...location, mode: kind === 'existing' ? 'reuse' : 'new' };
    else {
      scannedPhotos.clear();
      photoPreviews.clear();
      sourceLocation = location;
      currentScan = { source: location.real, files: [] };
    }
    return chosen;
  });
  ipcMain.handle('archive:scan', async (event, format = 'raw', scanId) => {
    if (format !== 'raw' && format !== 'jpg') throw new Error('图片格式模式无效');
    if (operation) throw new Error('已有任务正在执行');
    if (!currentScan) throw new Error('请先选择存储卡');
    const source = sourceLocation;
    operation = new AbortController();
    try {
      if (!await checkLocation('source', source)) return null;
      photoPreviews.clear();
      scannedPhotos.clear();
      currentScan = { source: source.real, files: [] };
      const scanned = await scan(source.real, (file, signal) => readCaptureMetadata(exiftool, file, signal),
        progress, operation.signal, 4, format, files => {
          if (sourceLocation !== source || event.sender.isDestroyed() || !Number.isSafeInteger(scanId)) return;
          for (const file of files) scannedPhotos.set(file.id, file);
          event.sender.send('archive:scan-files', { scanId, files: files.map(publicPhoto) });
        });
      if (!await checkLocation('source', source)) return null;
      currentScan = scanned;
      scannedPhotos = new Map(currentScan.files.map(file => [file.id, file]));
      return { ...currentScan, files: currentScan.files.map(publicPhoto) };
    } catch (error) {
      if (!await checkLocation('source', source)) return null;
      scannedPhotos.clear();
      photoPreviews.clear();
      throw error;
    } finally { operation = null; }
  });
  ipcMain.handle('photo:preview', async (_event, id, kind) => {
    if (!currentScan || (kind !== 'thumb' && kind !== 'full')) return null;
    const file = scannedPhotos.get(id);
    if (!file) return null;
    const source = sourceLocation;
    try { return await photoPreviews.get(source.real, file, kind); }
    catch (error) {
      if (!await checkLocation('source', source)) return null;
      throw error;
    }
  });
  ipcMain.handle('archive:copy', async (_event, request) => {
    if (operation) throw new Error('已有任务正在执行');
    if (!currentScan || !allowedDestination) throw new Error('请先扫描存储卡并选择目标路径');
    if (!Array.isArray(request?.fileIds) || request.mode !== allowedDestination.mode ||
        (request.mode === 'new' && !request.fields) || request.fileIds.length > currentScan.files.length ||
        request.fileIds.some(id => typeof id !== 'string' || !scannedPhotos.has(id))) throw new Error('归档参数无效，请重新选择照片');
    const source = sourceLocation, target = allowedDestination, files = currentScan.files;
    const check = () => checkCopyPaths(source, target);
    operation = new AbortController();
    operationUsesTarget = true;
    try {
      if (!await check()) return null;
      const result = await archive({
        source: source.real, files, checkLocations: check,
        fileIds: request.fileIds, fields: request.fields, mode: request.mode, destination: target.real,
      }, progress, operation.signal);
      await check();
      lastOutput = allowedDestination === target ? result.destination : null;
      return result;
    } catch (error) {
      if (!await check()) return null;
      throw error;
    } finally { operation = null; operationUsesTarget = false; }
  });
  ipcMain.handle('archive:cancel', () => { operation?.abort(); });
  ipcMain.handle('folder:reveal', async () => {
    if (lastOutput) {
      const error = await shell.openPath(lastOutput);
      if (error) throw new Error(error);
    }
  });
}

app.whenReady().then(() => {
  exiftool = new ExifTool({ maxProcs: 4, taskTimeoutMillis: 30000 });
  previewTool = new ExifTool({ maxProcs: 2, taskTimeoutMillis: 15000, taskRetries: 0 });
  photoPreviews = previews(previewTool, nativeImage,
    process.platform === 'darwin' ? (file, size) => nativeImage.createThumbnailFromPath(file, size) : undefined);
  registerHandlers();
  const monitor = setInterval(() => {
    if (sourceLocation) void checkLocation('source', sourceLocation);
    if (allowedDestination) void checkLocation('target', allowedDestination);
  }, 2000);
  monitor.unref();
  function createWindow() {
    window = new BrowserWindow({
      width: 1380, height: 900, minWidth: 1060, minHeight: 720,
      title: 'CardExpress', backgroundColor: '#111111',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    if (!app.isPackaged && process.argv.includes('--dev')) {
      window.loadURL('http://127.0.0.1:5173');
    } else {
      window.loadFile(path.join(__dirname, '../dist/index.html'));
    }
    window.on('close', event => {
      if (!operation) return;
      event.preventDefault();
      dialog.showMessageBox(window, {
        type: 'info', message: '任务正在进行，请先停止任务再关闭窗口。',
        detail: '复制会在当前文件完成校验后停止，避免留下不完整文件。', buttons: ['知道了'],
      });
    });
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let exiting = false;
app.on('before-quit', event => {
  if (operation) {
    event.preventDefault();
    if (window && !window.isDestroyed()) {
      dialog.showMessageBox(window, {
        type: 'info', message: '请先停止当前任务，再退出应用。',
        detail: '复制会在当前文件完成校验后停止。', buttons: ['知道了'],
      });
    }
    return;
  }
  if (exiting || !exiftool) return;
  event.preventDefault();
  operation?.abort();
  Promise.allSettled([exiftool.end(), previewTool.end(false)]).finally(() => { exiting = true; app.quit(); });
});
