const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('picker', { onDevices: f => ipcRenderer.on('devices', (_e, d) => f(d)), pick: id => ipcRenderer.send('pick', id) });
