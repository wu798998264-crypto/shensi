import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-inline-edit-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });

const debugPort = 9361;
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const child = spawn(electron, [
  `--remote-debugging-port=${debugPort}`,
  "--disable-gpu",
  "--disable-gpu-compositing",
  join(root, "packaging", "windows", "desktop-app"),
], {
  cwd: root,
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: dataRoot,
    SHENSI_MACHINE_DATA_ROOT: dataRoot,
    SHENSI_DESKTOP_USER_DATA_ROOT: userDataRoot,
    SHENSI_SKIP_UPDATE_CHECK: "1",
    SHENSI_DISABLE_HARDWARE_ACCELERATION: "1",
    SHENSI_TEST_DESKTOP_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let target = null;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !target;) {
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
  } catch {}
  if (!target) await delay(200);
}
if (!target) throw new Error(`局部修改验收页面未启动：${stderr.slice(-1000)}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  socket.addEventListener("open", resolvePromise, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
const cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: resolvePromise, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label, timeout = 30_000) => {
  for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}；${stderr.slice(-800)}`);
};

try {
  await cdp("Runtime.enable");
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#editor')", "应用启动", 45_000);
  await evaluate(`(() => {
    window.inlineEditStarts = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const path = String(url);
      if (path === '/api/conversation-agent/start') {
        const request = JSON.parse(init.body);
        window.inlineEditStarts.push(request);
        const id = 'inline-edit-agent-1';
        window.inlineEditRun = {
          id,
          status: 'completed',
          text: '雨声贴着青瓦慢慢铺开。',
          lastSequence: 2,
          events: [
            {sequence:1,type:'started',payload:{model:'mock'}},
            {sequence:2,type:'completed',payload:{text:'雨声贴着青瓦慢慢铺开。'}},
          ],
        };
        return Response.json({ok:true,id,status:'running'});
      }
      if (path.startsWith('/api/conversation-agent/inline-edit-agent-1')) {
        const after = Number(new URL(path, location.origin).searchParams.get('after') || 0);
        return Response.json({ok:true,...window.inlineEditRun,events:window.inlineEditRun.events.filter((event)=>event.sequence>after)});
      }
      return originalFetch(url, init);
    };
    if (document.querySelector('#creativeStartWelcomeDialog')?.open) document.querySelector('#dismissCreativeStartWelcome')?.click();
    return true;
  })()`);
  await evaluate("document.querySelector('#projectButton').click(); true");
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate("document.querySelector('#newWorkspaceButton').click(); true");
  await waitFor("document.querySelector('#textDialog')?.open", "新建作品");
  await evaluate(`(() => { document.querySelector('#textDialogInput').value='局部修改验收'; document.querySelector('#textDialogForm').requestSubmit(); return true; })()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('局部修改验收')", "作品创建");
  await evaluate("if(document.querySelector('#creativeStartWelcomeDialog')?.open)document.querySelector('#dismissCreativeStartWelcome')?.click(); true");
  await evaluate("document.querySelector('[data-module=library]').click(); true");
  await waitFor("document.querySelector('[data-document=library-memo]')", "测试文档");
  await evaluate("document.querySelector('[data-document=library-memo]').click(); true");
  await waitFor("document.querySelector('[data-document=library-memo].active') && document.querySelector('#editor')?.contentEditable === 'true'", "打开测试文档");
  const documentId = await evaluate("document.querySelector('[data-document].active').dataset.document");
  await evaluate(`(() => {
    const editor = document.querySelector('#editor');
    editor.focus();
    editor.innerHTML='<p>雨落在屋檐上。</p>';
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'雨落在屋檐上。'}));
    return true;
  })()`);
  await delay(350);
  await evaluate(`(() => {
    const editor=document.querySelector('#editor');
    const text=editor.querySelector('p').firstChild;
    const range=document.createRange();
    range.setStart(text,0);range.setEnd(text,text.nodeValue.length);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  })()`);
  await waitFor("document.querySelector('#selectionToolbar')?.hidden === false", "选区工具栏");
  await evaluate("document.querySelector('#selectionChangeButton').click(); true");
  await waitFor("document.querySelector('#selectionEditForm')?.hidden === false", "局部修改输入框");
  await evaluate(`(() => { const input=document.querySelector('#selectionEditInput'); input.value='改得更有画面感'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#selectionEditForm').requestSubmit(); return true; })()`);
  await waitFor("window.inlineEditStarts.length === 1", "局部修改进入 Agent 对话");
  await waitFor("document.querySelector('.inline-edit-suggestion:not(.pending)')", "正文内候选对比");
  const preview = await evaluate(`(() => ({
    original:document.querySelector('.inline-edit-original')?.textContent,
    candidate:document.querySelector('.inline-edit-replacement')?.textContent,
    editorText:document.querySelector('#editor').textContent,
    accept:Boolean(document.querySelector('[data-inline-edit-action=accept]')),
  }))()`);
  assert.equal(preview.original, "雨落在屋檐上。");
  assert.equal(preview.candidate, "雨声贴着青瓦慢慢铺开。");
  assert.equal(preview.accept, true);
  assert.match(preview.editorText, /雨落在屋檐上。[\s\S]*雨声贴着青瓦慢慢铺开。/u, "确认前原文与候选都必须可见");
  await evaluate("document.querySelector('[data-inline-edit-action=accept]').click(); true");
  await waitFor("!document.querySelector('.inline-edit-suggestion') && document.querySelector('#editor').textContent.includes('雨声贴着青瓦慢慢铺开。')", "确认应用");
  await delay(1_800);
  const applied = await evaluate(`(async () => {
    const pointer=JSON.parse(localStorage.getItem('shensi-active-workspace-v1')||'null');
    const response=await fetch('/api/workspace/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspacePath:pointer.workspacePath})});
    const payload=await response.json();
    const saved=payload.state||{};
    return {
    text:document.querySelector('#editor').textContent,
    pending:(saved.pendingInlineEdits||[]).length,
    histories:(saved.histories?.[${JSON.stringify(documentId)}]||[]).length,
    historicalTexts:(saved.histories?.[${JSON.stringify(documentId)}]||[]).map((entry)=>entry.html||entry.document?.html||''),
  }; })()`);
  assert.equal(applied.text, "雨声贴着青瓦慢慢铺开。");
  assert.equal(applied.pending, 0);
  assert.ok(applied.histories >= 1, "确认应用前必须存在完整历史版本");
  assert.ok(applied.historicalTexts.some((text) => /雨落在屋檐上。/u.test(text)), "历史版本必须保存修改前全文");
  console.log(JSON.stringify({ok:true,checks:["selection request reached agent","inline before/after preview","explicit confirmation","pre-write full history snapshot","verified persisted replacement"]}));
} finally {
  socket.close();
  child.kill();
  await delay(800);
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
}
