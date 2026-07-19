'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vox', {
  onUiState: (cb) => ipcRenderer.on('ui:state', (_e, d) => cb(d)),
  onRecStart: (cb) => ipcRenderer.on('rec:start', (_e, d) => cb(d)),
  onRecStop: (cb) => ipcRenderer.on('rec:stop', (_e, d) => cb(d)),
  onSelftestMic: (cb) => ipcRenderer.on('selftest:mic', (_e, d) => cb(d)),
  recDone: (payload) => ipcRenderer.send('rec:done', payload),
  recError: (message) => ipcRenderer.send('rec:error', { message }),
  recAutoStop: (gen) => ipcRenderer.send('rec:autostop', { gen }),
  selftestMicResult: (r) => ipcRenderer.send('selftest:mic-result', r),
});
