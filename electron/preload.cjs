const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktop: true,
  openFile: () => ipcRenderer.invoke('desktop:open-file'),
  saveFile: (sourcePath, extension, suffix) => ipcRenderer.invoke('desktop:save-file', sourcePath, extension, suffix),
  probeMedia: (filePath) => ipcRenderer.invoke('desktop:probe-media', filePath),
  runLosslessCut: (payload) => ipcRenderer.invoke('desktop:run-lossless-cut', payload),
  runConvert: (payload) => ipcRenderer.invoke('desktop:run-convert', payload)
});
