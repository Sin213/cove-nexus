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
  releases:           (slug) => ipcRenderer.invoke('cove:releases', slug),
  latestReleases:     (slugs) => ipcRenderer.invoke('cove:latestReleases', slugs),
  confirmUpdateAll:   (names) => ipcRenderer.invoke('cove:confirmUpdateAll', names),
  pin:            (slug, tag) => ipcRenderer.invoke('cove:pin', slug, tag),
  unpin:          (slug) => ipcRenderer.invoke('cove:unpin', slug),
  setCustomPath:  (slug) => ipcRenderer.invoke('cove:setCustomPath', slug),

  refresh:            () => ipcRenderer.invoke('cove:refresh'),
  rateLimit:          () => ipcRenderer.invoke('cove:rateLimit'),

  onInstallProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('cove:install:progress', h);
    return () => ipcRenderer.removeListener('cove:install:progress', h);
  },

  config: {
    get:                 () => ipcRenderer.invoke('cove:config:get'),
    setProgramsRoot:     () => ipcRenderer.invoke('cove:config:setProgramsRoot'),
    revealConfigDir:     () => ipcRenderer.invoke('cove:config:revealConfigDir'),
    revealProgramsRoot:  () => ipcRenderer.invoke('cove:config:revealProgramsRoot'),
    setGithubToken:      (tok) => ipcRenderer.invoke('cove:config:setGithubToken', tok),
    setPreferences:      (prefs) => ipcRenderer.invoke('cove:config:setPreferences', prefs),
  },

  onTrayCheckUpdates: (cb) => {
    const h = () => cb();
    ipcRenderer.on('cove:tray:checkUpdates', h);
    return () => ipcRenderer.removeListener('cove:tray:checkUpdates', h);
  },

  onSelfUpdateAvailable: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('cove:self:updateAvailable', h);
    return () => ipcRenderer.removeListener('cove:self:updateAvailable', h);
  },

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
