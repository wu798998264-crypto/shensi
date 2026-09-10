import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-choice-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const artifactRoot = join(root, "artifacts");
const screenshotPath = join(artifactRoot, "conversation-agent-native.png");
const permissionScreenshotPath = join(artifactRoot, "agent-permission-levels.png");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

const debugPort = 9357;
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const child = spawn(electron, [
  `--remote-debugging-port=${debugPort}`,
  "--disable-gpu",
  "--disable-gpu-compositing",
  desktopEntry,
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
if (!target) throw new Error(`候选选框验收页面未启动：${stderr.slice(-1000)}`);

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
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#chatInput')", "应用启动", 45000);
  await evaluate(`(() => {
    window.nativeAgentStarts = [];
    window.nativeAgentAnswers = [];
    window.nativeAgentMocks = new Map();
    const original = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const path = String(url);
      if (path === '/api/conversation-agent/start') {
        const request = JSON.parse(init.body);
        window.nativeAgentStarts.push(request);
        const id = 'agent-00000000-0000-0000-0000-' + String(window.nativeAgentStarts.length).padStart(12, '0');
        const questionId = 'question-' + window.nativeAgentStarts.length;
        const events = [
          { sequence: 1, type: 'started', payload: { model: 'mock' } },
          { sequence: 2, type: 'question', payload: { id: questionId, question: '你更希望比较哪些差异？', options: [{id:'a',label:'节奏'}, {id:'b',label:'视角'}], multiple: window.nativeAgentStarts.length === 1, allowFreeText: true } },
        ];
        window.nativeAgentMocks.set(id, { id, status: 'waiting_input', events, lastSequence: 2, text: '', linkTarget: window.nativeAgentStarts.length === 1 ? window.agentLinkTarget : null, workspacePath: request.workspacePath });
        return Response.json({ok:true,id,status:'running'});
      }
      if (path.startsWith('/api/conversation-agent/')) {
        const id = path.split('/')[3].split('?')[0], run = window.nativeAgentMocks.get(id);
        if (path.endsWith('/answer')) {
          window.nativeAgentAnswers.push(JSON.parse(init.body));
          const answer = JSON.parse(init.body).answer;
          run.events.push({sequence:3,type:'answer',payload:{decisionId:JSON.parse(init.body).decisionId,answer}});
          run.events.push({sequence:4,type:'candidates',payload:{variants:[{title:'节奏方案',content:'第一份完整候选稿。'},{title:'视角方案',content:'第二份完整候选稿。'},{title:'融合方案',content:'第三份完整候选稿。'}]}});
          let sequence = 5;
          if (run.linkTarget) {
            const hash = 'a'.repeat(64);
            const result = {targetDocumentId:run.linkTarget.id,requestedTitle:run.linkTarget.title,targetDirectoryId:'manuscript',verified:true,writtenHash:hash,verifiedHash:hash};
            const landingManifest = {schemaVersion:2,nativeAgentDocumentSave:true,workspaceKind:'project',workspacePath:run.workspacePath,workspaceName:'Agent界面隔离验收',segments:[{documentId:run.linkTarget.id,title:run.linkTarget.title,requestedTitle:run.linkTarget.title,moduleId:'manuscript',receiptVerified:true,navigationTarget:{documentId:run.linkTarget.id,moduleId:'manuscript',workspaceKind:'project',workspacePath:run.workspacePath,workspaceName:'Agent界面隔离验收'}}],batchLandingReceipt:{verified:true,failed:0,results:[result]}};
            run.events.push({sequence:sequence++,type:'document_saved',payload:{documentId:run.linkTarget.id,title:run.linkTarget.title,trustedDocumentSave:true,landingManifest}});
          }
          run.events.push({sequence,type:'completed',payload:{text:'已生成三份候选，未覆盖文档。'}});
          run.status='completed';run.text='已生成三份候选，未覆盖文档。';run.lastSequence=sequence;
          return Response.json({ok:true,accepted:true});
        }
        if (path.endsWith('/cancel')) { run.status='cancelled'; run.events.push({sequence:run.events.length+1,type:'cancelled',payload:{message:'已取消测试任务'}}); run.lastSequence=run.events.length; return Response.json({ok:true,accepted:true}); }
        const after=Number(new URL(path,location.origin).searchParams.get('after')||0);
        return Response.json({ok:true,...run,events:run.events.filter(e=>e.sequence>after)});
      }
      return original(url,init);
    };
    if(document.querySelector('#creativeStartWelcomeDialog')?.open)document.querySelector('#dismissCreativeStartWelcome')?.click();
    return true;
  })()`);
  await evaluate("document.querySelector('#projectButton').click(); true");
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate("document.querySelector('#newWorkspaceButton').click(); true");
  await waitFor("document.querySelector('#textDialog')?.open", "新建工作区");
  await evaluate(`(() => {document.querySelector('#textDialogInput').value='Agent界面隔离验收';document.querySelector('#textDialogForm').requestSubmit();return true;})()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('Agent界面隔离验收')", "工作区创建");
  await evaluate("if(document.querySelector('#creativeStartWelcomeDialog')?.open)document.querySelector('#dismissCreativeStartWelcome')?.click(); true");
  await evaluate("document.querySelector('[data-module=library]').click(); true");
  await waitFor("document.querySelector('[data-document=library-memo]')", "内置资料文档");
  await evaluate("document.querySelector('[data-document=library-memo]').click(); true");
  await waitFor("document.querySelector('[data-document=library-memo].active')", "选中链接验收文档");
  const agentLinkTarget = await evaluate(`(() => {const row=document.querySelector('[data-document=library-memo]');return {id:row.dataset.document,title:row.querySelector('.document-label').textContent.trim()};})()`);
  await evaluate(`window.agentLinkTarget=${JSON.stringify(agentLinkTarget)}; true`);
  await evaluate("document.querySelector('#quickModelButton').click(); true");
  await waitFor("document.querySelector('#quickModelPanel')?.hidden === false", "权限快捷面板");
  await evaluate("document.querySelector('#conversationPermissionLabel').click(); true");
  assert.equal(await evaluate("document.querySelector('#conversationPermissionMenu').closest('.chat-panel-toolbar') !== null"), true);
  const defaultPermission = await evaluate(`({
    labels:[...document.querySelectorAll('[data-agent-permission-surface="quick"] [data-agent-permission-mode]')].map((item)=>item.textContent.trim()),
    selected:document.querySelector('[data-agent-permission-surface="quick"] [data-agent-permission-mode].is-selected')?.dataset.agentPermissionMode,
    pressed:document.querySelector('[data-agent-permission-surface="quick"] [data-agent-permission-mode="shensi_only"]')?.getAttribute('aria-pressed')
  })`);
  assert.deepEqual(defaultPermission.labels, ["仅限神思", "操作需确认", "完全权限"]);
  assert.equal(defaultPermission.selected, "shensi_only", "新安装必须默认仅限神思");
  assert.equal(defaultPermission.pressed, "true");
  const permissionScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(permissionScreenshotPath, Buffer.from(permissionScreenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 760, height: 920, deviceScaleFactor: 1, mobile: false });
  const narrowPermissionLayout = await evaluate(`(() => {
    const container=document.querySelector('[data-agent-permission-surface="quick"]');
    const bounds=container.getBoundingClientRect();
    const buttons=[...container.querySelectorAll('[data-agent-permission-mode]')].map((item)=>item.getBoundingClientRect());
    return {fits:buttons.every((item)=>item.left>=bounds.left-1&&item.right<=bounds.right+1),overflow:container.scrollWidth-container.clientWidth};
  })()`);
  assert.equal(narrowPermissionLayout.fits, true, "窄宽度下三档按钮不得越出面板");
  assert.ok(narrowPermissionLayout.overflow <= 1, "窄宽度下权限面板不得横向溢出");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('[data-agent-permission-mode=approval_required]').click(); true");
  await waitFor("document.querySelector('[data-agent-permission-mode=approval_required]')?.classList.contains('is-selected') && !document.querySelector('[data-agent-permission-mode=approval_required]')?.disabled", "快捷切换操作需确认");
  await evaluate("document.querySelector('#closeQuickModel').click(); document.querySelector('#settingsButton').click(); true");
  await waitFor("document.querySelector('#settingsDialog')?.open && document.querySelector('#settingsDialog')?.getAttribute('aria-busy') !== 'true'", "设置窗口", 45000);
  await evaluate("document.querySelector('[data-settings-section=model]').click(); true");
  await waitFor("document.querySelector('[data-settings-page=model]')?.hidden === false", "模型设置");
  assert.equal(await evaluate("document.querySelector('input[name=agentPermissionMode]:checked')?.value"), "approval_required", "快捷档位必须同步到设置");
  await evaluate(`(() => {
    const input=document.querySelector('input[name=agentPermissionMode][value=full_access]');
    input.checked=true;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#settingsForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('[data-agent-permission-mode=full_access]')?.classList.contains('is-selected')", "设置同步完全权限", 45000);
  await evaluate("document.querySelector('#cancelSettings').click(); document.querySelector('#quickModelButton').click(); true");
  await waitFor("document.querySelector('#quickModelPanel')?.hidden === false && document.querySelector('[data-agent-permission-mode=full_access]')?.classList.contains('is-selected')", "设置同步快捷面板");
  await evaluate("document.querySelector('[data-agent-permission-mode=shensi_only]').click(); true");
  await waitFor("document.querySelector('[data-agent-permission-mode=shensi_only]')?.classList.contains('is-selected') && !document.querySelector('[data-agent-permission-mode=shensi_only]')?.disabled", "恢复默认权限");
  await evaluate("document.querySelector('#closeQuickModel').click(); true");
  await evaluate(`(() => {const input=document.querySelector('#chatInput');input.value='不生成视频，只给三份不同视角的候选故事';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chatForm').requestSubmit();return true;})()`);
  await waitFor("window.nativeAgentStarts.length === 1", "统一Agent接受");
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === false", "动态选择框");
  const first = await evaluate(`({
    input:document.querySelector('#chatInput').value,
    text:document.querySelector('#chatFeed').innerText,
    options:[...document.querySelectorAll('#conversationChoiceOptions strong')].map(e=>e.textContent),
    starts:window.nativeAgentStarts.length
  })`);
  assert.equal(first.input, "");
  assert.equal(await evaluate("window.nativeAgentStarts[0].targetDocumentId"), '', '当前打开文档不得默认绑定为写入目标');
  assert.equal(await evaluate("window.nativeAgentStarts[0].currentDocument.documentId"), agentLinkTarget.id);
  assert.match(first.text, /不生成视频，只给三份不同视角的候选故事/);
  assert.match(first.text, /你更希望比较哪些差异/);
  assert.doesNotMatch(first.text, /先选择主笔数量|单主笔生成多稿|多主笔生成候选/);
  assert.deepEqual(first.options, ["节奏", "视角", "确认选择"]);
  const choiceGeometry = await evaluate(`(() => { const options=document.querySelector('.native-choice-items').getBoundingClientRect(); const confirm=document.querySelector('.native-choice-confirm').getBoundingClientRect(); return {gap:confirm.left-options.right,right:confirm.left>=options.right}; })()`);
  assert.equal(choiceGeometry.right,true);
  assert.ok(choiceGeometry.gap>=0&&choiceGeometry.gap<=10,'确认按钮紧靠选项右侧');
  await evaluate("document.querySelector('#quickNewConversationButton').click(); true");
  await evaluate(`(() => {const input=document.querySelector('#chatInput');input.value='第二个对话只讨论大纲';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chatForm').requestSubmit();return true;})()`);
  await waitFor("window.nativeAgentStarts.length === 2 && document.querySelector('#conversationChoicePanel')?.hidden === false", "第二个对话并发运行");
  assert.equal(await evaluate("[...window.nativeAgentMocks.values()].filter(r=>r.status==='waiting_input').length"), 2, "两个对话必须能同时运行");
  assert.equal(await evaluate("document.querySelectorAll('#conversationChoiceOptions [data-choice-type=native_agent_confirm]').length"), 1, "单选问题也必须显示确认按钮");
  await evaluate("document.querySelector('#conversationChoiceOptions [data-choice-type=native_agent_answer]').click(); true");
  assert.equal(await evaluate("window.nativeAgentAnswers.length"), 0, "单选项目只标记选中，确认前不得提交");
  assert.equal(await evaluate("document.querySelector('#conversationChoiceOptions [data-choice-type=native_agent_answer]').classList.contains('is-selected')"), true, "单选项目必须显示选中状态");
  assert.equal(await evaluate("document.querySelector('#conversationChoiceOptions [data-choice-type=native_agent_confirm]').disabled"), false, "选中后确认按钮必须可用");
  await evaluate(`(() => {const input=document.querySelector('#chatInput');input.value='保留悬念，重点比较视角';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chatForm').requestSubmit();return true;})()`);
  await waitFor("window.nativeAgentAnswers.length === 1", "自由回答");
  await waitFor("document.querySelector('#chatFeed').innerText.includes('查看候选稿')", "候选分支保留");
  assert.equal(await evaluate("window.nativeAgentStarts.length"), 2, "回答不能新建额外任务");
  await evaluate("document.querySelector('#conversationHistoryButton').click(); true");
  await waitFor("document.querySelector('[data-conversation=\"'+window.nativeAgentStarts[0].conversationId+'\"]')", "原对话入口");
  await evaluate("document.querySelector('[data-conversation=\"'+window.nativeAgentStarts[0].conversationId+'\"]').click(); true");
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === false", "原对话问题恢复");
  await evaluate("document.querySelectorAll('#conversationChoiceOptions [data-choice-type=native_agent_answer]')[0].click(); true");
  await evaluate("document.querySelectorAll('#conversationChoiceOptions [data-choice-type=native_agent_answer]')[1].click(); true");
  await evaluate("document.querySelector('#conversationChoiceOptions [data-choice-type=native_agent_confirm]').click(); true");
  await waitFor("window.nativeAgentAnswers.length === 2", "多选回答");
  assert.equal(await evaluate("window.nativeAgentAnswers[1].answer"), "节奏；视角");
  await waitFor("document.querySelector('[data-open-landed-document]')", "Agent 文档标题链接");
  assert.equal(await evaluate("document.querySelector('[data-open-landed-document]').textContent.trim()"), agentLinkTarget.title, "链接文字必须与文档显示标题一致");
  await evaluate("document.querySelector('[data-module=memory]').click(); true");
  await waitFor("document.querySelector('[data-document=memory-snapshot]')", "跳转前文档");
  await evaluate("document.querySelector('[data-document=memory-snapshot]').click(); true");
  await waitFor("document.querySelector('[data-document=memory-snapshot].active')", "切换离开链接目标");
  await evaluate("document.querySelector('[data-open-landed-document]').click(); true");
  await waitFor(`document.querySelector('[data-document].active')?.dataset.document === ${JSON.stringify(agentLinkTarget.id)}`, "点击标题链接跳回文档");
  await evaluate("if(document.querySelector('#creativeStartWelcomeDialog')?.open)document.querySelector('#dismissCreativeStartWelcome')?.click(); true");
  await delay(350);
  const result = await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await writeFile(screenshotPath,Buffer.from(result.data,"base64"));
  await evaluate("document.querySelector('#quickNewConversationButton').click(); true");
  await evaluate(`(() => {const input=document.querySelector('#chatInput');input.value='单选最后一问续跑验收';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#chatForm').requestSubmit();return true;})()`);
  await waitFor("window.nativeAgentStarts.length === 3 && document.querySelector('#conversationChoicePanel')?.hidden === false", "单选最后一问");
  await evaluate("document.querySelector('#conversationChoiceOptions [data-choice-type=native_agent_answer]').click(); true");
  await evaluate("document.querySelector('#conversationChoiceOptions [data-choice-type=native_agent_confirm]').click(); true");
  await waitFor("window.nativeAgentAnswers.length === 3", "最后一问确认提交");
  assert.equal(await evaluate("window.nativeAgentAnswers[2].answer"), '节奏');
  await waitFor("document.querySelector('#chatFeed').innerText.includes('查看候选稿')", "最后一问后完成成果交付");
  await evaluate("document.querySelector('#quickNewConversationButton').click(); true");
  const emptyId = await evaluate(`(() => { const key=Object.keys(localStorage).find(key=>key.startsWith('shensi-manual-conversations-v1:')); return JSON.parse(localStorage.getItem(key)).activeId; })()`);
  assert.ok(emptyId);
  await cdp('Page.reload', {});
  await waitFor("window.nativeAgentStarts === undefined && document.documentElement.dataset.bootReady === 'true' && document.querySelector('#conversationHistoryButton')", "空对话刷新恢复", 45000);
  await evaluate("document.querySelector('#conversationHistoryButton').click(); true");
  await waitFor(`document.querySelector('[data-conversation="${emptyId}"]')`, "新建空对话仍存在", 30000);
  assert.equal(await evaluate(`document.querySelector('[data-conversation="${emptyId}"]').closest('.conversation-task-row').classList.contains('active')`), true, '恢复原活动对话');
  assert.equal(await evaluate("document.querySelector('#chatInput').value"), '');
  console.log(JSON.stringify({ok:true,screenshotPath,permissionScreenshotPath,checks:["default shensi-only permission","permission surfaces stay synchronized","narrow permission layout","raw instruction preserved","no keyword media route","send before choice","two concurrent conversations","single-select confirmation","free answer same run","multi-select after switching back","three candidate branches","verified document title link click"]}));
} catch (error) {
  console.log(JSON.stringify(await evaluate("({starts:window.nativeAgentStarts?.map(r=>({conversationId:r.conversationId,sourceMessageId:r.sourceMessageId})),answers:window.nativeAgentAnswers,input:document.querySelector('#chatInput')?.value,choices:document.querySelector('#conversationChoicePanel')?.hidden,feed:document.querySelector('#chatFeed')?.innerText.slice(-1400),toasts:document.querySelector('#toast')?.textContent})")));
  throw error;
} finally {
  socket.close();
  child.kill();
  await delay(800);
  await rm(runtimeRoot,{recursive:true,force:true,maxRetries:6,retryDelay:200}).catch(()=>{});
}
