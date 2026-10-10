// Explicitly paid acceptance: one real whiteboard click, one 4s Mini video.
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { readFile, writeFile, mkdir, copyFile, readdir } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:net");
const assert = require("node:assert/strict");
const root = resolve(__dirname, "../..");
const acceptanceRoot = process.env.SHENSI_LIBTV_VIDEO_ACCEPTANCE_ROOT;
if (!acceptanceRoot) throw new Error("必须指定独立视频验收目录");
const reviewOnly = process.env.SHENSI_LIBTV_VIDEO_REVIEW_ONLY === "1";
if (process.env.SHENSI_LIBTV_VIDEO_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.SHENSI_LIBTV_VIDEO_DEBUG_PORT);
app.setPath("userData", join(acceptanceRoot, reviewOnly ? "desktop-review" : "desktop"));
app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
const pause = ms => new Promise(done => setTimeout(done, ms));
const importSource = name => import(pathToFileURL(join(root, name)).href);
let backend, browser, serverErrors = "", clicked = false;
const waitFor = async (expression, label, timeout = 45_000) => {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await browser.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await pause(150);
  }
  const ui = await browser.webContents.executeJavaScript(`({toast:document.querySelector('#toast')?.textContent,ready:document.documentElement.dataset.bootReady,form:document.querySelector('#whiteboardVideoForm')?.outerHTML.slice(0,400)})`).catch(() => ({}));
  throw new Error(`${label}超时 ${JSON.stringify(ui)} ${serverErrors.slice(-800)}`);
};
const stop = async () => {
  if (browser && !browser.isDestroyed()) browser.destroy();
  if (backend && backend.exitCode === null) {
    const stopped = new Promise(done => backend.once("exit", done)); backend.kill(); await stopped;
  }
};
app.whenReady().then(async () => {
  const dataRoot = process.env.SHENSI_DATA_ROOT;
  const existingJobs = await readdir(join(dataRoot, "generation-jobs")).catch(() => []);
  if (!reviewOnly) assert.equal(existingJobs.some(name => /^generation-.*\.json$/u.test(name)), false, "此验收目录已有付费任务，禁止重复点击；先核对原任务");
  const profileSource = "E:/ShensiUserData/config/generation-profiles-v1.json";
  const profilesBefore = createHash("sha256").update(await readFile(profileSource)).digest("hex");
  await mkdir(join(dataRoot, "config"), { recursive: true });
  if (!reviewOnly) await copyFile(profileSource, join(dataRoot, "config/generation-profiles-v1.json"));
  const stored = JSON.parse(await readFile(profileSource, "utf8"));
  const profile = stored.settings.videoConnections.find(item => item.provider === "LibTV");
  assert.ok(profile, "现有 LibTV 视频配置缺失");
  const { createBlankProjectState } = await importSource("src/data.js");
  const { saveWorkspaceState } = await importSource("src/server/workspace.mjs");
  const { saveRecoveryResumeState } = await importSource("src/server/recovery-store.mjs");
  const { saveWhiteboardGenerationDrafts } = await importSource("src/server/whiteboard-generation-draft-store.mjs");
  const { writeWhiteboardGenerationDraftJournal } = await importSource("src/server/whiteboard-generation-draft-journal.mjs");
  const { updateWhiteboardGenerationDraftCache } = await importSource("src/whiteboard-generation-draft.js");
  ipcMain.on("shensi:generation-draft:write", (event, payload) => {
    try { event.returnValue = writeWhiteboardGenerationDraftJournal({ ...payload, root: dataRoot }); }
    catch (error) { event.returnValue = { ok: false, message: error.message }; }
  });
  const workspacePath = join(dataRoot, "作品", "LibTV视频专项验收");
  const documentId = "libtv-video-acceptance", nodeId = "video-target";
  const state = createBlankProjectState({ name: "LibTV视频专项验收", workspacePath });
  state.activeModule = "manuscript"; state.activeDocument = documentId;
  state.settings = { ...state.settings, ...stored.settings, workspacePath };
  state.documents[documentId] = { title: "2.0 Mini · 4秒视频验收", documentKind: "whiteboard", moduleId: "manuscript", workspaceView: "novel", placementOverride: true,
    canvas: { nodes: [{ id: nodeId, type: "text", kind: "text", name: "LibTV 2.0 Mini · 4秒", x: 160, y: 80, width: 480, height: 270, generationIntent: { channel: "video" } }], edges: [], assets: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  state.moduleItems.manuscript.push([documentId, state.documents[documentId].title, { workspaceView: "novel" }]);
  if (!reviewOnly) await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state });
  await saveRecoveryResumeState({ activeWorkspace: { workspaceKind: "project", workspacePath, projectName: state.projectName, activeModule: "manuscript", activeDocument: documentId } });
  const cache = updateWhiteboardGenerationDraftCache({}, { workspaceId: `project:${workspacePath.toLowerCase()}`, documentId, nodeId, channel: "video" }, {
    prompt: "白色摄影棚中的银色金属方块缓慢旋转，柔和灯光，稳定镜头，产品展示，四秒连续镜头，无人物，无文字，无字幕。",
    connectionId: profile.id, model: "star-video2-mini", generationMode: "smart_params", aspectRatio: "16:9", duration: "4", resolution: "720p", generateAudio: "false", videoCount: "1",
  });
  if (!reviewOnly) await saveWhiteboardGenerationDrafts({ workspaceKind: "project", workspacePath, cache, sessionUpdatedAt: Date.now() });
  const probe = createServer(); await new Promise(done => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const origin = `http://127.0.0.1:${port}`;
  backend = spawn(process.env.SHENSI_TEST_NODE, [join(root, "server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SHENSI_SKIP_UPDATE_CHECK: "1" }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  backend.stderr.on("data", value => { serverErrors = (serverErrors + value).slice(-2500); });
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    if (await fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false)) break;
    if (backend.exitCode !== null) throw new Error(`隔离核心启动失败 ${serverErrors}`);
    await pause(150);
  }
  browser = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, backgroundThrottling: false, preload: join(__dirname, "generation-draft-preload.cjs") } });
  await browser.loadURL(origin);
  await waitFor("document.documentElement.dataset.bootReady==='true'", "真实白板启动");
  if (!reviewOnly) {
    await waitFor("document.querySelector('#whiteboardVideoDialog')?.open && !document.querySelector('#whiteboardVideoDialog').inert", "真实白板操作栏");
    await waitFor("document.querySelector('#whiteboardVideoForm').elements.model.value==='star-video2-mini' && document.querySelector('#whiteboardVideoForm').elements.duration.value==='4'", "Mini模型与4秒时长");
  }
  const selected = await browser.webContents.executeJavaScript(`(() => {const f=document.querySelector('#whiteboardVideoForm');return Object.fromEntries(['connectionId','model','duration','resolution','aspectRatio','generateAudio'].map(key=>[key,f.elements[key].value]));})()`);
  if (!reviewOnly) { assert.equal(selected.connectionId, profile.id); assert.equal(selected.model, "star-video2-mini"); assert.equal(selected.duration, "4"); }
  console.log(JSON.stringify({ event: "ready", origin, workspacePath, selected, isolation: true }));
  await waitFor("getComputedStyle(document.querySelector('.boot-recovery-status')).display==='none'", "启动恢复完成");
  // Exactly one real submit-button click: no direct media-job API, no replay.
  if (!reviewOnly) {
    assert.equal(clicked, false); clicked = true;
    await browser.webContents.executeJavaScript(`document.querySelector('#whiteboardVideoForm button[type=submit]').click(); true`);
  }
  let job, lastStatus = "";
  const jobsRoot = join(dataRoot, "generation-jobs");
  for (const deadline = Date.now() + 30 * 60_000; Date.now() < deadline;) {
    const files = await readdir(jobsRoot).catch(() => []);
    for (const name of files.filter(name => /^generation-.*\.json$/u.test(name))) {
      try {
        const record = JSON.parse(await readFile(join(jobsRoot, name), "utf8"));
        if (record.target?.documentId === documentId && record.channel === "video") job = record;
      } catch {}
    }
    if (job && `${job.status}:${job.providerTaskId}` !== lastStatus) {
      lastStatus = `${job.status}:${job.providerTaskId}`;
      console.log(JSON.stringify({ event: "progress", jobId: job.id, status: job.status, providerTaskId: job.providerTaskId, error: job.error || "" }));
    }
    if (job && ["complete", "failed", "retry_required", "cancelled"].includes(job.status)) break;
    await pause(1500);
  }
  assert.ok(job, "点击后没有创建真实任务");
  console.log(JSON.stringify({ event: "ui-verification", step: "read-completed-job" }));
  const uiResult = await browser.webContents.executeJavaScript(`fetch('/api/generation/jobs/'+${JSON.stringify(job.id)}).then(r=>r.json())`);
  job = uiResult.job;
  console.log(JSON.stringify({ event: "ui-verification", step: "await-card", status: job.status }));
  await waitFor(`document.querySelector('[data-canvas-node="${nodeId}"] [data-whiteboard-video-activate]')`, "白板视频回写", 30_000);
  await waitFor(`document.querySelector('[data-canvas-node="${nodeId}"] img')?.complete && document.querySelector('[data-canvas-node="${nodeId}"] img')?.naturalWidth>0`, "真实视频封面加载");
  await browser.webContents.executeJavaScript("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
  await pause(300);
  const screenshot = join(acceptanceRoot, "libtv-mini-4s-whiteboard.png");
  await writeFile(screenshot, (await browser.webContents.capturePage()).toPNG());
  // Video cards intentionally start with a thumbnail; test a human's play
  // click before requiring a video element/decoded metadata.
  await browser.webContents.executeJavaScript(`document.querySelector('[data-canvas-node="${nodeId}"] [data-whiteboard-video-activate]').click(); true`);
  await waitFor(`document.querySelector('[data-canvas-node="${nodeId}"] video')?.readyState>=2`, "白板视频可播放", 30_000);
  await browser.webContents.executeJavaScript(`document.querySelector('[data-canvas-node="${nodeId}"] video').pause(); true`);
  const card = await browser.webContents.executeJavaScript(`(() => {const node=document.querySelector('[data-canvas-node="${nodeId}"]'),v=node?.querySelector('video');return {text:node?.innerText,video: v ? {src:v.currentSrc||v.src,duration:v.duration,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState}:null};})()`);
  console.log(JSON.stringify({ event: "ui-verification", step: "capture", card }));
  const attachment = job.result?.attachment;
  let outputPath = "", bytes = 0, sha256 = "";
  if (attachment?.relativePath) {
    outputPath = join(workspacePath, attachment.relativePath);
    const buffer = await readFile(outputPath); bytes = buffer.length; sha256 = createHash("sha256").update(buffer).digest("hex");
  }
  assert.equal(createHash("sha256").update(await readFile(profileSource)).digest("hex"), profilesBefore, "原配置必须完全不变");
  const report = { ok: job.status === "complete" && sha256 === attachment?.sha256 && card.video?.readyState >= 1, jobId: job.id, status: job.status, model: job.request?.settings?.model, providerTaskId: job.providerTaskId,
    generationAndDownloadSeconds: (Date.parse(attachment?.createdAt)-Date.parse(job.createdAt))/1000,
    appliedAt: job.appliedAt || "", verifiedAt: new Date().toISOString(), error: job.error || "", selected: reviewOnly ? { connectionId: job.profileId, model: job.request.settings.model, duration: job.request.duration, resolution: job.request.resolution, aspectRatio: job.request.aspectRatio, generateAudio: job.request.generateAudio } : selected,
    bytes, sha256, outputPath, card, screenshot, workspacePath, originalProfilesUnchanged: true };
  await writeFile(join(acceptanceRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "result", ...report }));
  assert.equal(report.ok, true, "真实生成/下载/校验/卡片回写未全部通过");
  assert.ok(Math.abs(card.video.duration - 4) < 0.25, "实际视频时长必须为4秒");
  await stop(); app.quit();
}).catch(async error => { console.error(error.stack); await stop(); app.exit(1); });
