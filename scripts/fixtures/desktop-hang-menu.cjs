// Test-only Electron entry. No production IPC or crash hooks are installed.
const { app, BrowserWindow, Tray } = require('electron');
const { createServer } = require('node:http');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
let tray, menu, shown = 0, freezing = false;
const original = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(value) {
  tray=this;menu=value;
  value.on('menu-will-show',()=>{shown++;});
  return original.call(this,value);
};
import(pathToFileURL(resolve(__dirname,'../../packaging/windows/desktop-app/main.mjs')).href);
const server=createServer((request,response)=>{
  const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://127.0.0.1:'));
  const action=request.url;
  response.setHeader('content-type','application/json');
  if(action==='/freeze' && window && !freezing){
    freezing=true;
    setTimeout(()=>{void window.webContents.executeJavaScript('while(true) {}').catch(()=>{});},100);
  }
  if(action==='/menu' && tray) setTimeout(()=>tray.popUpContextMenu(menu),100);
  if(action==='/quit' && menu) setTimeout(()=>menu.items.find(i=>/退出|Quit/.test(i.label)).click(),100);
  response.end(JSON.stringify({ready:Boolean(window),pid:process.pid,shown,freezing,visible:window?.isVisible(),menu:menu?.items.map(i=>i.label)}));
});
server.listen(Number(process.env.SHENSI_HANG_TEST_PORT)||9474,'127.0.0.1');
server.unref();
