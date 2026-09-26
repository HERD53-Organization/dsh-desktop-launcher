'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Renderer bridge. Deliberately narrow: the diagnostics page may read status
 * and ask the main process to act, but it can never reach the filesystem, the
 * child process, or a token-bearing URL.
 */
contextBridge.exposeInMainWorld('launcher', {
  snapshot: () => ipcRenderer.invoke('launcher:snapshot'),
  openDsh: () => ipcRenderer.invoke('launcher:open-dsh'),
  restart: () => ipcRenderer.invoke('launcher:restart'),
  checkUpdates: () => ipcRenderer.invoke('launcher:check-updates'),
  openPath: (target) => ipcRenderer.invoke('launcher:open-path', target),
  copyText: (value) => ipcRenderer.invoke('launcher:copy-url', value),
  onState: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('launcher:state', handler);
    return () => ipcRenderer.removeListener('launcher:state', handler);
  },
  onUpdate: (listener) => {
    const handler = (_event, update) => listener(update);
    ipcRenderer.on('launcher:update', handler);
    return () => ipcRenderer.removeListener('launcher:update', handler);
  },
});
