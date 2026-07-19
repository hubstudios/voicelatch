'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const PUSH_CHANNELS = new Set([
  'models:progress', 'history:changed', 'settings:changed',
  'engine:status', 'onboarding:done',
]);

contextBridge.exposeInMainWorld('vox', {
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  dictGet: () => ipcRenderer.invoke('dict:get'),
  dictSet: (d) => ipcRenderer.invoke('dict:set', d),
  historyList: (q) => ipcRenderer.invoke('history:list', q),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyCopy: (id) => ipcRenderer.invoke('history:copy', id),
  historyExport: () => ipcRenderer.invoke('history:export'),
  statsGet: () => ipcRenderer.invoke('stats:get'),
  modelsList: () => ipcRenderer.invoke('models:list'),
  modelsDownload: (id) => ipcRenderer.invoke('models:download', id),
  modelsCancel: (id) => ipcRenderer.invoke('models:cancel', id),
  modelsActivate: (id) => ipcRenderer.invoke('models:activate', id),
  languagesList: () => ipcRenderer.invoke('languages:list'),
  hotkeyCapture: () => ipcRenderer.invoke('hotkey:capture'),
  aiMeta: () => ipcRenderer.invoke('ai:meta'),
  aiTest: () => ipcRenderer.invoke('ai:test'),
  aiKeyUrl: () => ipcRenderer.invoke('ai:keyUrl'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  hideWindow: () => ipcRenderer.invoke('dashboard:hide'),
  on: (channel, cb) => {
    if (!PUSH_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_e, d) => cb(d));
  },
});
