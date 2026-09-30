import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudSkillApp } from '../cloud-skill-platform/server.mjs';
import { JsonStore } from '../cloud-skill-platform/lib/store.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'shensi-email-ui-'));
const store = await new JsonStore(join(root, 'state.json')).init();
const mail = [];
process.env.SHENSI_CLOUD_ENV = 'test';
const emailEnvironment = { SHENSI_CLOUD_EMAIL_LOGIN_ENABLED: 'true', SHENSI_CLOUD_EMAIL_CODE_SECRET: 'isolated-ui-secret-no-real-credentials-123456' };
let app = await createCloudSkillApp({ store, signingKeyPath: join(root, 'signing.json'), emailOptions: { environment: emailEnvironment, delivery: { configured: true, send: async (item) => { mail.push(item); } } } });
// Read only the exact login UI and handler blocks, never load the whole app.
const readBlock = async (start, end) => {
  const input = createReadStream(join(repo, 'src/app.js'), { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  const lines = []; let capturing = false;
  try { for await (const line of reader) {
    if (!capturing && line.startsWith(start)) capturing = true;
    if (capturing) { lines.push(line); if (line === end) break; if (lines.length > 250) throw new Error('Fixture block exceeded 250 lines'); }
  } } finally { reader.close(); input.destroy(); }
  assert.ok(lines.length, start); return lines.join(String.fromCharCode(10));
};
const markup = (await readBlock('  <dialog class="account-login-dialog"', '  </dialog>')).replace(/\$\{[^}]+\}/gu, '');
const render = await readBlock('const renderAccountLoginMode = () => {', '};');
const click = await readBlock('elements.accountLoginDialog.addEventListener("click"', '});');
const submit = await readBlock('elements.accountLoginForm.addEventListener("submit"', '});');
let profile; let child; let socket; let phase = 'login'; let delayedConfig = false;
const fixture = () => '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/account.css"><body><main style="padding:30px"><h1>神思 · 邮箱登录验收</h1><p id="result"></p><button id="openBinding">验证绑定邮箱</button></main>' + markup
  + '<script type="module">import { installAccountEmailUI } from "/account-email-login.js";'
  + 'const profile=' + JSON.stringify(profile) + '; const phase=' + JSON.stringify(phase) + ';'
  + 'const ui={account:{loginMode:"password",authenticated:phase==="bind",token:phase==="bind"?profile.token:"",profile:phase==="bind"?{email:profile.user.email}:{} }};'
  + 'const elements={accountLoginDialog:document.querySelector("#accountLoginDialog"),accountLoginForm:document.querySelector("#accountLoginForm")};'
  + 'const setAccountLoginStatus=(message="请选择登录方式")=>document.querySelector("#accountLoginStatus").textContent=message;'
  + 'const accountApi=async(path,{method="GET",body}={})=>{const r=await fetch(path,{method,headers:{"content-type":"application/json",...(ui.account.token?{authorization:"Bearer "+ui.account.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.message),{status:r.status,retryAfterSeconds:data.retryAfterSeconds});return data;};'
  + 'const syncAccountProfile=(user,token)=>{ui.account={...ui.account,authenticated:true,token,profile:{email:user.email,emailVerifiedAt:user.emailVerifiedAt}};window.fixtureUser=user;};'
  + 'const rememberAccountSession=()=>{};const showToast=(message)=>document.querySelector("#result").textContent=message;'
  + 'const accountEmailUI=installAccountEmailUI({dialog:elements.accountLoginDialog,form:elements.accountLoginForm,accountApi,getAccount:()=>ui.account,setStatus:setAccountLoginStatus,onLogin:(result)=>{syncAccountProfile(result.user,result.token);showToast("验证码登录成功");},onBound:(user,token)=>{syncAccountProfile(user,token);showToast("邮箱已绑定");}});'
  + render + click + submit
  + 'document.querySelector("#closeAccountLogin").onclick=()=>elements.accountLoginDialog.close();document.querySelector("#cancelAccountLogin").onclick=()=>elements.accountLoginDialog.close();'
  + 'document.querySelector("#openBinding").onclick=()=>accountEmailUI.openBinding();renderAccountLoginMode();if(phase!=="bind")elements.accountLoginDialog.showModal();window.fixtureReady=true;'
  + '</script></body></html>';
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/fixture') { response.setHeader('content-type', 'text/html;charset=utf-8'); return response.end(fixture()); }
    if (request.url === '/account-email-login.js' || request.url === '/account.css') {
      response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(await readFile(join(repo, 'src', request.url.endsWith('.js') ? 'account-email-login.js' : 'styles.css')));
    }
    const routes = { '/api/account/email-config': '/v1/auth/email-config', '/api/account/email-code': '/v1/auth/email-code', '/api/account/email-login': '/v1/auth/email-login', '/api/account/email-bind': '/v1/account/email-bind', '/api/account/login': '/v1/auth/login' };
    if (request.url === '/api/account/email-config' && delayedConfig) await new Promise((done) => setTimeout(done, 300));
    request.url = routes[request.url] || request.url; await app.handler(request, response);
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ message: error.message })); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + server.address().port;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  const registration = await fetch(base + '/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'ui-legacy', contact: 'legacy-ui@example.test', password: 'isolated-ui-password', displayName: '测试笔名', securityQuestion: '测试密保问题', securityAnswer: '测试答案' }) });
  profile = await registration.json(); assert.ok(registration.ok, profile.message);
  const portServer = createSocketServer(); await new Promise((done) => portServer.listen(0, '127.0.0.1', done));
  const port = portServer.address().port; await new Promise((done) => portServer.close(done));
  child = spawn(process.env.SHENSI_UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--remote-debugging-port=' + port, '--user-data-dir=' + join(root, 'browser'), base + '/fixture'], { windowsHide: true, stdio: 'ignore' });
  let childError; child.on('error', (error) => { childError = error; });
  let target;
  for (const deadline = Date.now() + 15000; Date.now() < deadline && !target;) {
    if (childError) throw childError;
    try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((item) => item.type === 'page' && item.url.startsWith(base)); } catch {}
    if (!target) await delay(100);
  }
  assert.ok(target, 'Isolated Edge started'); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(); const errors = [];
  socket.addEventListener('message', (event) => { const data = JSON.parse(String(event.data)); if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text); const item = pending.get(data.id); if (!item) return; pending.delete(data.id); clearTimeout(item.timer); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (fn, ...args) => { const result = await cdp('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + args.map((arg) => JSON.stringify(arg)).join(',') + ')', awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
  const wait = async (fn) => { for (const deadline = Date.now() + 8000; Date.now() < deadline;) { if (await evaluate(fn)) return; await delay(30); } throw new Error('UI timeout: ' + fn.toString()); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1080, height: 820, deviceScaleFactor: 1, mobile: false });
  const screenshots = join(repo, 'artifacts/account-email-login'); await mkdir(screenshots, { recursive: true });
  const screenshot = async (name) => { const image = await cdp('Page.captureScreenshot', { format: 'png' }); const bytes = Buffer.from(image.data, 'base64'); assert.ok(bytes.length > 1000); await writeFile(join(screenshots, name), bytes); };
  await wait(() => window.fixtureReady);
  // Actual desktop password handler must work with hidden required email fields.
  await evaluate(() => { const form = document.querySelector('#accountLoginForm'); form.elements.account.value = 'ui-legacy'; form.elements.password.value = 'isolated-ui-password'; form.requestSubmit(); });
  await wait(() => !document.querySelector('#accountLoginDialog').open);
  assert.equal(await evaluate(() => window.fixtureUser.account), 'ui-legacy');
  await cdp('Page.reload'); await wait(() => window.fixtureReady);
  await evaluate(() => document.querySelector('[data-account-login-mode=email]').click());
  await wait(() => !document.querySelector('[data-email-send]').disabled);
  await screenshot('email-login.png');
  await evaluate(() => { const input = document.querySelector('[name=loginEmail]'); input.value = 'fresh-ui@example.test'; input.dispatchEvent(new Event('input')); document.querySelector('[data-email-send]').click(); });
  await wait(() => document.querySelector('#accountLoginStatus').textContent.includes('邮件已提交'));
  assert.equal(mail.length, 1); assert.ok(await evaluate(() => document.querySelector('[data-email-send]').disabled));
  const delivered = mail[0].code;
  await evaluate((code) => { const form = document.querySelector('#accountLoginForm'); form.elements.emailCode.value = code; form.requestSubmit(); }, delivered === '000000' ? '000001' : '000000');
  await wait(() => document.querySelector('#accountLoginStatus').textContent.includes('验证码无效'));
  await evaluate((code) => { const form = document.querySelector('#accountLoginForm'); form.elements.emailCode.value = code; form.requestSubmit(); }, delivered);
  await wait(() => !document.querySelector('#accountLoginDialog').open); assert.equal(await evaluate(() => window.fixtureUser.email), 'fresh-ui@example.test');
  await evaluate(() => { document.querySelector('#accountLoginDialog').showModal(); document.querySelector('[data-account-login-mode=password]').click(); });
  assert.equal(await evaluate(() => document.querySelector('#accountLoginForm [type=submit]').disabled), false, 'Reopening password login after email success must remain usable');
  await evaluate(() => document.querySelector('#accountLoginDialog').close());
  phase = 'bind'; await cdp('Page.reload'); await wait(() => window.fixtureReady);
  await evaluate(() => document.querySelector('#openBinding').click());
  await wait(() => !document.querySelector('.account-email-bind-dialog [data-email-send]').disabled);
  await screenshot('verify-bound-email.png');
  await evaluate(() => document.querySelector('.account-email-bind-dialog [data-email-send]').click());
  await wait(() => document.querySelector('.account-email-bind-dialog [role=status]').textContent.includes('邮件已提交'));
  await evaluate((code) => { const form = document.querySelector('.account-email-bind-dialog form'); form.elements.emailCode.value = code; form.requestSubmit(); }, mail.at(-1).code);
  await wait(() => !document.querySelector('.account-email-bind-dialog').open);
  assert.ok(store.state.users.find((user) => user.id === profile.user.id).emailVerifiedAt);
  // Closing during config fetch must not allow late responses to disable password login.
  phase = 'login'; delayedConfig = true; await cdp('Page.reload'); await wait(() => window.fixtureReady);
  await evaluate(() => { document.querySelector('[data-account-login-mode=email]').click(); document.querySelector('[data-account-login-mode=password]').click(); });
  await delay(400); assert.equal(await evaluate(() => document.querySelector('#accountLoginForm [type=submit]').disabled), false);
  delayedConfig = false; app.close(); app = await createCloudSkillApp({ store, signingKeyPath: join(root, 'signing.json'), emailOptions: { environment: {} } });
  await evaluate(() => document.querySelector('[data-account-login-mode=email]').click());
  await wait(() => document.querySelector('[data-email-help]').textContent.includes('尚未配置'));
  assert.equal(await evaluate(() => document.querySelector('[data-email-send]').disabled), true);
  await evaluate(() => document.querySelector('[data-account-login-mode=password]').click());
  assert.equal(await evaluate(() => document.querySelector('#accountLoginForm [type=submit]').disabled), false);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('Email UI: password/login/code cooldown/wrong code/binding/late response/disabled service PASS; mocked mail only.');
  console.log('Verified screenshots: ' + screenshots);
} finally {
  socket?.close(); if (child && child.exitCode === null) { child.kill(); await delay(500); }
  app.close(); server.closeAllConnections(); await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
