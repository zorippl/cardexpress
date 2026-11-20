const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cardExpress', {
  chooseFolder: kind => ipcRenderer.invoke('folder:choose', kind),
  scan: (format, scanId) => ipcRenderer.invoke('archive:scan', format, scanId),
  copy: request => ipcRenderer.invoke('archive:copy', request),
  cancel: () => ipcRenderer.invoke('archive:cancel'),
  reveal: () => ipcRenderer.invoke('folder:reveal'),
  preview: (id, kind) => ipcRenderer.invoke('photo:preview', id, kind),
  onScanFiles: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('archive:scan-files', listener);
    return () => ipcRenderer.removeListener('archive:scan-files', listener);
  },
  onLocationLost: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('folder:lost', listener);
    return () => ipcRenderer.removeListener('folder:lost', listener);
  },
  onProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('archive:progress', listener);
    return () => ipcRenderer.removeListener('archive:progress', listener);
  },
});
