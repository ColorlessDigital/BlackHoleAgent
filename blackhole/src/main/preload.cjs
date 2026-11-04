const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blackhole', {
  getApiConfig: () => ipcRenderer.invoke('blackhole:getApiConfig'),
  selectWorkspace: () => ipcRenderer.invoke('blackhole:selectWorkspace'),
  selectLlamaServer: () => ipcRenderer.invoke('blackhole:selectLlamaServer'),
  selectGgufModel: () => ipcRenderer.invoke('blackhole:selectGgufModel'),
  minimize: () => ipcRenderer.send('blackhole:minimize'),
  maximize: () => ipcRenderer.send('blackhole:maximize'),
  close: () => ipcRenderer.send('blackhole:close')
});
