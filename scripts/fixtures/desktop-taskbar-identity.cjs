// Isolated off-screen HWND fixture: no backend, user library, credentials or mouse.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:net');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
app.setPath('userData', process.env.SHENSI_TEST_TASKBAR_USER_DATA);
app.setAppUserModelId('com.shensi.creativeengine');
app.whenReady().then(async () => {
  const { applyMainWindowTaskbarIdentity } = await import(pathToFileURL(resolve(__dirname, '../../packaging/windows/desktop-app/taskbar-identity.mjs')).href);
  const window = new BrowserWindow({ show: false, frame: false, x: -32000, y: -32000, width: 300, height: 150, webPreferences: { sandbox: true } });
  await window.loadURL('data:text/html;charset=utf-8,<title>Shensi isolated taskbar identity test</title>');
  window.showInactive();
  const handle = window.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
  const report = (phase) => process.stdout.write(`${JSON.stringify({ phase, hwnd, pid: process.pid, controlPort: control.address()?.port })}\n`);
  // Windows GUI Electron processes do not reliably expose piped stdin.
  // A fixture-only loopback socket keeps the HWND alive for native inspection.
  const control = createServer((socket) => {
    socket.once('data', (data) => {
      const command = String(data).trim();
      if (command === 'bind') {
        applyMainWindowTaskbarIdentity(window, { appId: 'com.shensi.creativeengine' });
        report('bound');
      }
      if (command === 'restore') {
        window.hide();
        applyMainWindowTaskbarIdentity(window, { appId: 'com.shensi.creativeengine' });
        window.setSkipTaskbar(false);
        window.showInactive();
        report('restored');
      }
      socket.end();
      if (command === 'quit') { control.close(); window.destroy(); app.quit(); }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolveListen, rejectListen) => {
    control.once('error', rejectListen);
    control.listen(0, '127.0.0.1', resolveListen);
  });
  report('before');
}).catch((error) => { console.error(error); app.exit(1); });
