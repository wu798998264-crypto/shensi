const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { copyFile, mkdir, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:net");
const assert = require("node:assert/strict");
const root = resolve(__dirname, "../..");
const testRoot = process.env.SHENSI_TEST_DRAFT_ROOT;
app.setPath("userData", join(testRoot, "browser"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
let backend, browser, serverErrors = "";
const importSource = name => import(pathToFileURL(join(root, name)).href);
const waitFor = async (expression, label, timeout = 20_000) => {
  for (const until = Date.now() + timeout; Date.now() < until;) {
    if (await browser.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await pause(80);
  }
  const details = await browser.webContents.executeJavaScript(`({ title:document.title, toast:document.querySelector('#toast')?.textContent, ready:document.documentElement.dataset.bootReady })`).catch(() => ({}));
  throw new Error(`${label}超时 ${JSON.stringify(details)} ${serverErrors.slice(-1200)}`);
};
const startServer = async () => {
  const probe = createServer(); await new Promise(done => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  backend = spawn(process.env.SHENSI_TEST_NODE, [join(root, "server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SHENSI_SKIP_UPDATE_CHECK: "1" }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  backend.stderr.on("data", value => { serverErrors = (serverErrors + value).slice(-2500); });
  const origin = `http://127.0.0.1:${port}`;
  for (const until = Date.now() + 15_000; Date.now() < until;) {
    if (await fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false)) return origin;
    if (backend.exitCode !== null) throw new Error(`隔离核心退出 ${serverErrors}`);
    await pause(100);
  }
  throw new Error(`隔离核心启动失败 ${serverErrors}`);
};
const stopServer = async () => {
  if (!backend || backend.exitCode !== null) return;
  const stopped = new Promise(done => backend.once("exit", done)); backend.kill(); await stopped;
};
app.whenReady().then(async () => {
  const { createBlankProjectState } = await importSource("src/data.js");
  const { saveWorkspaceState } = await importSource("src/server/workspace.mjs");
  const { saveRecoveryResumeState } = await importSource("src/server/recovery-store.mjs");
  const { saveWhiteboardGenerationDrafts } = await importSource("src/server/whiteboard-generation-draft-store.mjs");
  const { writeWhiteboardGenerationDraftJournal } = await importSource("src/server/whiteboard-generation-draft-journal.mjs");
  ipcMain.on("shensi:generation-draft:write", (event, payload) => {
    try { event.returnValue = writeWhiteboardGenerationDraftJournal({ ...payload, root: process.env.SHENSI_DATA_ROOT }); }
    catch (error) { event.returnValue = { ok: false, message: error.message }; }
  });
  const { updateWhiteboardGenerationDraftCache } = await importSource("src/whiteboard-generation-draft.js");
  const workspacePath = join(process.env.SHENSI_DATA_ROOT, "作品", "操作栏草稿验收");
  const workspaceId = `project:${workspacePath.toLowerCase()}`;
  const state = createBlankProjectState({ name: "操作栏草稿验收", workspacePath });
  state.activeModule = "manuscript"; state.activeDocument = "draft-board";
  state.documents["draft-board"] = { title: "草稿持久化白板", documentKind: "whiteboard", moduleId: "manuscript", workspaceView: "novel", placementOverride: true,
    canvas: { nodes: [
      { id: "target", kind: "text", type: "text", name: "视频卡片", x: 430, y: 70, width: 320, height: 180, generationIntent: { channel: "video" } },
      { id: "target-b", kind: "text", type: "text", name: "另一视频卡片", x: 430, y: 330, width: 320, height: 180, generationIntent: { channel: "video" } },
      ...["ref-a", "ref-b"].map((id, index) => ({ id, type: "file", kind: "image", file: "media/pixel.png", mimeType: "image/png", name: id, width: 140, height: 100, x: 40, y: 20 + index * 150 })),
    ], edges: ["ref-a", "ref-b"].map(fromNode => ({ id: `edge-${fromNode}`, fromNode, toNode: "target" })), assets: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  state.moduleItems.manuscript.push(["draft-board", "草稿持久化白板", { workspaceView: "novel" }]);
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state });
  await mkdir(join(workspacePath, "media"), { recursive: true });
  await copyFile(join(root, "public/assets/shensi-app-icon.png"), join(workspacePath, "media/pixel.png"));
  await saveRecoveryResumeState({ activeWorkspace: { workspaceKind: "project", workspacePath, projectName: state.projectName, activeModule: "manuscript", activeDocument: "draft-board" } });
  const scope = { workspaceId, documentId: "draft-board", nodeId: "target", channel: "video" };
  let seed = updateWhiteboardGenerationDraftCache({}, scope, { prompt: "旧草稿 @「图片2」 @「图片1」 @「图片2」",
    explicitReferences: "ref-b,ref-a", referenceOrder: "ref-a,ref-b", promptReferenceSequence: "ref-b,ref-a,ref-b",
    connectionId: "video-dreamina-cli-chenan", model: "seedance2.5", generationMode: "smart_params", aspectRatio: "9:16", duration: "22", resolution: "720p", generateAudio: "false", videoCount: "1" });
  seed = updateWhiteboardGenerationDraftCache(seed, { ...scope, nodeId: "target-b" }, { prompt: "另一张卡片独立草稿", connectionId: "video-dreamina-cli-guobazai", model: "seedance2.5", generationMode: "smart_params", aspectRatio: "1:1", duration: "4", resolution: "720p", generateAudio: "false", videoCount: "1" }, { active: false });
  await saveWhiteboardGenerationDrafts({ workspaceKind: "project", workspacePath, cache: seed, sessionUpdatedAt: Date.now() });
  const windowOptions = { show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, backgroundThrottling: false, preload: join(__dirname, "generation-draft-preload.cjs") } };
  browser = new BrowserWindow(windowOptions);
  const originBefore = await startServer(); await browser.loadURL(originBefore);
  await waitFor("document.documentElement.dataset.bootReady==='true' && document.querySelector('#whiteboardVideoDialog')?.open && !document.querySelector('#whiteboardVideoDialog')?.inert", "真实视频操作栏恢复");
  const read = () => browser.webContents.executeJavaScript(`(() => {const f=document.querySelector('#whiteboardVideoForm');return {values:Object.fromEntries([...f.elements].filter(e=>e.name).map(e=>[e.name,e.type==='checkbox'?e.checked:e.value])),chips:[...f.querySelectorAll('[data-rich-mention-node-id]')].map(e=>e.dataset.richMentionNodeId)};})()`);
  const initial = await read();
  assert.equal(initial.values.connectionId.includes("chenan"), true, JSON.stringify(initial));
  assert.equal(initial.values.duration, "22"); assert.equal(initial.values.aspectRatio, "9:16");
  assert.deepEqual(initial.chips, ["ref-b", "ref-a", "ref-b"]);
  await browser.webContents.executeJavaScript(`(() => {
    const f=document.querySelector('#whiteboardVideoForm'),editor=f.querySelector('[contenteditable=true]');
    editor.append(document.createTextNode('刚刚新写且未生成的最后一行！'));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'！'}));
    for(const [name,value] of [['duration','18'],['aspectRatio','4:3'],['generateAudio','true']]){f.elements[name].value=value;f.elements[name].dispatchEvent(new Event('change',{bubbles:true}));}
    return true;
  })()`);
  const expected = await read();
  assert.ok(expected.values.prompt.endsWith("最后一行！"));
  await browser.webContents.executeJavaScript("document.querySelector('[data-canvas-node=target-b]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));true");
  await waitFor("document.querySelector('#whiteboardVideoForm').dataset.nodeId==='target-b' && !document.querySelector('#whiteboardVideoDialog').inert", "切换另一视频卡片");
  assert.equal((await read()).values.prompt, "另一张卡片独立草稿", "切换卡片不能将旧操作栏内容存进新卡片");
  await browser.webContents.executeJavaScript("document.querySelector('[data-canvas-node=target]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));true");
  await waitFor("document.querySelector('#whiteboardVideoForm').dataset.nodeId==='target' && !document.querySelector('#whiteboardVideoDialog').inert", "返回原视频卡片");
  assert.deepEqual(await read(), expected, "切换后返回原卡片必须保留全部最新草稿和选项");
  await browser.webContents.executeJavaScript("window.__draftReloadMarker=true");
  browser.webContents.reload();
  await waitFor("!window.__draftReloadMarker && document.documentElement.dataset.bootReady==='true' && document.querySelector('#whiteboardVideoDialog')?.open && !document.querySelector('#whiteboardVideoDialog').inert", "立即刷新恢复");
  assert.deepEqual(await read(), expected, "立即刷新必须恢复最后一字、参考及所有选项");
  await pause(400);
  const store = await browser.webContents.executeJavaScript(`fetch('/api/whiteboard/generation-drafts?'+new URLSearchParams({workspacePath:${JSON.stringify(workspacePath)},workspaceKind:'project'})).then(r=>r.json())`);
  assert.equal(store.ok, true);
  const record = Object.values(store.cache.entries).find(entry => entry.nodeId === "target");
  assert.equal(record.values.prompt, expected.values.prompt);
  browser.destroy(); browser = null; await stopServer();
  // A new backend gets another origin, so all browser localStorage at this URL
  // is empty. The exact rendered form must come from independent local files.
  const originAfter = await startServer(); assert.notEqual(originBefore, originAfter);
  browser = new BrowserWindow(windowOptions);
  await browser.loadURL(originAfter);
  await waitFor("document.documentElement.dataset.bootReady==='true' && document.querySelector('#whiteboardVideoDialog')?.open && !document.querySelector('#whiteboardVideoDialog').inert", "变更本地地址后的重启恢复");
  assert.deepEqual(await read(), expected, "重启后全部字段和重复参考顺序应完全一致");
  // Simulate a full/denied browser cache AND an unavailable HTTP save, type a
  // final character, then abandon the renderer without waiting for a timer.
  await browser.webContents.executeJavaScript(`(() => {
    const originalSet=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key.startsWith('shensi-whiteboard-generation-'))throw new DOMException('quota','QuotaExceededError');return originalSet.call(this,key,value);};
    const originalFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/api/whiteboard/generation-drafts')&&options?.method==='POST'?Promise.reject(new Error('模拟断网')):originalFetch(url,options);
    const f=document.querySelector('#whiteboardVideoForm'),editor=f.querySelector('[contenteditable=true]');
    editor.append(document.createTextNode('缓存满且断网时的末尾字符☆'));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'☆'}));return true;
  })()`);
  const offlineExpected = await read();
  browser.destroy(); browser = null; await stopServer();
  const offlineOrigin = await startServer(); browser = new BrowserWindow(windowOptions); await browser.loadURL(offlineOrigin);
  await waitFor("document.documentElement.dataset.bootReady==='true' && document.querySelector('#whiteboardVideoDialog')?.open && !document.querySelector('#whiteboardVideoDialog').inert", "缓存满断网后的日志恢复");
  assert.deepEqual(await read(), offlineExpected, "同步日志必须保全缓存满、断网后尚未异步保存的最后一字");
  await waitFor("getComputedStyle(document.querySelector('.boot-recovery-status')).display==='none'", "恢复遮罩退出");
  await waitFor("[...document.querySelectorAll('#whiteboardVideoForm [data-rich-mention-node-id] img')].length===3 && [...document.querySelectorAll('#whiteboardVideoForm [data-rich-mention-node-id] img')].every(img=>img.complete&&img.naturalWidth>0)", "恢复后的每个参考缩略图实际加载");
  await browser.webContents.executeJavaScript("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
  await pause(150);
  const screenshot = join(root, "test-results/generation-draft-toolbar.png"); await mkdir(join(root, "test-results"), { recursive: true });
  await writeFile(screenshot, (await browser.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ passed: true, checks: ["完整应用视频操作栏", "真实富文本输入事件", "切换卡片不串线", "立即刷新", "新进程新端口恢复", "连接/模型/18秒/4:3/720p/声音/数量", "重复插入参考保持顺序", "缓存满+断网+未等定时保存直接丢弃页面后的同步日志恢复"], screenshot }));
  browser.destroy(); browser = null; await stopServer(); app.quit();
}).catch(async error => { console.error(error.stack); if (browser && !browser.isDestroyed()) browser.destroy(); await stopServer(); app.exit(1); });
