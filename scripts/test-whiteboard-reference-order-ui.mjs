import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBlankProjectState } from "../src/data.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-reference-order-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const outputRoot = join(root, "output", "playwright");
const evidencePath = join(outputRoot, "whiteboard-reference-order-ui.png");
const reportPath = join(outputRoot, "whiteboard-reference-order-ui.json");
const electronExecutable = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const debugPort = 9377;

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
  assert.ok(target, `白板参考顺序验收窗口未启动：${stderr.slice(-1200)}`);

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
      rejectCommand(new Error(`白板参考顺序验收命令超时：${method}`));
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
  const pointFor = async (selector, { xRatio = 0.5, yRatio = 0.5 } = {}) => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width * ${xRatio}, y: rect.top + rect.height * ${yRatio}, width: rect.width, height: rect.height };
    })()`);
    assert.ok(point && point.width > 2 && point.height > 2, `元素不可点击：${selector}`);
    return point;
  };
  const click = async (selector, options) => {
    const point = await pointFor(selector, options);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const contextClick = async (selector) => {
    const point = await pointFor(selector);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "right", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "right", clickCount: 1 });
  };
  const key = async ({ type = "keyDown", key: keyName, code, modifiers = 0, windowsVirtualKeyCode }) => {
    await cdp("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code: code || keyName,
      modifiers,
      windowsVirtualKeyCode: windowsVirtualKeyCode ?? keyName.toUpperCase().charCodeAt(0),
    });
  };
  const shortcut = async (keyName, code, windowsVirtualKeyCode) => {
    await key({ key: "Control", code: "ControlLeft", modifiers: 2, windowsVirtualKeyCode: 17 });
    await key({ key: keyName, code, modifiers: 2, windowsVirtualKeyCode });
    await key({ type: "keyUp", key: keyName, code, modifiers: 2, windowsVirtualKeyCode });
    await key({ type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  };
  const openTextGeneration = async () => {
    await contextClick('[data-canvas-node="reference-order-target"]');
    await delay(100);
    if (await evaluate("document.querySelector('#whiteboardMenu')?.hidden !== false")) {
      // Large-board progressive rendering can replace the card between a CDP
      // mouse-down and mouse-up. Dispatch the same browser contextmenu event
      // against the current node so this reference-order test does not spend
      // its assertion budget retesting pointer stability.
      await evaluate(`(() => {
        const card = document.querySelector('[data-canvas-node="reference-order-target"]');
        const rect = card?.getBoundingClientRect();
        if (!card || !rect) return false;
        return card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      })()`);
    }
    await waitFor("document.querySelector('#whiteboardMenu')?.hidden === false", "目标卡片右键菜单");
    const direct = await evaluate("document.querySelector('[data-whiteboard-direct-generation]')?.hidden === false");
    if (direct) {
      await evaluate("document.querySelector('[data-whiteboard-direct-generation]').click(); true");
    } else {
      await evaluate("document.querySelector('[data-whiteboard-action=\"toggle-generate\"]').click(); true");
      await waitFor("document.querySelector('#whiteboardGenerateMenu')?.hidden === false", "生成类型菜单");
      await evaluate("document.querySelector('#whiteboardGenerateMenu [data-whiteboard-action=\"generate-text\"]').click(); true");
    }
    await waitFor("document.querySelector('#whiteboardGenerateDialog')?.open === true", "文本生成操作栏");
    await waitFor(`document.querySelectorAll('#whiteboardGenerateDialog [data-generation-reference-role="upstream"]').length === ${sourceIds.length}`, `${sourceIds.length} 个上游参考呈现`);
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.bringToFront");
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "神思启动");
  await evaluate("localStorage.setItem('shensi:creative-start-welcome:v1', 'seen'); document.querySelector('#creativeStartWelcomeDialog')?.close(); true");
  // Keep the interactive UI case immediately below the 48-node progressive
  // rendering threshold. The runtime contract separately retains the 50-item
  // stress case; this test focuses on prompt/reference behavior, not rendering
  // scheduler timing.
  const sourceIds = Array.from({ length: 47 }, (_, index) => `reference-order-source-${index + 1}`);
  const created = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const payload = await fetch('/api/projects/create', { method: 'POST', headers, body: JSON.stringify({ name: '白板参考顺序隔离验收' }) }).then((response) => response.json());
    if (!payload.ok || !payload.project?.workspacePath) throw new Error(payload.message || '隔离作品创建失败');
    return payload.project;
  })()`);
  assert.ok(created.workspacePath, "隔离作品必须返回真实工作区路径");
  const assetDirectory = join(created.workspacePath, "assets");
  await mkdir(assetDirectory, { recursive: true });
  await Promise.all(sourceIds.map((_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const hue = (index * 47) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100"><rect width="160" height="100" fill="hsl(${hue} 55% 42%)"/><text x="80" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="white">${number}</text></svg>`;
    return writeFile(join(assetDirectory, `reference-${number}.svg`), svg, "utf8");
  }));
  const documentId = "whiteboard-reference-order-ui";
  const fixtureState = createBlankProjectState({ name: created.name, workspacePath: created.workspacePath });
  const nodes = [
    {
      id: "reference-order-target", type: "text", kind: "text", name: "目标卡片", text: "",
      x: 260, y: 180, width: 260, height: 170, color: "default",
    },
    ...sourceIds.map((id, index) => ({
      id,
      type: "file",
      kind: "image",
      name: `参考图片 ${String(index + 1).padStart(2, "0")}`,
      text: "",
      file: `assets/reference-${String(index + 1).padStart(2, "0")}.svg`,
      mimeType: "image/svg+xml",
      x: 1400 + (index % 10) * 260,
      y: 1000 + Math.floor(index / 10) * 180,
      width: 220,
      height: 140,
      color: "default",
    })),
  ];
  const edges = sourceIds.map((fromNode, order) => ({
    id: `reference-order-edge-${order + 1}`, fromNode, toNode: "reference-order-target", order,
  }));
  fixtureState.documents[documentId] = {
    title: "白板参考顺序 UI 验收", moduleId: "manuscript", documentKind: "whiteboard", updatedAt: "现在",
    canvas: { nodes, edges, assets: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: { snapToGrid: true, gridSize: 20 } },
  };
  fixtureState.moduleItems.manuscript ||= [];
  fixtureState.moduleItems.manuscript.push([documentId, "白板参考顺序 UI 验收"]);
  fixtureState.activeModule = "manuscript";
  fixtureState.activeDocument = documentId;
  const seeded = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const workspacePath = ${JSON.stringify(created.workspacePath)};
    const state = ${JSON.stringify(fixtureState)};
    localStorage.removeItem('shensi-whiteboard-generation-drafts-v1');
    const saved = await fetch('/api/workspace/save', { method: 'POST', headers, body: JSON.stringify({ workspacePath, state }) }).then((response) => response.json());
    if (!saved.ok) throw new Error(saved.message || '白板参考顺序夹具保存失败');
    const activeWorkspace = { workspacePath, workspaceKind: 'project', projectName: '白板参考顺序隔离验收', activeModule: 'manuscript', activeDocument: ${JSON.stringify(documentId)}, activeConversationId: state.activeConversationId || '', resumeRevision: Date.now() };
    const resumed = await fetch('/api/recovery/session', { method: 'POST', headers, body: JSON.stringify({ activeWorkspace }) }).then((response) => response.json());
    if (!resumed.ok) throw new Error(resumed.message || '隔离作品恢复位置保存失败');
    localStorage.setItem('shensi-active-workspace-v1', JSON.stringify(resumed.activeWorkspace || activeWorkspace));
    return { workspacePath, documentId: ${JSON.stringify(documentId)}, activeWorkspace: resumed.activeWorkspace || activeWorkspace };
  })()`);
  assert.equal(seeded.documentId, "whiteboard-reference-order-ui");
  seeded.activeWorkspace.resumeRevision = Date.now() + 60_000;

  const initialTimeOrigin = await evaluate("performance.timeOrigin");
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem('shensi-active-workspace-v1', ${JSON.stringify(JSON.stringify(seeded.activeWorkspace))});`,
  });
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor(`performance.timeOrigin !== ${initialTimeOrigin} && document.documentElement.dataset.bootReady === 'true'`, "隔离作品新页面启动");
  try {
    await waitFor("document.querySelector('#whiteboardEditor')?.hidden === false && document.querySelector('[data-canvas-node=\"reference-order-target\"]')?.getBoundingClientRect().width > 2", "参考顺序白板恢复");
  } catch (error) {
    const recoveryDiagnostic = await evaluate(`(async () => ({
      localPointer: localStorage.getItem('shensi-active-workspace-v1'),
      remotePointer: await fetch('/api/recovery/session').then((response) => response.json()).catch((failure) => ({ error: String(failure) })),
      projectLabel: document.querySelector('#projectButton')?.textContent || '',
      whiteboardHidden: document.querySelector('#whiteboardEditor')?.hidden,
      visibleNodes: document.querySelectorAll('[data-canvas-node]').length,
      activeDocumentLabel: document.querySelector('.document-item.active')?.textContent || '',
    }))()`);
    throw new Error(`${error.message}：${JSON.stringify(recoveryDiagnostic)}`);
  }
  await openTextGeneration();

  const initialReferenceLayout = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    const list = form?.querySelector('.whiteboard-generation-reference-list');
    const references = [...(list?.querySelectorAll('[data-generation-reference-role="upstream"]') || [])];
    const prompt = form?.querySelector('.whiteboard-generation-prompt-field');
    if (!list || !prompt || references.length === 0) return null;
    const listRect = list.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    const referenceRects = references.map((node) => node.getBoundingClientRect());
    return {
      count: references.length,
      flexWrap: getComputedStyle(list).flexWrap,
      clientWidth: list.clientWidth,
      scrollWidth: list.scrollWidth,
      listHeight: listRect.height,
      maximumReferenceHeight: Math.max(...referenceRects.map((rect) => rect.height)),
      distinctTops: [...new Set(referenceRects.map((rect) => Math.round(rect.top)))],
      listBottom: listRect.bottom,
      promptTop: promptRect.top,
    };
  })()`);
  assert.ok(initialReferenceLayout, `${sourceIds.length} 项参考必须呈现可测量的参考列表`);
  assert.equal(initialReferenceLayout.count, sourceIds.length, `超多参考布局必须完整保留全部 ${sourceIds.length} 项`);
  assert.equal(initialReferenceLayout.flexWrap, "nowrap", "超多参考不得换成多行");
  assert.ok(initialReferenceLayout.scrollWidth > initialReferenceLayout.clientWidth, "超出操作栏宽度后必须形成横向滚动区域");
  assert.equal(initialReferenceLayout.distinctTops.length, 1, "全部参考缩略图必须处于同一横排");
  assert.ok(initialReferenceLayout.listHeight >= initialReferenceLayout.maximumReferenceHeight + 12, "参考列表必须为缩略图下方滚动条保留安全空间");
  assert.ok(initialReferenceLayout.listBottom <= initialReferenceLayout.promptTop, "参考横排及滚动条不得遮挡提示词编辑区");

  const editorSelector = "#whiteboardGenerateForm .whiteboard-generation-inline-mentions";
  await click(editorSelector);
  const menuInsertionPool = sourceIds.slice(0, -1);
  const insertionOrder = [menuInsertionPool[0], ...Array.from({ length: menuInsertionPool.length - 1 }, (_, index) => menuInsertionPool[((index + 1) * 17) % menuInsertionPool.length])];
  assert.equal(new Set(insertionOrder).size, menuInsertionPool.length, `前 ${menuInsertionPool.length} 个实机插入参考必须互不重复`);

  await cdp("Input.insertText", { text: `第01段-${"上下文".repeat(28)}\n@` });
  await waitFor("document.querySelector('.whiteboard-generation-mention-menu[data-generation-mention-owner=\"whiteboardGenerateForm\"]:not([hidden]) [data-mention-shortcut=\"1\"]')", "数字快捷键参考菜单");
  await key({ key: "1", code: "Digit1", windowsVirtualKeyCode: 49 });
  await key({ type: "keyUp", key: "1", code: "Digit1", windowsVirtualKeyCode: 49 });
  await waitFor("document.querySelectorAll('#whiteboardGenerateForm [data-rich-mention-node-id]').length === 1", "数字快捷键插入首个参考");

  for (let index = 1; index < insertionOrder.length; index += 1) {
    const nodeId = insertionOrder[index];
    await cdp("Input.insertText", { text: `第${String(index + 1).padStart(2, "0")}段-${"后段内容".repeat(24)}\n@` });
    const optionSelector = `.whiteboard-generation-mention-menu[data-generation-mention-owner="whiteboardGenerateForm"]:not([hidden]) [data-insert-whiteboard-generation-reference="${nodeId}"]`;
    await waitFor(`document.querySelector(${JSON.stringify(optionSelector)})`, `第 ${index + 1} 个参考菜单项`);
    await evaluate(`(() => {
      const option = document.querySelector(${JSON.stringify(optionSelector)});
      const menu = option?.closest('.whiteboard-generation-mention-menu');
      if (!option || !menu) return false;
      menu.scrollTop = Math.max(0, option.offsetTop - (menu.clientHeight - option.offsetHeight) / 2);
      return true;
    })()`);
    await delay(20);
    const optionPoint = await pointFor(optionSelector);
    const hitNodeId = await evaluate(`document.elementFromPoint(${optionPoint.x}, ${optionPoint.y})?.closest('[data-insert-whiteboard-generation-reference]')?.dataset.insertWhiteboardGenerationReference || ''`);
    assert.equal(hitNodeId, nodeId, `第 ${index + 1} 个参考在真实点击前必须位于菜单可见命中区`);
    await click(optionSelector);
    await waitFor(`document.querySelectorAll('#whiteboardGenerateForm [data-rich-mention-node-id]').length === ${index + 1}`, `第 ${index + 1} 个参考插入`);
  }

  const dragNodeId = sourceIds.at(-1);
  const sourceSelector = `#whiteboardGenerateDialog [data-generation-reference="${dragNodeId}"]`;
  const dropSelector = "#whiteboardGenerateForm [data-rich-mention-node-id]:nth-of-type(11) strong";
  await evaluate(`document.querySelector(${JSON.stringify(dropSelector)}).scrollIntoView({ block: 'center', inline: 'center' }); true`);
  await evaluate(`document.querySelector(${JSON.stringify(sourceSelector)}).scrollIntoView({ block: 'nearest', inline: 'center' }); true`);
  const dropPoint = await pointFor(dropSelector, { xRatio: 0.8, yRatio: 0.5 });
  const dragEvidence = await evaluate(`(() => {
    const source = document.querySelector(${JSON.stringify(sourceSelector)});
    const hit = document.elementFromPoint(${dropPoint.x}, ${dropPoint.y});
    if (!source || !hit) return null;
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    hit.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: ${dropPoint.x}, clientY: ${dropPoint.y} }));
    hit.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: ${dropPoint.x}, clientY: ${dropPoint.y} }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return { hitTag: hit.tagName, insideMention: Boolean(hit.closest('[data-rich-mention-node-id]')) };
  })()`);
  assert.deepEqual(dragEvidence, { hitTag: "STRONG", insideMention: true }, "拖放落点必须命中引用芯片内部标题子元素");
  await waitFor(`document.querySelectorAll('#whiteboardGenerateForm [data-rich-mention-node-id]').length === ${sourceIds.length}`, "拖拽到引用芯片子元素后插入参考");

  const expectedBeforeCopy = [...insertionOrder.slice(0, 11), dragNodeId, ...insertionOrder.slice(11)];
  const beforeCopy = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    return {
      trayOrder: [...form.querySelectorAll('[data-generation-reference-role="upstream"]')].map((node) => node.dataset.generationReference),
      chipIds: [...form.querySelectorAll('[data-rich-mention-node-id]')].map((node) => node.dataset.richMentionNodeId),
      chipLabels: [...form.querySelectorAll('[data-rich-mention-node-id] strong')].map((node) => node.textContent.trim()),
      sequence: String(form.elements.promptReferenceSequence.value || '').split(',').filter(Boolean),
      valueLength: form.elements.instruction.value.length,
      tokenLabels: [...form.elements.instruction.value.matchAll(/@「([^」]+)」/gu)].map((match) => match[1]),
    };
  })()`);
  assert.deepEqual(beforeCopy.trayOrder, sourceIds, "顶部参考必须保持原始入边顺序");
  assert.deepEqual(beforeCopy.chipIds, expectedBeforeCopy, "连续插入和芯片内部拖放必须保持所选节点身份");
  assert.deepEqual(beforeCopy.sequence, expectedBeforeCopy, "隐藏引用序列必须与可见芯片逐项一致");
  assert.ok(beforeCopy.valueLength > 3_000, `实机提示词必须跨越旧 3000 字符边界：${beforeCopy.valueLength}`);
  const expectedLabels = expectedBeforeCopy.map((id) => `图片${sourceIds.indexOf(id) + 1}`);
  assert.deepEqual(beforeCopy.chipLabels, expectedLabels, "可见芯片标题必须与顶部参考编号逐项匹配");
  assert.deepEqual(beforeCopy.tokenLabels, expectedLabels, "隐藏提示词中的引用文本必须与稳定节点身份一致");

  await click(editorSelector);
  await shortcut("a", "KeyA", 65);
  await shortcut("c", "KeyC", 67);
  await shortcut("End", "End", 35);
  await shortcut("v", "KeyV", 86);
  await waitFor(`document.querySelectorAll('#whiteboardGenerateForm [data-rich-mention-node-id]').length === ${sourceIds.length * 2}`, "Ctrl+C/Ctrl+V 保留全部重复引用");
  const expectedAfterCopy = [...expectedBeforeCopy, ...expectedBeforeCopy];
  const afterCopy = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    return {
      chipIds: [...form.querySelectorAll('[data-rich-mention-node-id]')].map((node) => node.dataset.richMentionNodeId),
      sequence: String(form.elements.promptReferenceSequence.value || '').split(',').filter(Boolean),
      value: form.elements.instruction.value,
    };
  })()`);
  assert.deepEqual(afterCopy.chipIds, expectedAfterCopy, "复制粘贴必须保留重复引用及原顺序");
  assert.deepEqual(afterCopy.sequence, expectedAfterCopy, "复制粘贴后的隐藏序列必须与可见芯片一致");

  await click("#whiteboardGenerateDialog [data-close-whiteboard-dialog]");
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.open !== true", "关闭操作栏并保存草稿");
  const recoveryTimeOrigin = await evaluate("performance.timeOrigin");
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor(`performance.timeOrigin !== ${recoveryTimeOrigin} && document.documentElement.dataset.bootReady === 'true'`, "重启新页面启动");
  await waitFor("document.querySelector('#whiteboardEditor')?.hidden === false && document.querySelector('[data-canvas-node=\"reference-order-target\"]')?.getBoundingClientRect().width > 2", "重启后白板恢复");
  await openTextGeneration();
  await waitFor(`document.querySelectorAll('#whiteboardGenerateForm [data-rich-mention-node-id]').length === ${sourceIds.length * 2}`, "重启后提示词参考恢复");
  const restored = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    return {
      trayOrder: [...form.querySelectorAll('[data-generation-reference-role="upstream"]')].map((node) => node.dataset.generationReference),
      chipIds: [...form.querySelectorAll('[data-rich-mention-node-id]')].map((node) => node.dataset.richMentionNodeId),
      sequence: String(form.elements.promptReferenceSequence.value || '').split(',').filter(Boolean),
      value: form.elements.instruction.value,
    };
  })()`);
  assert.deepEqual(restored.trayOrder, sourceIds, "重启后顶部参考顺序不得变化");
  assert.deepEqual(restored.chipIds, expectedAfterCopy, "重启后可见芯片身份不得错位");
  assert.deepEqual(restored.sequence, expectedAfterCopy, "重启后隐藏引用序列不得错位");
  assert.equal(restored.value, afterCopy.value, "重启后完整提示词不得丢失或重排");

  await evaluate("document.querySelector('#whiteboardGenerateDialog [data-whiteboard-generation-expand]').click(); true");
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.classList.contains('is-expanded')", "居中展开生成操作栏");
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const expandedReferenceLayout = await evaluate(`(() => {
    const dialog = document.querySelector('#whiteboardGenerateDialog');
    const header = dialog?.querySelector('.whiteboard-generation-popover-header');
    const list = dialog?.querySelector('.whiteboard-generation-reference-list');
    const clear = dialog?.querySelector('[data-clear-whiteboard-generation-references]');
    const firstReference = list?.querySelector('[data-generation-reference-role="upstream"]');
    const prompt = dialog?.querySelector('.whiteboard-generation-prompt-field');
    if (!dialog || !header || !list || !clear || !firstReference || !prompt) return null;
    const headerRect = header.getBoundingClientRect();
    const clearRect = clear.getBoundingClientRect();
    const firstReferenceRect = firstReference.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    const bottomOptionsRect = dialog.querySelector('.whiteboard-generation-bottom-options')?.getBoundingClientRect();
    const footerRect = dialog.querySelector('.whiteboard-generation-footer')?.getBoundingClientRect();
    return {
      dialogWidth: dialog.getBoundingClientRect().width,
      headerHeight: headerRect.height,
      clearBottom: clearRect.bottom,
      referenceTop: firstReferenceRect.top,
      listBottom: listRect.bottom,
      promptTop: promptRect.top,
      promptBottom: promptRect.bottom,
      bottomOptionsHeight: bottomOptionsRect?.height || 0,
      footerHeight: footerRect?.height || 0,
      bottomAreaHeight: dialog.getBoundingClientRect().bottom - promptRect.bottom,
      anchorHidden: getComputedStyle(header.querySelector('.whiteboard-generation-anchor-label')).display === 'none',
      copyHidden: getComputedStyle(header.querySelector('p')).display === 'none',
    };
  })()`);
  assert.ok(expandedReferenceLayout, "展开态参考布局必须可测量");
  assert.ok(expandedReferenceLayout.headerHeight <= 48, `展开态顶部工具栏应保持紧凑：${expandedReferenceLayout.headerHeight}px`);
  assert.ok(expandedReferenceLayout.clearBottom + 4 <= expandedReferenceLayout.referenceTop, "清空参考按钮与缩略图必须保留至少 4px 间隔");
  assert.ok(expandedReferenceLayout.listBottom <= expandedReferenceLayout.promptTop, "展开态参考横排不得遮挡提示词输入区");
  assert.ok(expandedReferenceLayout.bottomOptionsHeight <= 38, `展开态选项行不得超过 38px：${expandedReferenceLayout.bottomOptionsHeight}px`);
  assert.ok(expandedReferenceLayout.footerHeight <= 42, `展开态页脚不得超过 42px：${expandedReferenceLayout.footerHeight}px`);
  assert.ok(expandedReferenceLayout.bottomAreaHeight <= 86, `展开态底部总占位不得超过 86px：${expandedReferenceLayout.bottomAreaHeight}px`);
  assert.equal(expandedReferenceLayout.anchorHidden, true, "展开态不应占位显示目标卡片标签");
  assert.equal(expandedReferenceLayout.copyHidden, true, "展开态不应占位显示重复说明文案");
  const compactScreenshotPath = join(outputRoot, "whiteboard-generation-expanded-compact.png");
  const compactScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(compactScreenshotPath, Buffer.from(compactScreenshot.data, "base64"));

  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(evidencePath, Buffer.from(screenshot.data, "base64"));

  await click("#whiteboardGenerateForm [data-clear-whiteboard-generation-references]");
  await waitFor("document.querySelectorAll('#whiteboardGenerateForm [data-generation-reference-role=\"upstream\"]').length === 0", "清空顶部全部参考", 2_000);
  const clearedReferences = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    return {
      chipCount: form.querySelectorAll('[data-rich-mention-node-id]').length,
      explicitReferences: form.elements.explicitReferences.value,
      referenceOrder: form.elements.referenceOrder.value,
      promptReferenceSequence: form.elements.promptReferenceSequence.value,
      incomingEdges: document.querySelectorAll('[data-canvas-edge]').length,
      remainingReferenceTokens: [...form.elements.instruction.value.matchAll(/@「([^」]+)」/gu)].length,
    };
  })()`);
  assert.deepEqual(clearedReferences, {
    chipCount: 0,
    explicitReferences: "",
    referenceOrder: "",
    promptReferenceSequence: "",
    incomingEdges: 0,
    remainingReferenceTokens: 0,
  }, "清空参考必须同步清空顶部连线、输入框引用芯片和全部顺序字段");

  await click(editorSelector);
  await shortcut("a", "KeyA", 65);
  await cdp("Input.insertText", { text: "限".repeat(20_050) });
  await waitFor("document.querySelector('#whiteboardGenerateForm').elements.instruction.value.length === 20000", "20,000 字上限同步修正");
  const limitState = await evaluate(`(() => {
    const form = document.querySelector('#whiteboardGenerateForm');
    const editor = form.querySelector('.whiteboard-generation-inline-mentions');
    return {
      hiddenLength: form.elements.instruction.value.length,
      visibleLength: editor.textContent.replaceAll('\\u200B', '').length,
      toast: document.querySelector('.toast:not([hidden])')?.textContent || '',
    };
  })()`);
  assert.equal(limitState.hiddenLength, 20_000, "隐藏提交值必须限制为 20,000 字");
  assert.equal(limitState.visibleLength, 20_000, "可见编辑器必须与隐藏提交值保持相同上限");
  assert.match(limitState.toast, /20,000|20000/u, "超过上限时必须明确提示用户");

  const report = {
    referenceCount: sourceIds.length,
    promptLengthBeforeCopy: beforeCopy.valueLength,
    repeatedReferenceCount: restored.sequence.length,
    dragTarget: { nodeId: dragNodeId, insertedAt: 11 },
    restored: true,
    clearedReferences,
    initialReferenceLayout,
    expandedReferenceLayout,
    limitState,
    evidencePath,
    compactScreenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`白板 ${sourceIds.length} 项参考连续插入、芯片内部拖放、复制粘贴、重启恢复、批量清空与 20,000 字边界 UI 验收通过：${JSON.stringify(report)}`);
} finally {
  try { socket?.close(); } catch {}
  child.kill();
  await delay(300);
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
