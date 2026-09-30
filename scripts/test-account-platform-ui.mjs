import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudSkillApp } from '../cloud-skill-platform/server.mjs';
import { JsonStore } from '../cloud-skill-platform/lib/store.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'shensi-account-ui-'));
const screenshots = join(repo, 'artifacts', 'account-platform-foundations');
const store = await new JsonStore(join(root, 'state.json')).init();
process.env.SHENSI_CLOUD_ENV = 'test';
process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD = 'isolated-ui-test-password';
const app = await createCloudSkillApp({ store, signingKeyPath: join(root, 'signing.json') });
let profile; let socket; let child;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/account-platform.js' || req.url === '/account.css') {
      res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(await readFile(join(repo, 'src', req.url.endsWith('.js') ? 'account-platform.js' : 'styles.css')));
    }
    if (req.url === '/fixture/profile') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/account.css"><body><main style="padding:32px"><h1>账户资料 · 隔离测试</h1><span class="account-profile-avatar"></span><strong data-account-membership></strong><p data-account-quota></p><p data-account-reserved></p><p data-account-service-status></p><button id="editProfile">编辑头像笔名</button><p id="toast"></p></main><script type="module">'
        + 'import { installAccountPlatformUI } from "/account-platform.js";'
        + 'const fixture = ' + JSON.stringify(profile) + ';'
        + 'const account = { authenticated:true, token:fixture.token, profile:{nickname:fixture.user.displayName,avatar:fixture.user.avatar} };'
        + 'const api = async (path, options={}) => { const routes={"/api/account/profile":"/v1/account/profile","/api/account/membership":"/v1/membership","/api/account/quota":"/v1/quota"}; const r=await fetch(routes[path],{method:options.method||"GET",headers:{authorization:"Bearer "+account.token,"content-type":"application/json"},...(options.body?{body:JSON.stringify(options.body)}:{})}); const data=await r.json();if(!r.ok)throw new Error(data.message);return data; };'
        + 'const panel=installAccountPlatformUI({accountApi:api,getAccount:()=>account,syncAccountProfile:(user)=>{account.profile={nickname:user.displayName,avatar:user.avatar};panel.refresh();},showToast:(text)=>document.querySelector("#toast").textContent=text});document.querySelector("#editProfile").onclick=()=>panel.open();panel.refresh();window.fixtureReady=true;'
        + '</script></body></html>');
    }
    await app.handler(req, res);
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + server.address().port;
const post = async (path, body, token = '') => { const r = await fetch(base + path, { method:'POST', headers:{ 'content-type':'application/json', ...(token ? { authorization:'Bearer ' + token } : {}) }, body:JSON.stringify(body) }); const data=await r.json(); assert.ok(r.ok, data.message); return data; };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  profile = await post('/v1/auth/register', { account:'ui-user', contact:'ui@example.test', password:'isolated-user-password', displayName:'测试笔名', securityQuestion:'测试密保问题', securityAnswer:'测试答案' });
  const upload = await post('/v1/skills/uploads', { skillId:'ui.demo', version:'1.0.0', source:['---','id: ui.demo','name: 示例创作 Skill','version: 1.0.0','---','# 创作辅助','将故事整理为提纲。'].join(String.fromCharCode(10)) }, profile.token);
  const portServer = createSocketServer(); await new Promise((done) => portServer.listen(0, '127.0.0.1', done));
  const debugPort = portServer.address().port; await new Promise((done) => portServer.close(done));
  const browserEnv = { ...process.env }; delete browserEnv.ELECTRON_RUN_AS_NODE;
  const browserPath = process.env.SHENSI_UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port='+debugPort, '--user-data-dir='+join(root,'browser'), base+'/admin'], { cwd:repo, windowsHide:true, stdio:['ignore','pipe','pipe'], env:browserEnv });
  let browserOutput=''; const capture=(chunk)=>{browserOutput=(browserOutput+chunk.toString()).slice(-2000);}; child.stdout.on('data',capture);child.stderr.on('data',capture);
  let childError; child.on('error', (error) => { childError=error; });
  let target;
  for (const deadline=Date.now()+15000; Date.now()<deadline && !target;) {
    if(childError) throw childError;
    try { const list=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json(); target=list.find((item)=>item.type==='page' && item.url.startsWith(base)); } catch {}
    if(!target) await delay(100);
  }
  assert.ok(target,'隔离浏览器应能启动，退出码 '+child.exitCode+': '+browserOutput); socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0; const pending=new Map(); const errors=[];
  socket.addEventListener('message',(event)=>{const data=JSON.parse(String(event.data));if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.text);const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result);});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async(fn,...args)=>{const r=await cdp('Runtime.evaluate',{expression:'('+fn.toString()+')('+args.map((arg)=>JSON.stringify(arg)).join(',')+')',awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
  const waitFor=async(fn)=>{for(const deadline=Date.now()+7000;Date.now()<deadline;){if(await evaluate(fn))return;await delay(40);}throw new Error('UI timeout: '+fn.toString()+' '+JSON.stringify(await evaluate(()=>({url:location.href,message:document.querySelector('#authMessage')?.textContent,admin:document.querySelector('#adminMessage')?.textContent})))+' '+JSON.stringify(errors));};
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
  await mkdir(screenshots,{recursive:true});
  const screenshot=async(name)=>{const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(screenshots,name),Buffer.from(shot.data,'base64'));};
  await waitFor(()=>document.querySelector('#authForm'));
  await evaluate(()=>{document.querySelector('#authAccount').value='798998264';document.querySelector('#authPassword').value='isolated-ui-test-password';document.querySelector('#authForm').requestSubmit();});
  await waitFor(()=>!document.querySelector('#adminView').hidden && document.querySelector('[data-action=inspect]'));
  await screenshot('admin-overview.png');
  await evaluate(()=>document.querySelector('[data-action=inspect]').click());
  await waitFor(()=>document.querySelector('#inspectionSource')?.textContent.includes('创作辅助'));
  await evaluate(()=>{document.querySelector('#managementForm').elements.reason.value='已检查描述和原文';document.querySelector('#managementForm').requestSubmit();});
  await waitFor(()=>!document.querySelector('#managementDialog').open);
  assert.equal(store.state.skills.find((row)=>row.skillId===upload.skill.id).status,'published');
  await evaluate((id)=>document.querySelector('[data-action=quota][data-id="'+id+'"]').click(),profile.user.id);
  await waitFor(()=>document.querySelector('#managementForm').elements.amount);
  await evaluate(()=>{const f=document.querySelector('#managementForm');f.elements.amount.value='300';f.elements.reason.value='隔离界面测试额度';f.requestSubmit();});
  await waitFor(()=>!document.querySelector('#managementDialog').open);
  assert.equal(store.state.quotaAccounts.find((row)=>row.userId===profile.user.id).available,300);
  await evaluate((id)=>document.querySelector('[data-action=usage][data-id="'+id+'"]').click(),profile.user.id);
  await waitFor(()=>document.querySelector('#usageRuns')); await screenshot('admin-user-ledger.png');
  await cdp('Page.navigate',{url:base+'/fixture/profile'}); await waitFor(()=>window.fixtureReady===true);
  await waitFor(()=>document.querySelector('[data-account-quota]').textContent==='300');
  await evaluate(()=>document.querySelector('#editProfile').click());
  await waitFor(()=>document.querySelector('.account-profile-dialog')?.open);
  await evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const c=canvas.getContext('2d');c.fillStyle='#187760';c.fillRect(0,0,32,32);const blob=await new Promise((done)=>canvas.toBlob(done,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'avatar.png',{type:'image/png'}));const input=document.querySelector('[name=avatarFile]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await waitFor(()=>document.querySelector('[data-profile-status]').textContent.includes('已准备好'));
  await evaluate(()=>{document.querySelector('.account-profile-dialog [name=displayName]').value='新的测试笔名';}); await screenshot('account-profile-editor.png');
  await evaluate(()=>document.querySelector('.account-profile-dialog form').requestSubmit());
  await waitFor(()=>!document.querySelector('.account-profile-dialog').open);
  const saved=store.state.users.find((u)=>u.id===profile.user.id);assert.equal(saved.displayName,'新的测试笔名');assert.ok(saved.avatar.startsWith('data:image/png;base64,'));
  await cdp('Page.reload');await waitFor(()=>window.fixtureReady===true);
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('Admin login/Skill approval/credit adjustment/ledger/profile avatar UI: PASS');
  console.log('Screenshots: '+screenshots);
} finally {
  socket?.close(); if(child && child.exitCode===null){child.kill();await delay(600);}
  app.close();server.closeAllConnections();await new Promise((done)=>server.close(done));
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
