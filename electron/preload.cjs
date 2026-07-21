const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signlinkPlayer', {
  onPlaylistUpdated(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('playlist.updated', (_event, playlist) => callback(playlist));
  }
});
