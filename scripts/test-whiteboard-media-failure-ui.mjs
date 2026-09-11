import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-media-failure-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(userDataRoot, { recursive: true })]);
process.env.SHENSI_DATA_ROOT = dataRoot;
process.env.SHENSI_MACHINE_DATA_ROOT = dataRoot;

const [{ createBlankProjectState }, { createCanvasTextNode }, workspaceStore, generationStore] = await Promise.all([
  import("../src/data.js"),
  import("../src/whiteboard.js"),
  import("../src/server/workspace.mjs"),
  import(`../src/server/generation-job-store.mjs?failure-ui=${Date.now()}`),
]);
const project = await workspaceStore.createWorkspaceProject({ appRoot: root, name: "媒体失败卡片验收" });
const workspace = {
  workspacePath: project.workspacePath,
  documentId: "whiteboard-media-failure",
  nodeId: "video-failure-card",
  silentNodeId: "video-silent-failure-card",
};
const workspaceState = createBlankProjectState({ name: project.name, workspacePath: project.workspacePath });
workspaceState.activeModule = "manuscript";
workspaceState.activeDocument = workspace.documentId;
workspaceState.moduleLastDocuments.manuscript = workspace.documentId;
workspaceState.moduleItems.manuscript.push([workspace.documentId, "视频失败验收白板", {}]);
workspaceState.documents[workspace.documentId] = {
  title: "视频失败验收白板",
  html: "",
  markdown: "",
  moduleId: "manuscript",
  documentKind: "whiteboard",
  updatedAt: Date.now(),
  canvas: {
    nodes: [
      createCanvasTextNode({ id: workspace.nodeId, name: "待生成视频", width: 420, height: 230, x: 80, y: 80 }),
      createCanvasTextNode({ id: workspace.silentNodeId, name: "无详情失败视频", width: 420, height: 230, x: 540, y: 80 }),
    ],
    edges: [],
    assets: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { snapToGrid: true, gridSize: 20 },
  },
};
await workspaceStore.saveWorkspaceState({
  appRoot: root,
  requestedPath: workspace.workspacePath,
  state: workspaceState,
  operationDocumentIds: [workspace.documentId],
});

const prompt = "一艘纸船穿过雨夜霓虹，电影感跟拍";
const job = await generationStore.createMediaGenerationJob({
  channel: "video",
  target: {
    workspaceKind: "project",
    workspacePath: workspace.workspacePath,
    documentId: workspace.documentId,
    nodeId: workspace.nodeId,
    targetType: "whiteboard-node",
  },
  request: {
    prompt,
    settings: {
      id: "video-dreamina-cli",
      connectionId: "video-dreamina-cli",
      name: "即梦视频 CLI",
      remarkName: "柏物语",
      provider: "即梦",
      adapter: "cli",
      protocol: "videos",
      model: "seedance2.5",
      dreaminaCliProfile: "baiwuyu",
    },
    duration: 30,
    resolution: "720p",
    aspectRatio: "16:9",
  },
  submissionId: "media-failure-ui-0001",
});
await generationStore.updateMediaGenerationJob({ jobId: job.id, patch: {
  status: "running",
  providerStatus: "running",
  providerTaskId: "",
  providerErrorCode: "",
  submissionState: "not_submitted",
  progressPercent: 18,
  billingRisk: "",
  error: "",
} });
const silentFailureJob = await generationStore.createMediaGenerationJob({
  channel: "video",
  target: {
    workspaceKind: "project",
    workspacePath: workspace.workspacePath,
    documentId: workspace.documentId,
    nodeId: workspace.silentNodeId,
    targetType: "whiteboard-node",
  },
  request: job.request,
  submissionId: "media-failure-ui-0002",
});
await generationStore.updateMediaGenerationJob({ jobId: silentFailureJob.id, patch: {
  status: "running",
  providerStatus: "running",
  providerTaskId: "",
  providerErrorCode: "",
  submissionState: "not_submitted",
  progressPercent: 12,
  billingRisk: "",
  error: "",
} });

const availableLoopbackPort = () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once("error", rejectPort);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
  });
});

const debugPort = await availableLoopbackPort();
const electronExecutable = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const child = spawn(electronExecutable, [
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
    SHENSI_DISABLE_MEDIA_RECOVERY_WORKERS: "1",
    SHENSI_TEST_DESKTOP_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let socket = null;

try {
  const targetDeadline = Date.now() + 30_000;
  let pageTarget = null;
  while (Date.now() < targetDeadline && !pageTarget) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      pageTarget = targets.find((target) => target.type === "page" && /127\.0\.0\.1|localhost/u.test(target.url));
    } catch {}
    if (!pageTarget) await delay(200);
  }
  assert.ok(pageTarget, `神思测试窗口未启动：${stderr}`);

  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`调试命令超时：${method}`));
    }, 45_000);
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        if (!/Inspected target navigated|Cannot find context|Execution context was destroyed/iu.test(String(error?.message || error))) throw error;
      }
      await delay(100);
    }
    const diagnostic = await evaluate(`(() => ({
      module: document.querySelector('#moduleSwitcher [data-module].active')?.dataset.module || '',
      addDocument: Boolean(document.querySelector('#addDocument')),
      addDisabled: document.querySelector('#addDocument')?.disabled,
      dialogOpen: document.querySelector('#textDialog')?.open === true,
      body: document.body?.innerText?.slice(0, 700) || '',
    }))()`).catch(() => null);
    throw new Error(`等待超时：${label}；页面=${JSON.stringify(diagnostic)}；${stderr}`);
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await waitFor("document.documentElement?.dataset?.bootReady === 'true'", "应用启动");
  await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const current = await fetch('/api/recovery/session', { headers: { 'x-shensi-session': token } }).then((response) => response.json());
    const resumeRevision = Math.max(Date.now(), Number(current?.activeWorkspace?.resumeRevision || 0) + 1);
    const response = await fetch('/api/recovery/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shensi-session': token },
      body: JSON.stringify({ activeWorkspace: {
        workspacePath: ${JSON.stringify(workspace.workspacePath)},
        workspaceKind: 'project',
        projectName: '媒体失败卡片验收',
        activeModule: 'manuscript',
        activeDocument: ${JSON.stringify(workspace.documentId)},
        activeConversationId: ${JSON.stringify(workspaceState.activeConversationId)},
        resumeRevision,
      } }),
    });
    if (!response.ok) throw new Error('恢复测试作品失败');
    return true;
  })()`);
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor("document.documentElement?.dataset?.bootReady === 'true'", "失败任务重载");
  await evaluate(`document.querySelector('#dismissCreativeStartWelcome')?.click(); true`);
  await waitFor("document.querySelector('#whiteboardEditor') && !document.querySelector('#whiteboardEditor').hidden", "测试白板恢复");
  await waitFor(`document.querySelector('[data-canvas-node=${JSON.stringify(workspace.nodeId)}][data-generation-status="running"]')`, "运行中视频卡片显示", 45_000);
  await waitFor(`document.querySelector('[data-canvas-node=${JSON.stringify(workspace.silentNodeId)}][data-generation-status="running"]')`, "无详情测试视频卡片显示", 45_000);
  await generationStore.updateMediaGenerationJob({ jobId: silentFailureJob.id, patch: {
    status: "failed",
    providerStatus: "failed",
    providerTaskId: "",
    providerErrorCode: "",
    submissionState: "not_submitted",
    progressPercent: 100,
    billingRisk: "",
    failedAt: new Date().toISOString(),
    error: "",
  } });
  await waitFor(`document.querySelector('[data-canvas-node=${JSON.stringify(workspace.silentNodeId)}] .whiteboard-generation-failure-detail')`, "无详情失败卡片显示", 45_000);
  const silentFailureView = await evaluate(`(() => {
    const card = document.querySelector('[data-canvas-node=${JSON.stringify(workspace.silentNodeId)}]');
    return {
      text: card.querySelector('.whiteboard-generation-failure-detail')?.textContent || '',
      status: card.dataset.generationStatus,
    };
  })()`);
  assert.equal(silentFailureView.status, "failed");
  assert.match(silentFailureView.text, /DREAMINA_UNCLASSIFIED_FAILURE/u, "运行器没有提供错误详情时也必须显示兜底错误码");
  assert.match(silentFailureView.text, new RegExp(silentFailureJob.id), "无详情失败也必须显示神思任务号");

  await generationStore.updateMediaGenerationJob({ jobId: job.id, patch: {
    status: "failed",
    providerStatus: "failed",
    providerTaskId: "",
    providerErrorCode: "",
    submissionState: "not_submitted",
    progressPercent: 100,
    billingRisk: "",
    failedAt: new Date().toISOString(),
    error: "upload resource: ApplyImageUpload http://imagex.bytedanceapi.com/?Action=ApplyImageUpload: context deadline exceeded",
  } });
  await waitFor(`document.querySelector('[data-canvas-node=${JSON.stringify(workspace.nodeId)}] .whiteboard-generation-failure-detail')`, "失败卡片显示", 45_000);
  const failureView = await evaluate(`(() => {
    const card = document.querySelector('[data-canvas-node=${JSON.stringify(workspace.nodeId)}]');
    const detail = card.querySelector('.whiteboard-generation-failure-detail');
    const retry = card.querySelector('[data-media-job-action="retry_setup"]');
    const cardRect = card.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
    const retryRect = retry?.getBoundingClientRect();
    return {
      text: detail.textContent,
      status: card.dataset.generationStatus,
      retryVisible: Boolean(retryRect && retryRect.width > 0 && retryRect.height > 0),
      actions: card.querySelector('.media-generation-actions')?.textContent || '',
      detailInsideCard: detailRect.left >= cardRect.left && detailRect.right <= cardRect.right && detailRect.top >= cardRect.top && detailRect.bottom <= cardRect.bottom,
      retryInsideCard: Boolean(retryRect && retryRect.left >= cardRect.left && retryRect.right <= cardRect.right && retryRect.top >= cardRect.top && retryRect.bottom <= cardRect.bottom),
    };
  })()`);
  assert.equal(failureView.status, "failed");
  assert.match(failureView.text, /柏物语/u);
  assert.match(failureView.text, /DREAMINA_UNCLASSIFIED_FAILURE/u);
  assert.match(failureView.text, /ApplyImageUpload/u);
  assert.match(failureView.text, /context deadline exceeded/u);
  assert.match(failureView.text, new RegExp(job.id));
  assert.equal(failureView.retryVisible, true, JSON.stringify(failureView));
  assert.equal(failureView.detailInsideCard, true);
  assert.equal(failureView.retryInsideCard, true);

  const beforeJobs = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const payload = await fetch('/api/generation/jobs?workspacePath=' + encodeURIComponent(${JSON.stringify(workspace.workspacePath)}), { headers: { 'x-shensi-session': token } }).then((response) => response.json());
    return payload.jobs.map((item) => item.id);
  })()`);
  await evaluate(`document.querySelector('[data-canvas-node=${JSON.stringify(workspace.nodeId)}] [data-media-job-action="retry_setup"]').click(); true`);
  await waitFor(`(() => {
    const dialog = document.querySelector('#whiteboardVideoDialog');
    return dialog?.open === true && !dialog.hasAttribute('aria-busy') && dialog.inert !== true;
  })()`, "恢复视频生成面板完成初始化");
  const retryView = await evaluate(`(() => ({
    prompt: document.querySelector('#whiteboardVideoForm')?.elements?.prompt?.value || '',
    visiblePrompt: document.querySelector('#whiteboardVideoForm .whiteboard-generation-inline-mentions')?.innerText || '',
    duration: document.querySelector('#whiteboardVideoForm')?.elements?.duration?.value || '',
    resolution: document.querySelector('#whiteboardVideoForm')?.elements?.resolution?.value || '',
    aspectRatio: document.querySelector('#whiteboardVideoForm')?.elements?.aspectRatio?.value || '',
    candidateVisible: Boolean(document.querySelector('[data-canvas-node=${JSON.stringify(workspace.nodeId)}] .whiteboard-generation-failure-detail')),
  }))()`);
  assert.equal(retryView.prompt, prompt);
  assert.equal(retryView.visiblePrompt, prompt);
  assert.equal(retryView.duration, "30");
  assert.equal(retryView.resolution, "720p");
  assert.equal(retryView.aspectRatio, "16:9");
  assert.equal(retryView.candidateVisible, false, "打开重试面板后旧失败遮罩应立即移除");
  const afterJobs = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const payload = await fetch('/api/generation/jobs?workspacePath=' + encodeURIComponent(${JSON.stringify(workspace.workspacePath)}), { headers: { 'x-shensi-session': token } }).then((response) => response.json());
    return payload.jobs.map((item) => item.id);
  })()`);
  assert.deepEqual(afterJobs, beforeJobs, "恢复表单不得自动创建新的收费媒体任务");

  console.log("Whiteboard terminal media failure UI tests passed");
} finally {
  try { socket?.close(); } catch {}
  try { child.kill(); } catch {}
  await delay(500);
  await rm(runtimeRoot, { recursive: true, force: true });
}
