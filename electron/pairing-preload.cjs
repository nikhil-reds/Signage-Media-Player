const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pairing', {
  getDefaults: () => ipcRenderer.invoke('pairing:defaults'),
  submit: (apiBaseUrl, code) => ipcRenderer.invoke('pairing:submit', { apiBaseUrl, code }),
  reset: () => ipcRenderer.invoke('pairing:reset')
});
