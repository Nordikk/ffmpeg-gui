const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktop: true,
  openFile: () => ipcRenderer.invoke('desktop:open-file'),
  saveFile: (sourcePath, extension) => ipcRenderer.invoke('desktop:save-file', sourcePath, extension),
  probeMedia: (filePath) => ipcRenderer.invoke('desktop:probe-media', filePath),
  runLosslessCut: (payload) => ipcRenderer.invoke('desktop:run-lossless-cut', payload)
});
