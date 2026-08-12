'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Overlay (capture / annotate) API
contextBridge.exposeInMainWorld('snapshot', {
  onInit: (cb) => ipcRenderer.on('init-capture', (_e, data) => cb(data)),
  onReset: (cb) => ipcRenderer.on('overlay:reset', () => cb()),
  onAction: (cb) => ipcRenderer.on('overlay:action', (_e, action) => cb(action)),
  activate: () => ipcRenderer.send('overlay:activate'),
  ready: () => ipcRenderer.send('overlay:ready'),
  save: (dataURL) => ipcRenderer.invoke('overlay:save', dataURL),
  copy: (dataURL) => ipcRenderer.send('overlay:copy', dataURL),
  close: () => ipcRenderer.send('overlay:close'),
});

// Settings window API
contextBridge.exposeInMainWorld('settingsAPI', {
  onInit: (cb) => ipcRenderer.on('settings:init', (_e, data) => cb(data)),
  save: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  close: () => ipcRenderer.send('settings:close'),
});
