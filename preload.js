const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coveAPI', {
  appInfo:        ()     => ipcRenderer.invoke('cove:appInfo'),
  getState:       ()     => ipcRenderer.invoke('cove:getState'),
  scan:           (opts) => ipcRenderer.invoke('cove:scan', opts || {}),
  install:        (slug) => ipcRenderer.invoke('cove:install', slug),
  update:         (slug) => ipcRenderer.invoke('cove:update', slug),
  launch:         (slug) => ipcRenderer.invoke('cove:launch', slug),
  uninstall:      (slug) => ipcRenderer.invoke('cove:uninstall', slug),
  revealInstall:  (slug) => ipcRenderer.invoke('cove:revealInstall', slug),
  discover:       (opts) => ipcRenderer.invoke('cove:discover', opts || {}),

  win: {
    close:            () => ipcRenderer.invoke('cove:window:close'),
    minimize:         () => ipcRenderer.invoke('cove:window:minimize'),
    maximizeToggle:   () => ipcRenderer.invoke('cove:window:maximizeToggle'),
    isMaximized:      () => ipcRenderer.invoke('cove:window:isMaximized'),
    onStateChanged:   (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('cove:window:stateChanged', h);
      return () => ipcRenderer.removeListener('cove:window:stateChanged', h);
    },
  },
});
