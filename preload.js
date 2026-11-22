'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('zb', {
  pathFor: (file) => webUtils.getPathForFile(file),
  dlgOpen: () => ipcRenderer.invoke('dlg:open'),
  dlgDir: (def) => ipcRenderer.invoke('dlg:dir', def),
  dlgFiles: () => ipcRenderer.invoke('dlg:files'),
  dlgFolder: () => ipcRenderer.invoke('dlg:folder'),
  dlgSave: (def, fmt) => ipcRenderer.invoke('dlg:save', def, fmt),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),

  open: (file, password) => ipcRenderer.invoke('arc:open', file, password),
  extract: (o) => ipcRenderer.invoke('arc:extract', o),
  openEntry: (o) => ipcRenderer.invoke('arc:openEntry', o),
  create: (o) => ipcRenderer.invoke('arc:create', o),
  add: (o) => ipcRenderer.invoke('arc:add', o),
  remove: (o) => ipcRenderer.invoke('arc:remove', o),
  test: (o) => ipcRenderer.invoke('arc:test', o),

  onProgress: (cb) => ipcRenderer.on('progress', (_e, v) => cb(v)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
