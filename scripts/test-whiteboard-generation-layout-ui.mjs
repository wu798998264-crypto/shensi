import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBlankProjectState } from "../src/data.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-generation-layout-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const outputRoot = join(root, "output", "playwright");
const reportPath = join(outputRoot, "whiteboard-generation-layout-ui.json");
const electronExecutable = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const debugPort = 9381;

await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

const child = spawn(electronExecutable, [`--remote-debugging-port=${debugPort}`, desktopEntry], {
  cwd: root,
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: dataRoot,
    SHENSI_MACHINE_DATA_ROOT: dataRoot,
    SHENSI_DESKTOP_USER_DATA_ROOT: userDataRoot,
    SHENSI_SKIP_UPDATE_CHECK: "1",
    SHENSI_TEST_DESKTOP_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let socket;

try {
  const deadline = Date.now() + 30_000;
  let target;
  while (Date.now() < deadline && !target) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
    } catch {}
    if (!target) await delay(100);
  }
  assert.ok(target, `白板生成布局验收窗口未启动：${stderr.slice(-1200)}`);

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const runtimeExceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") {
      runtimeExceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "renderer exception");
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`白板生成布局命令超时：${method}`));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveCommand(value); },
      reject: (error) => { clearTimeout(timer); rejectCommand(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeout = 30_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        if (!/navigated|context|destroyed/iu.test(String(error?.message || error))) throw error;
      }
      await delay(50);
    }
    throw new Error(`等待超时：${label}`);
  };
  const capture = async (name) => {
    const path = join(outputRoot, `whiteboard-generation-expanded-${name}.png`);
    const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path, Buffer.from(screenshot.data, "base64"));
    return path;
  };
  const measure = (dialogId) => evaluate(`(() => {
    const dialog = document.querySelector('#${dialogId}');
    const clear = dialog?.querySelector('[data-clear-whiteboard-generation-references]');
    const reference = dialog?.querySelector('[data-generation-reference-role="upstream"]');
    const prompt = dialog?.querySelector('.whiteboard-generation-prompt-field');
    const options = dialog?.querySelector('.whiteboard-generation-bottom-options');
    const footer = dialog?.querySelector('.whiteboard-generation-footer');
    if (!dialog || !clear || !reference || !prompt || !options || !footer) return null;
    const dialogRect = dialog.getBoundingClientRect();
    const clearRect = clear.getBoundingClientRect();
    const referenceRect = reference.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    const optionsStyle = getComputedStyle(options);
    const textToggleCenters = [...dialog.querySelectorAll('.whiteboard-guidance-toggle, .whiteboard-auto-skill-toggle')].map((toggle) => {
      const toggleRect = toggle.getBoundingClientRect();
      const centerY = toggleRect.top + toggleRect.height / 2;
      const offset = (selector) => {
        const element = toggle.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return (rect.top + rect.height / 2) - centerY;
      };
      return {
        height: toggleRect.height,
        alignItems: getComputedStyle(toggle).alignItems,
        alignContent: getComputedStyle(toggle).alignContent,
        boxSizing: getComputedStyle(toggle).boxSizing,
        borderWidths: getComputedStyle(toggle).borderTopWidth + ' ' + getComputedStyle(toggle).borderBottomWidth,
        gridTemplateRows: getComputedStyle(toggle).gridTemplateRows,
        padding: getComputedStyle(toggle).padding,
        checkbox: offset('input'),
        title: offset('strong'),
        detail: offset('small'),
      };
    });
    return {
      dialogWidth: dialogRect.width,
      clearGap: referenceRect.top - clearRect.bottom,
      optionsHeight: options.getBoundingClientRect().height,
      optionsStyle: {
        controlHeight: optionsStyle.getPropertyValue('--whiteboard-generation-control-height').trim(),
        minHeight: optionsStyle.minHeight,
        padding: optionsStyle.padding,
        borderTopWidth: optionsStyle.borderTopWidth,
        boxSizing: optionsStyle.boxSizing,
        childHeights: [...options.children].map((child) => child.getBoundingClientRect().height),
      },
      footerHeight: footer.getBoundingClientRect().height,
      bottomAreaHeight: dialogRect.bottom - promptRect.bottom,
      textToggleCenters,
    };
  })()`);

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.bringToFront");
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "神思启动");
  await evaluate("localStorage.setItem('shensi:creative-start-welcome:v1', 'seen'); document.querySelector('#creativeStartWelcomeDialog')?.close(); true");

  const created = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const payload = await fetch('/api/projects/create', { method: 'POST', headers, body: JSON.stringify({ name: '白板生成布局隔离验收' }) }).then((response) => response.json());
    if (!payload.ok || !payload.project?.workspacePath) throw new Error(payload.message || '隔离作品创建失败');
    return payload.project;
  })()`);
  const sourceIds = Array.from({ length: 7 }, (_, index) => `layout-source-${index + 1}`);
  const assetDirectory = join(created.workspacePath, "assets");
  await mkdir(assetDirectory, { recursive: true });
  await Promise.all(sourceIds.map((_, index) => {
    const number = String(index + 1);
    const hue = (index * 43 + 195) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="12" fill="hsl(${hue} 48% 42%)"/><text x="80" y="60" text-anchor="middle" font-family="sans-serif" font-size="36" fill="white">${number}</text></svg>`;
    return writeFile(join(assetDirectory, `layout-${number}.svg`), svg, "utf8");
  }));
  const documentId = "whiteboard-generation-layout-ui";
  const fixtureState = createBlankProjectState({ name: created.name, workspacePath: created.workspacePath });
  fixtureState.documents[documentId] = {
    title: "生成操作栏布局验收", moduleId: "manuscript", documentKind: "whiteboard", updatedAt: "现在",
    canvas: {
      nodes: [
        { id: "layout-target", type: "text", kind: "text", name: "生成目标", text: "", x: 260, y: 180, width: 260, height: 170, color: "default" },
        ...sourceIds.map((id, index) => ({
          id, type: "file", kind: "image", name: `参考图 ${index + 1}`, text: "",
          file: `assets/layout-${index + 1}.svg`, mimeType: "image/svg+xml",
          x: 1200 + index * 240, y: 900, width: 220, height: 140, color: "default",
        })),
      ],
      edges: sourceIds.map((fromNode, order) => ({ id: `layout-edge-${order + 1}`, fromNode, toNode: "layout-target", order })),
      assets: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: { snapToGrid: true, gridSize: 20 },
    },
  };
  fixtureState.moduleItems.manuscript ||= [];
  fixtureState.moduleItems.manuscript.push([documentId, "生成操作栏布局验收"]);
  fixtureState.activeModule = "manuscript";
  fixtureState.activeDocument = documentId;
  const activeWorkspace = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const workspacePath = ${JSON.stringify(created.workspacePath)};
    const state = ${JSON.stringify(fixtureState)};
    const saved = await fetch('/api/workspace/save', { method: 'POST', headers, body: JSON.stringify({ workspacePath, state }) }).then((response) => response.json());
    if (!saved.ok) throw new Error(saved.message || '隔离作品保存失败');
    const pointer = { workspacePath, workspaceKind: 'project', projectName: '白板生成布局隔离验收', activeModule: 'manuscript', activeDocument: ${JSON.stringify(documentId)}, resumeRevision: Date.now() };
    const resumed = await fetch('/api/recovery/session', { method: 'POST', headers, body: JSON.stringify({ activeWorkspace: pointer }) }).then((response) => response.json());
    return resumed.activeWorkspace || pointer;
  })()`);
  activeWorkspace.resumeRevision = Date.now() + 60_000;
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('shensi-active-workspace-v1', ${JSON.stringify(JSON.stringify(activeWorkspace))});` });
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('[data-canvas-node=\"layout-target\"]')", "隔离白板恢复");

  await evaluate(`(() => {
    const card = document.querySelector('[data-canvas-node="layout-target"]');
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  })()`);
  await waitFor("document.querySelector('#whiteboardMenu')?.hidden === false", "目标卡片右键菜单");
  await evaluate(`(() => {
    const direct = document.querySelector('[data-whiteboard-direct-generation]');
    if (direct && direct.hidden === false) direct.click();
    else {
      document.querySelector('[data-whiteboard-action="toggle-generate"]').click();
      document.querySelector('#whiteboardGenerateMenu [data-whiteboard-action="generate-text"]').click();
    }
    return true;
  })()`);
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.open === true", "文本生成操作栏");
  await waitFor(`document.querySelectorAll('#whiteboardGenerateDialog [data-generation-reference-role="upstream"]').length === ${sourceIds.length}`, "七项参考呈现");
  await evaluate(`(() => {
    const editor = document.querySelector('#whiteboardGenerateDialog .whiteboard-generation-inline-mentions');
    editor.textContent = '根据上游参考继续生成内容，保持人物、场景与叙事顺序一致。';
    const dialog = document.querySelector('#whiteboardGenerateDialog');
    if (!dialog.classList.contains('is-expanded')) dialog.querySelector('[data-whiteboard-generation-expand]').click();
    return true;
  })()`);
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.classList.contains('is-expanded')", "文本操作栏展开");
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

  const visualState = await evaluate(`(() => {
    const dialog = document.querySelector('#whiteboardGenerateDialog');
    return {
      anchorNodeId: dialog.dataset.anchorNodeId,
      anchorDocumentId: dialog.dataset.anchorDocumentId,
      anchorWorkspaceId: dialog.dataset.anchorWorkspaceId,
      referenceMarkup: dialog.querySelector('.whiteboard-generation-references').innerHTML,
    };
  })()`);
  const dialogs = {
    text: ["whiteboardGenerateDialog", "whiteboardGenerateForm", "whiteboardTextReferences"],
    image: ["whiteboardImageDialog", "whiteboardImageForm", "whiteboardImageReferences"],
    video: ["whiteboardVideoDialog", "whiteboardVideoForm", "whiteboardVideoReferences"],
    audio: ["whiteboardAudioDialog", "whiteboardAudioForm", "whiteboardAudioReferences"],
  };
  const labels = {
    image: { whiteboardImageConnectionLabel: "图片连接", whiteboardImageModelLabel: "图片模型", whiteboardImageSettingsSummary: "16:9 · 高清 · 1张" },
    video: { whiteboardVideoConnectionLabel: "视频连接", whiteboardVideoModelLabel: "视频模型", whiteboardVideoModeLabel: "智能多参", whiteboardVideoSettingsSummary: "16:9 · 8秒 · 1080P" },
    audio: { whiteboardAudioConnectionLabel: "音频连接", whiteboardAudioModelLabel: "音频模型", whiteboardAudioSettingsSummary: "普通话 · 自然 · MP3" },
  };
  const paths = { text: await capture("text") };
  const layouts = { text: await measure(dialogs.text[0]) };

  for (const channel of ["image", "video", "audio"]) {
    const [dialogId, formId, referencesId] = dialogs[channel];
    await evaluate(`(() => {
      document.querySelectorAll('.whiteboard-generation-popover[open]').forEach((item) => item.close());
      const dialog = document.querySelector('#${dialogId}');
      const form = document.querySelector('#${formId}');
      const references = document.querySelector('#${referencesId}');
      dialog.classList.remove('is-expanded');
      dialog.dataset.anchorNodeId = ${JSON.stringify(visualState.anchorNodeId)};
      dialog.dataset.anchorDocumentId = ${JSON.stringify(visualState.anchorDocumentId)};
      dialog.dataset.anchorWorkspaceId = ${JSON.stringify(visualState.anchorWorkspaceId)};
      form.dataset.nodeId = ${JSON.stringify(visualState.anchorNodeId)};
      references.innerHTML = ${JSON.stringify(visualState.referenceMarkup)};
      references.hidden = false;
      references.classList.add('is-media-reference-picker', 'has-references');
      for (const [id, value] of Object.entries(${JSON.stringify(labels[channel])})) {
        const element = document.querySelector('#' + id);
        if (element) element.textContent = value;
      }
      const editor = form.querySelector('.whiteboard-generation-inline-mentions');
      if (editor) editor.textContent = '';
      dialog.showModal();
      if (!dialog.classList.contains('is-expanded')) dialog.querySelector('[data-whiteboard-generation-expand]').click();
      return true;
    })()`);
    await waitFor(`document.querySelector('#${dialogId}')?.open === true && document.querySelector('#${dialogId}')?.classList.contains('is-expanded')`, `${channel} 操作栏展开`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    layouts[channel] = await measure(dialogId);
    paths[channel] = await capture(channel);
  }

  assert.equal(layouts.text.textToggleCenters.length, 2, '文本操作栏必须包含创作引导与自动匹配 Skill 两个开关');
  for (const [index, centers] of layouts.text.textToggleCenters.entries()) {
    const misaligned = ['checkbox', 'title', 'detail'].filter((part) => centers[part] === null || Math.abs(centers[part]) > 1.5);
    assert.deepEqual(misaligned, [], `文本开关 ${index + 1} 的内容必须垂直居中：${JSON.stringify(centers)}`);
  }
  for (const [channel, layout] of Object.entries(layouts)) {
    assert.ok(layout, `${channel} 展开态布局必须可测量`);
    assert.ok(layout.clearGap >= 4, `${channel} 清空参考按钮不得遮挡缩略图：${layout.clearGap}px`);
    assert.ok(layout.optionsHeight <= 38, `${channel} 展开态选项行不得超过 38px：${JSON.stringify(layout)}`);
    assert.ok(layout.footerHeight <= 50, `${channel} 展开态页脚不得超过 50px：${layout.footerHeight}px`);
  }
  assert.deepEqual(runtimeExceptions, [], `渲染进程不应抛出异常：${runtimeExceptions.join(" | ")}`);
  const report = { layouts, paths };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`白板四种生成操作栏展开态布局与截图验收通过：${JSON.stringify(report)}`);
} finally {
  try { socket?.close(); } catch {}
  child.kill();
  await delay(300);
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
