// Electron shell: runs the Freehub server inside the app and shows the dashboard in its own window.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA = app.getPath('userData');
process.env.FREEHUB_DATA = DATA;
fs.mkdirSync(DATA, { recursive: true });

if (!app.requestSingleInstanceLock()) app.quit();

let win = null, picker = null, pickCb = null, pickList = [];

function startServer() { require('../server.js'); }

function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 640, backgroundColor: '#0b0813', title: 'Freehub',
    icon: path.join(__dirname, '..', 'build', 'icon.png'), webPreferences: { contextIsolation: true } });
  win.loadURL('http://localhost:3000');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Web Bluetooth has no built-in chooser in Electron, so show our own list of nearby devices.
  win.webContents.on('select-bluetooth-device', (e, devices, cb) => {
    e.preventDefault(); pickList = devices; pickCb = cb;
    if (!picker) openPicker(); else picker.webContents.send('devices', summarise());
  });
  win.on('closed', () => { win = null; if (picker) picker.close(); });
}
const summarise = () => pickList.map(d => ({ id: d.deviceId, name: d.deviceName || 'Unnamed device' }));
function openPicker() {
  picker = new BrowserWindow({ width: 420, height: 460, parent: win, modal: true, resizable: false, minimizable: false, title: 'Choose a Bluetooth device',
    backgroundColor: '#15101f', webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true } });
  picker.setMenu(null); picker.loadFile(path.join(__dirname, 'picker.html'));
  picker.webContents.on('did-finish-load', () => picker && picker.webContents.send('devices', summarise()));
  picker.on('closed', () => { picker = null; if (pickCb) { pickCb(''); pickCb = null; } });   // '' = cancelled
}
ipcMain.on('pick', (_e, id) => { if (pickCb) { const cb = pickCb; pickCb = null; cb(id); } if (picker) picker.close(); });

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Freehub', submenu: [
      { label: 'Open data folder (rides, plans, Strava config)', click: () => shell.openPath(DATA) },
      { label: 'Create config.json template for Strava', click: () => {
          const f = path.join(DATA, 'config.json');
          if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ clientId: 'YOUR_CLIENT_ID', clientSecret: 'YOUR_CLIENT_SECRET' }, null, 2));
          shell.showItemInFolder(f);
          dialog.showMessageBox({ message: 'Edit config.json with your Strava keys, then restart Freehub.', detail: f }); } },
    ] },
  ]));
}

app.whenReady().then(() => { buildMenu(); startServer(); setTimeout(createWindow, 400);
  app.on('activate', () => { if (!win) createWindow(); }); });
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
