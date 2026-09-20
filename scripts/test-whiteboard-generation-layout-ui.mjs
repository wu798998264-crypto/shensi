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
const installedExecutable = String(process.env.SHENSI_TEST_INSTALLED_EXE || "").trim();
const debugPort = 9381;

await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

const child = spawn(installedExecutable || electronExecutable, installedExecutable
  ? [`--remote-debugging-port=${debugPort}`]
  : [`--remote-debugging-port=${debugPort}`, desktopEntry], {
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
  const clickCenter = async (selector) => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, width: rect.width, height: rect.height, hitClass: hit?.className || "" };
    })()`);
    assert.ok(point?.width > 2 && point?.height > 2, `未找到可点击的生成描述区：${selector} ${JSON.stringify(point)}`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return point;
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
  await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const current = await fetch('/api/generation/profile-settings', { headers }).then((response) => response.json());
    const imageProfile = {
      id: 'image-layout-interaction-test', name: '图片交互隔离测试', remarkName: '图片交互隔离测试',
      adapter: 'cli', provider: 'OpenAI', protocol: 'images', model: 'gpt-image-2.5',
      cliPath: 'shensi-openai-image', cliArgs: '', timeoutMs: '660000',
    };
    const settings = { ...(current.settings || {}) };
    settings.imageConnections = [
      ...(Array.isArray(settings.imageConnections) ? settings.imageConnections.filter((item) => item.id !== imageProfile.id) : []),
      imageProfile,
    ];
    settings.activeImageConnectionId = imageProfile.id;
    const saved = await fetch('/api/generation/profile-settings', {
      method: 'POST', headers,
      body: JSON.stringify({ confirmed: true, expectedRevision: current.revision ?? 0, settings }),
    }).then((response) => response.json());
    if (!saved.ok) throw new Error(saved.message || '隔离图片配置保存失败');
    return true;
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
        { id: "layout-target-2", type: "text", kind: "text", name: "快速切换目标", text: "", x: 620, y: 180, width: 260, height: 170, color: "default" },
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
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.inert === false", "文本生成操作栏解除不可交互状态");
  await waitFor(`document.querySelectorAll('#whiteboardGenerateDialog [data-generation-reference-role="upstream"]').length === ${sourceIds.length}`, "七项参考呈现");
  await evaluate("document.activeElement?.blur?.(); true");
  const placeholderBeforeFocus = await evaluate(`(() => {
    const editor = document.querySelector('#whiteboardGenerateDialog .whiteboard-generation-inline-mentions');
    const pseudo = getComputedStyle(editor, '::before');
    return { content: pseudo.content, userSelect: pseudo.userSelect || pseudo.webkitUserSelect };
  })()`);
  assert.notEqual(placeholderBeforeFocus.content, "none", "空白描述区失焦时应显示灰色提示");
  assert.equal(placeholderBeforeFocus.userSelect, "none", "灰色提示文字不得被选中");
  await clickCenter("#whiteboardGenerateDialog .whiteboard-generation-inline-mentions");
  const placeholderAfterFocus = await evaluate(`(() => {
    const editor = document.querySelector('#whiteboardGenerateDialog .whiteboard-generation-inline-mentions');
    return { focused: document.activeElement === editor, content: getComputedStyle(editor, '::before').content };
  })()`);
  assert.equal(placeholderAfterFocus.focused, true, `点击描述区后必须出现输入焦点：${JSON.stringify(placeholderAfterFocus)}`);
  assert.equal(placeholderAfterFocus.content, "none", "描述区获得焦点后必须隐藏灰色提示");
  await cdp("Input.insertText", { text: "文本真实入口输入" });
  const textEntryState = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    const editor = form.querySelector('.whiteboard-generation-inline-mentions');
    return { focused: document.activeElement === editor, editorText: editor.innerText, sourceValue: form.elements.instruction.value };
  })()`);
  assert.match(textEntryState.editorText, /文本真实入口输入/u, `真实键盘输入必须进入可见描述区：${JSON.stringify(textEntryState)}`);
  assert.match(textEntryState.sourceValue, /文本真实入口输入/u, `真实键盘输入必须同步提交字段：${JSON.stringify(textEntryState)}`);

  const openTextFromCard = async (nodeId, { closeImmediately = false } = {}) => {
    await evaluate(`(() => {
      const card = document.querySelector('[data-canvas-node="${nodeId}"]');
      const rect = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
      // Always choose the text entry explicitly.  A card may remember a
      // previous image/video channel, so the one-click direct action is not a
      // stable text-test route.
      document.querySelector('[data-whiteboard-action="toggle-generate"]').click();
      document.querySelector('#whiteboardGenerateMenu [data-whiteboard-action="generate-text"]').click();
      if (${closeImmediately ? "true" : "false"}) document.querySelector('#whiteboardGenerateDialog')?.close();
      return true;
    })()`);
  };

  // Closing during deferred initialization used to leave the reused native
  // dialog inert.  Reopen immediately, then exercise the same surface many
  // times to catch the long-session regression reported by desktop users.
  await evaluate("document.querySelector('#whiteboardGenerateDialog')?.close(); true");
  await openTextFromCard("layout-target", { closeImmediately: true });
  await delay(20);
  await openTextFromCard("layout-target");
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.open === true && document.querySelector('#whiteboardGenerateDialog')?.inert === false && !document.querySelector('#whiteboardGenerateDialog')?.hasAttribute('aria-busy')", "初始化中关闭后重新打开文本操作栏");
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await evaluate(`(() => {
      const form = document.querySelector('#whiteboardGenerateForm');
      const editor = form?.querySelector('.whiteboard-generation-inline-mentions');
      if (editor) editor.textContent = '';
      if (form?.elements?.instruction) form.elements.instruction.value = '';
      document.querySelector('#whiteboardGenerateDialog')?.close();
      return true;
    })()`);
    await delay(cycle % 4 === 0 ? 5 : 18);
    await openTextFromCard(cycle % 2 ? "layout-target-2" : "layout-target");
    await waitFor("document.querySelector('#whiteboardGenerateDialog')?.open === true && document.querySelector('#whiteboardGenerateDialog')?.inert === false && !document.querySelector('#whiteboardGenerateDialog')?.hasAttribute('aria-busy')", `长期循环 ${cycle + 1} 次解除交互锁`);
    await clickCenter("#whiteboardGenerateDialog .whiteboard-generation-inline-mentions");
    await cdp("Input.insertText", { text: `循环输入${cycle + 1}` });
    const cycleState = await evaluate(`(() => {
      const dialog = document.querySelector('#whiteboardGenerateDialog');
      const form = document.querySelector('#whiteboardGenerateForm');
      const editor = form?.querySelector('.whiteboard-generation-inline-mentions');
      return {
        open: dialog?.open === true,
        inert: dialog?.inert === true,
        busy: dialog?.hasAttribute('aria-busy') === true,
        focused: document.activeElement === editor,
        editable: editor?.getAttribute('contenteditable'),
        sourceValue: form?.elements?.instruction?.value || '',
      };
    })()`);
    assert.equal(cycleState.open, true, `循环 ${cycle + 1} 操作栏必须保持打开`);
    assert.equal(cycleState.inert, false, `循环 ${cycle + 1} 不得残留 inert：${JSON.stringify(cycleState)}`);
    assert.equal(cycleState.busy, false, `循环 ${cycle + 1} 不得残留 aria-busy：${JSON.stringify(cycleState)}`);
    assert.equal(cycleState.focused, true, `循环 ${cycle + 1} 描述区必须可获得光标：${JSON.stringify(cycleState)}`);
    assert.equal(cycleState.editable, "true", `循环 ${cycle + 1} 描述区必须保持可编辑`);
    assert.match(cycleState.sourceValue, new RegExp(`循环输入${cycle + 1}`, "u"));
  }
  // Restore the reference-rich fixture card before collecting the visual
  // layout snapshot; the alternating stress loop intentionally opens a card
  // without upstream references on every other iteration.
  await evaluate("document.querySelector('#whiteboardGenerateDialog')?.close(); true");
  await delay(10);
  await openTextFromCard("layout-target");
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.open === true && document.querySelector('#whiteboardGenerateDialog')?.inert === false && !document.querySelector('#whiteboardGenerateDialog')?.hasAttribute('aria-busy')", "循环验收后恢复带参考文本操作栏");
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

  await evaluate(`(() => {
    document.querySelector('#whiteboardGenerateDialog')?.close();
    const card = document.querySelector('[data-canvas-node="layout-target"]');
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    document.querySelector('[data-whiteboard-action="toggle-generate"]').click();
    document.querySelector('#whiteboardGenerateMenu [data-whiteboard-action="generate-image"]').click();
    return true;
  })()`);
  await waitFor("document.querySelector('#whiteboardImageDialog')?.open === true", "真实生成图片入口");
  await waitFor("document.querySelector('#whiteboardImageDialog')?.inert === false && !document.querySelector('#whiteboardImageDialog')?.hasAttribute('aria-busy')", "图片生成操作栏解除不可交互状态");
  await evaluate(`(() => {
    const openImageFor = (nodeId) => {
      const card = document.querySelector('[data-canvas-node="' + nodeId + '"]');
      const rect = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      const direct = document.querySelector('[data-whiteboard-direct-generation]');
      if (direct && direct.hidden === false && /图片/u.test(direct.textContent || '')) direct.click();
      else {
        document.querySelector('[data-whiteboard-action="toggle-generate"]').click();
        document.querySelector('#whiteboardGenerateMenu [data-whiteboard-action="generate-image"]').click();
      }
    };
    openImageFor('layout-target-2');
    openImageFor('layout-target');
    return true;
  })()`);
  await waitFor("document.querySelector('#whiteboardImageDialog')?.dataset.anchorNodeId === 'layout-target' && document.querySelector('#whiteboardImageDialog')?.inert === false && !document.querySelector('#whiteboardImageDialog')?.hasAttribute('aria-busy')", "图片弹窗快速切换卡片后恢复交互");
  await clickCenter("#whiteboardImageDialog .whiteboard-generation-inline-mentions");
  await cdp("Input.insertText", { text: "图片真实入口输入" });
  await waitFor("document.querySelector('#whiteboardImageForm').elements.prompt.value.includes('图片真实入口输入')", "图片真实入口描述区输入");

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
      return true;
    })()`);
    await waitFor(`document.querySelector('#${dialogId}')?.open === true`, `${channel} 操作栏打开`);
    const editorSelector = `#${dialogId} .whiteboard-generation-inline-mentions`;
    const hit = await clickCenter(editorSelector);
    await cdp("Input.insertText", { text: `${channel}真实键盘输入` });
    await waitFor(`document.querySelector('#${formId}').elements.prompt.value.includes(${JSON.stringify(`${channel}真实键盘输入`)})`, `${channel} 描述区真实输入`);
    const inputState = await evaluate(`(() => {
      const dialog = document.querySelector('#${dialogId}');
      const editor = dialog?.querySelector('.whiteboard-generation-inline-mentions');
      return {
        focused: document.activeElement === editor,
        editable: editor?.getAttribute('contenteditable'),
        inert: dialog?.inert === true,
        pointerEvents: getComputedStyle(editor).pointerEvents,
        userSelect: getComputedStyle(editor).userSelect,
        text: editor?.innerText || '',
      };
    })()`);
    assert.equal(inputState.focused, true, `${channel} 描述区点击后必须获得光标：${JSON.stringify({ hit, inputState })}`);
    assert.equal(inputState.editable, "true", `${channel} 描述区必须保持可编辑`);
    assert.equal(inputState.inert, false, `${channel} 弹窗不得残留 inert`);
    assert.equal(inputState.pointerEvents, "auto", `${channel} 描述区不得屏蔽鼠标事件`);
    assert.match(inputState.text, new RegExp(`${channel}真实键盘输入`, "u"));
    await evaluate(`document.querySelector('#${dialogId} [data-whiteboard-generation-expand]').click(); true`);
    await waitFor(`document.querySelector('#${dialogId}')?.classList.contains('is-expanded')`, `${channel} 操作栏展开`);
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
