const {app,BrowserWindow}=require('electron');
const {readFile,mkdir}=require('node:fs/promises');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
app.setPath('userData',process.env.SHENSI_TEST_PROMPT_USER_DATA);
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const source=await readFile(resolve(__dirname,'../../src/app.js'),'utf8');
  const between=(start,end)=>{const a=source.indexOf(start);const b=source.indexOf(end,a);if(a<0||b<0)throw new Error(`Missing fixture boundary ${start}`);return source.slice(a,b);};
  const functions=between('const appendWhiteboardPromptClipboardSegment =','[elements.whiteboardGenerateForm, elements.whiteboardImageForm, elements.whiteboardVideoForm, elements.whiteboardAudioForm].forEach((form) => {');
  const code={functions,copyListener:between('  editor?.addEventListener("copy",','  editor?.addEventListener("paste",'),menuListener:between('elements.textEditContextMenu.addEventListener("click",','const hideDirectoryMenus =')};
  const accountModule=await import(pathToFileURL(resolve(__dirname,'../../src/server/libtv-account-status.mjs')).href);
  const drivers=await import(pathToFileURL(resolve(__dirname,'../../src/server/media-provider-drivers.mjs')).href);
  const liveAccount=process.env.SHENSI_TEST_LIBTV_LIVE==='1';
  const account=liveAccount
    ? await accountModule.probeLibTvAccountStatus({driver:new drivers.LibTvMediaDriver(),settings:{provider:'LibTV',adapter:'cli'},cwd:resolve(__dirname,'../..')})
    : accountModule.normalizeLibTvAccountStatus({accounts:[{accountId:'test',accountName:'测试账号',isActive:true,memberAccount:{memberName:'测试会员',effective:true}}]});
  const window=new BrowserWindow({show:false,width:1120,height:420,webPreferences:{sandbox:true,backgroundThrottling:false}});
  await window.loadFile(resolve(__dirname,'prompt-clipboard-dom.html'));
  const result=await window.webContents.executeJavaScript(`window.runPromptTests(${JSON.stringify(code)},${JSON.stringify(account)})`);
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const output=resolve(__dirname,'../../test-results/libtv-prompt-clipboard');await mkdir(output,{recursive:true});
  const screenshot=resolve(output,'libtv-account-panel.png');
  const {writeFile}=require('node:fs/promises');await writeFile(screenshot,(await window.webContents.capturePage()).toPNG());
  process.stdout.write(JSON.stringify({...result,liveAccount,screenshot})+'\n');window.destroy();app.quit();
}).catch(error=>{process.stderr.write(String(error.stack||error)+'\n');app.exit(1);});
