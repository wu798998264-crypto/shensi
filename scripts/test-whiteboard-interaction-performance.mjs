import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-whiteboard-click-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const reportSuffix = String(process.env.SHENSI_PERFORMANCE_REPORT_SUFFIX || "").trim().replace(/[^a-z0-9_-]+/giu, "-");
const reportPath = join(root, "artifacts", `whiteboard-interaction-performance${reportSuffix ? `-${reportSuffix}` : ""}.json`);
const screenshotPrefix = String(process.env.SHENSI_PERFORMANCE_SCREENSHOT_PREFIX || "").trim().replace(/[^a-z0-9_-]+/giu, "-");
const electronExecutable = join(root, "node_modules", "electron", "dist", "electron.exe");
const ffmpegExecutable = process.platform === "win32"
  ? join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
  : "ffmpeg";
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const installedExecutable = String(process.env.SHENSI_TEST_INSTALLED_EXE || "").trim();
const debugPort = Math.max(1024, Number(process.env.SHENSI_PERFORMANCE_DEBUG_PORT) || 9359);
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });

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
  assert.ok(target, `性能验收窗口未启动：${stderr.slice(-1200)}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
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
      rejectCommand(new Error(`性能验收调试命令超时：${method}`));
    }, 15_000);
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
    const rect = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, width: r.width, height: r.height, hitTag: hit?.tagName || '', hitNodeId: hit?.closest?.('[data-canvas-node]')?.dataset.canvasNode || '', hitId: hit?.id || '' }; })()`);
    assert.ok(rect, `未找到点击目标：${selector}`);
    assert.ok(rect.width > 2 && rect.height > 2, `点击目标当前不可见：${selector} ${JSON.stringify(rect)}`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    return rect;
  };
  const clickAndMeasure = async ({ selector, completionExpression, label, timeout = 1000 }) => {
    await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error(${JSON.stringify(`未找到点击目标：${label}`)});
      window.__shensiControlProbePromise = new Promise((resolve) => {
        let startedAt = 0;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ...result, startedAt, endedAt: performance.now() });
        };
        const timer = setTimeout(() => finish({ completed: false, started: startedAt > 0, latencyMs: ${timeout} }), ${timeout});
        node.addEventListener('pointerdown', () => {
          startedAt = performance.now();
          const check = () => {
            if (Boolean(${completionExpression})) {
              // This callback runs immediately before Chromium's next paint.
              // Finishing here measures click-to-visible-frame without charging
              // deferred idle initialization that starts only after that frame.
              finish({ completed: true, started: true, latencyMs: performance.now() - startedAt });
              return;
            }
            if (!settled) requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }, { capture: true, once: true });
      });
      return true;
    })()`);
    const hit = await clickCenter(selector);
    const result = await evaluate("window.__shensiControlProbePromise");
    assert.equal(result.started, true, `${label} 未收到真实 pointerdown：${JSON.stringify({ hit, result })}`);
    assert.equal(result.completed, true, `${label} 点击后界面未响应：${JSON.stringify({ hit, result })}`);
    return { label, ...result, hit };
  };
  const contextClickCenter = async (selector) => {
    const rect = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(rect, `未找到右键目标：${selector}`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "right", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "right", clickCount: 1 });
    return rect;
  };
  const doubleClickCenter = async (selector) => {
    const rect = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(rect, `未找到双击目标：${selector}`);
    for (const clickCount of [1, 2]) {
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount });
    }
    return rect;
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.bringToFront");
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "神思启动");
  await evaluate(`localStorage.setItem('shensi:creative-start-welcome:v1', 'seen'); document.querySelector('#creativeStartWelcomeDialog')?.close(); true`);
  await evaluate(`document.querySelector('#projectButton').click(); true`);
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate(`document.querySelector('#newWorkspaceButton').click(); true`);
  await waitFor("document.querySelector('#textDialog')?.open === true", "新建作品弹窗");
  await evaluate(`(() => { const input = document.querySelector('#textDialogInput'); input.value = '点击性能隔离验收'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#textDialogForm').requestSubmit(); return true; })()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('点击性能隔离验收')", "隔离作品创建", 30_000);
  await waitFor("document.querySelector('.autosave-state')?.dataset.state === 'saved'", "隔离作品首次保存", 30_000);

  const seeded = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const resume = await fetch('/api/recovery/session', { headers }).then((response) => response.json());
    const localPointer = JSON.parse(localStorage.getItem('shensi-active-workspace-v1') || 'null');
    const workspacePath = resume.activeWorkspace?.workspacePath || localPointer?.workspacePath || '';
    if (!workspacePath) throw new Error('隔离作品路径读取失败');
    const loaded = await fetch('/api/workspace/load', { method: 'POST', headers, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
    if (!loaded.ok || !loaded.state) throw new Error(loaded.message || '隔离作品状态读取失败');
    const state = loaded.state;
    const documentId = 'whiteboard-click-performance';
    const plainDocumentId = 'plain-click-performance';
    const nodes = Array.from({ length: 240 }, (_, index) => ({
      id: 'perf-card-' + index,
      type: 'text',
      kind: index < 120 ? 'text' : 'generated',
      name: index === 0 ? '文字卡片' : ('性能卡片 ' + (index + 1)),
      text: index < 120 ? '' : ('长文本性能验收 ' + index + '。').repeat(32),
      x: 40 + (index % 20) * 260,
      y: 40 + Math.floor(index / 20) * 170,
      width: 220,
      height: 140,
      color: 'default',
    }));
    state.documents[documentId] = {
      title: '大型白板点击性能', moduleId: 'manuscript', documentKind: 'whiteboard', updatedAt: '现在',
      canvas: {
        nodes,
        edges: [{ id: 'relation-edge-1', fromNode: 'perf-card-130', toNode: 'perf-card-131', fromSide: 'right', toSide: 'left' }],
        assets: [],
        viewport: { x: 290, y: 130, zoom: 0.22 },
        settings: { snapToGrid: true, gridSize: 20 },
      },
    };
    state.documents[plainDocumentId] = {
      title: '普通文档点击性能', moduleId: 'manuscript', documentKind: 'document', updatedAt: '现在',
      html: '<p>隔离侧栏点击验收，不含用户数据。</p>',
    };
    state.moduleItems.manuscript ||= [];
    state.moduleItems.manuscript.push([plainDocumentId, '普通文档点击性能'], [documentId, '大型白板点击性能']);
    state.activeModule = 'manuscript';
    state.activeDocument = documentId;
    const saved = await fetch('/api/workspace/save', { method: 'POST', headers, body: JSON.stringify({ workspacePath, state, expectedStateStamp: loaded.stateStamp || '' }) }).then((response) => response.json());
    if (!saved.ok) throw new Error(saved.message || '大型白板保存失败');
    const entries = Object.fromEntries(Array.from({ length: 120 }, (_, index) => {
      const scope = { workspaceId: workspacePath, documentId, nodeId: 'perf-card-' + index, channel: index % 3 === 0 ? 'video' : index % 3 === 1 ? 'image' : 'text' };
      const key = [scope.workspaceId, scope.documentId, scope.nodeId, scope.channel].map(encodeURIComponent).join('::');
      return [key, { ...scope, values: { prompt: ('参考内容 ' + index + '。').repeat(180), instruction: ('写作要求 ' + index + '。').repeat(180) }, updatedAt: Date.now() - index }];
    }));
    localStorage.setItem('shensi-whiteboard-generation-drafts-v1', JSON.stringify({ version: 8, entries, openSessions: [], active: null }));
    const resumed = await fetch('/api/recovery/session', { method: 'POST', headers, body: JSON.stringify({ activeWorkspace: { workspacePath, workspaceKind: 'project', projectName: '点击性能隔离验收', activeModule: 'manuscript', activeDocument: documentId, activeConversationId: state.activeConversationId || '', resumeRevision: Date.now() } }) }).then((response) => response.json());
    if (!resumed.ok) throw new Error(resumed.message || '恢复位置保存失败');
    return { workspacePath, documentId };
  })()`);
  assert.equal(seeded.documentId, "whiteboard-click-performance");
  const performanceMediaDirectory = join(seeded.workspacePath, "附件");
  const performanceVideoPath = join(performanceMediaDirectory, "whiteboard-performance-video.mp4");
  const performancePosterPath = join(performanceMediaDirectory, "whiteboard-performance-video.jpg");
  await mkdir(performanceMediaDirectory, { recursive: true });
  const runFixtureCommand = (args) => new Promise((resolveFixture, rejectFixture) => {
    const fixture = spawn(String(process.env.SHENSI_TEST_FFMPEG || ffmpegExecutable), args, {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let fixtureError = "";
    fixture.stderr.on("data", (chunk) => { fixtureError += String(chunk); });
    fixture.once("error", rejectFixture);
    fixture.once("exit", (code) => code === 0
      ? resolveFixture()
      : rejectFixture(new Error(`视频性能素材创建失败（${code}）：${fixtureError.slice(-800)}`)));
  });
  await runFixtureCommand(["-y", "-f", "lavfi", "-i", "testsrc2=size=480x270:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", performanceVideoPath]);
  await runFixtureCommand(["-y", "-i", performanceVideoPath, "-frames:v", "1", "-vf", "scale=480:-2", performancePosterPath]);
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const stats = window.__shensiStartupResponsiveness = { maxTimerGapMs: 0, longTasks: [] };
    let previous = performance.now();
    setInterval(() => {
      const current = performance.now();
      stats.maxTimerGapMs = Math.max(stats.maxTimerGapMs, current - previous);
      previous = current;
    }, 8);
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) stats.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }).observe({ entryTypes: ['longtask'] });
    }
  })();` });
  if (process.env.SHENSI_PROFILE_STARTUP === "1") {
    await cdp("Profiler.enable");
    await cdp("Profiler.start");
  }
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor("document.querySelector('#creativeStartWelcomeDialog')?.open !== true", "首次介绍保持关闭");
  await waitFor("document.querySelector('#whiteboardEditor')?.hidden === false && document.querySelector('#whiteboardEditor')?.dataset.totalNodeCount === '240'", "大型白板呈现");
  await waitFor("Number(document.querySelector('#whiteboardEditor')?.dataset.renderedNodeCount) >= 220", "低缩放全量卡片呈现");
  await evaluate(`(() => {
    const startedAt = performance.now();
    window.__shensiCursorProbePromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ latencyMs: 1000, active: false }), 1000);
      const check = () => {
        const active = document.querySelector('#whiteboardEditor')?.classList.contains('space-pan') === true;
        if (active) {
          clearTimeout(timer);
          requestAnimationFrame(() => resolve({ latencyMs: performance.now() - startedAt, active: true }));
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  })()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  const cursorResponse = await evaluate("window.__shensiCursorProbePromise");
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await waitFor("document.querySelectorAll('#whiteboardSurface > [data-canvas-node]').length >= 220 && !document.querySelector('#whiteboardSurface')?.classList.contains('progressive-rendering')", "大型白板渐进渲染完成");
  const emptyPlainCard = await evaluate(`(() => {
    const card = document.querySelector('[data-canvas-node="perf-card-0"]');
    return { text: card?.innerText?.trim() || '', placeholder: card?.querySelector('textarea')?.placeholder || '' };
  })()`);
  assert.deepEqual(emptyPlainCard, { text: "", placeholder: "" }, "空白普通卡片必须保持纯白板表面，不得显示卡片类型或编辑提示");
  await clickCenter('[data-canvas-node="perf-card-130"]');
  await waitFor("document.querySelector('[data-foreground-canvas-edge=\"relation-edge-1\"]') && document.querySelector('[data-canvas-node=\"perf-card-131\"]')?.classList.contains('relation-active')", "活动上下游关系进入前景层");
  const relationLayering = await evaluate(`(() => {
    const z = (selector) => Number(getComputedStyle(document.querySelector(selector)).zIndex || 0);
    return {
      baseEdge: z('.whiteboard-edge-layer'),
      unrelatedCard: z('[data-canvas-node="perf-card-132"]'),
      foregroundEdge: z('.whiteboard-edge-foreground-layer'),
      endpointCard: z('[data-canvas-node="perf-card-131"]'),
      selectedCard: z('[data-canvas-node="perf-card-130"]'),
      foregroundEdges: document.querySelectorAll('[data-foreground-canvas-edge="relation-edge-1"]').length,
    };
  })()`);
  assert.deepEqual(relationLayering, {
    baseEdge: 0,
    unrelatedCard: 1,
    foregroundEdge: 4,
    endpointCard: 5,
    selectedCard: 6,
    foregroundEdges: 1,
  }, `活动关系图层顺序错误：${JSON.stringify(relationLayering)}`);
  const startupResponsiveness = await evaluate("window.__shensiStartupResponsiveness");
  const panPoint = await evaluate(`(() => { const rect = document.querySelector('#whiteboardEditor').getBoundingClientRect(); return { x: rect.left + rect.width * 0.72, y: rect.top + rect.height * 0.78 }; })()`);
  await evaluate(`(() => {
    const editor = document.querySelector('#whiteboardEditor');
    window.__shensiPanProbePromise = new Promise((resolve) => {
      let startedAt = 0;
      const timer = setTimeout(() => resolve({ latencyMs: 1000, active: false }), 1000);
      const observer = new MutationObserver(() => {
        if (!startedAt || !editor.classList.contains('panning')) return;
        clearTimeout(timer);
        observer.disconnect();
        requestAnimationFrame(() => resolve({ latencyMs: performance.now() - startedAt, active: true }));
      });
      observer.observe(editor, { attributes: true, attributeFilter: ['class'] });
      editor.addEventListener('pointerdown', () => { startedAt = performance.now(); }, { capture: true, once: true });
    });
  })()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: panPoint.x, y: panPoint.y, button: "left", clickCount: 1 });
  const panningResponse = await evaluate("window.__shensiPanProbePromise");
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: panPoint.x + 18, y: panPoint.y + 12, button: "left", buttons: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: panPoint.x + 18, y: panPoint.y + 12, button: "left", clickCount: 1 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  if (process.env.SHENSI_PROFILE_STARTUP === "1") {
    const { profile } = await cdp("Profiler.stop");
    const frames = new Map((profile.nodes || []).map((node) => [node.id, node.callFrame]));
    const totals = new Map();
    (profile.samples || []).forEach((nodeId, index) => totals.set(nodeId, (totals.get(nodeId) || 0) + Number(profile.timeDeltas?.[index] || 0)));
    const top = [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30).map(([nodeId, microseconds]) => ({
      functionName: frames.get(nodeId)?.functionName || "(anonymous)",
      url: frames.get(nodeId)?.url || "",
      lineNumber: Number(frames.get(nodeId)?.lineNumber || 0) + 1,
      milliseconds: microseconds / 1000,
    }));
    console.log(`startup CPU profile: ${JSON.stringify(top)}`);
  }
  await evaluate(`(() => {
    window.__shensiLongTasks = [];
    window.__shensiLongTaskObserver?.disconnect?.();
    if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return false;
    window.__shensiLongTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__shensiLongTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name || 'longtask' });
      }
    });
    window.__shensiLongTaskObserver.observe({ entryTypes: ['longtask'] });
    return true;
  })()`);

  const visibleNodeIds = await evaluate(`(() => {
    const editor = document.querySelector('#whiteboardEditor').getBoundingClientRect();
    return [...document.querySelectorAll('[data-canvas-node]')].filter((card) => {
      const numericId = Number(String(card.dataset.canvasNode || '').replace('perf-card-', ''));
      if (!Number.isFinite(numericId) || numericId < 120) return false;
      const rect = card.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return x > editor.left + 4 && x < editor.right - 4 && y > editor.top + 4 && y < editor.bottom - 4;
    }).map((card) => card.dataset.canvasNode);
  })()`);
  assert.ok(visibleNodeIds.length >= 2, `大型白板至少需要两张可见卡片：${JSON.stringify(visibleNodeIds)}`);
  const renderedNodeCount = await evaluate("Number(document.querySelector('#whiteboardEditor')?.dataset.renderedNodeCount || 0)");
  const lowDetailNodeCount = await evaluate("document.querySelectorAll('[data-canvas-node].low-detail').length");
  assert.ok(lowDetailNodeCount >= 200, `总览缩放应启用轻量卡片：${lowDetailNodeCount}`);
  if (screenshotPrefix) {
    const overviewScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(root, "artifacts", `${screenshotPrefix}-overview.png`), Buffer.from(overviewScreenshot.data, "base64"));
  }
  const clickLatencies = [];
  const clickAttempts = 40;
  for (let attempt = 0; attempt < clickAttempts; attempt += 1) {
    const nodeId = visibleNodeIds[attempt % visibleNodeIds.length];
    const selector = `[data-canvas-node="${nodeId}"]`;
    await evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(selector)});
      window.__shensiSelectionProbePromise = new Promise((resolve) => {
        let pointerAt = 0;
        let mouseAt = 0;
        let clickAt = 0;
        const timeout = setTimeout(() => {
          observer.disconnect();
          resolve({ latencyMs: 1000, selected: false, pointerAt, mouseAt, clickAt, selectedIds: [...document.querySelectorAll('[data-canvas-node].selected')].map((item) => item.dataset.canvasNode) });
        }, 1000);
        const observer = new MutationObserver(() => {
          if (!pointerAt || !card.classList.contains('selected')) return;
          clearTimeout(timeout);
          observer.disconnect();
          requestAnimationFrame(() => resolve({ latencyMs: performance.now() - pointerAt, selected: true }));
        });
        observer.observe(card, { attributes: true, attributeFilter: ['class'] });
        card.addEventListener('pointerdown', () => { pointerAt = performance.now(); }, { capture: true, once: true });
        card.addEventListener('mousedown', () => { mouseAt = performance.now(); }, { capture: true, once: true });
        card.addEventListener('click', () => { clickAt = performance.now(); }, { capture: true, once: true });
      });
      return true;
    })()`);
    const hit = await clickCenter(selector);
    const result = await evaluate("window.__shensiSelectionProbePromise");
    clickLatencies.push({ ...result, hit, nodeId });
    if (!result.selected) console.log(`whiteboard click miss ${attempt + 1}/${clickAttempts}: ${JSON.stringify({ hit, result, nodeId })}`);
  }

  // Lightweight overview cards must materialize the full textarea on a real
  // double click, then return to lightweight rendering after Escape.
  const editNodeId = visibleNodeIds[0];
  const editMarker = "性能实时保存验证";
  await doubleClickCenter(`[data-canvas-node="${editNodeId}"]`);
  await waitFor(`document.querySelector('[data-canvas-node="${editNodeId}"].editing [data-canvas-text]')`, "总览卡片进入完整编辑态");
  if (screenshotPrefix) {
    const editingScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(root, "artifacts", `${screenshotPrefix}-editing.png`), Buffer.from(editingScreenshot.data, "base64"));
  }
  await cdp("Input.insertText", { text: editMarker });
  await waitFor(`document.querySelector('[data-canvas-node="${editNodeId}"] [data-canvas-text]')?.value.includes(${JSON.stringify(editMarker)})`, "总览卡片实时接收编辑内容");
  await clickCenter(`[data-canvas-node="${visibleNodeIds[1]}"]`);
  await waitFor(`document.querySelector('[data-canvas-node="${editNodeId}"].low-detail')`, "编辑结束后恢复轻量卡片");
  await waitFor("document.querySelector('.autosave-state')?.dataset.state === 'saved'", "白板卡片编辑落盘", 30_000);

  // Exercise the mutually-exclusive panels in both open/close and cross-panel
  // directions. A stale overlay here is perceived as the next click doing nothing.
  const controlLatencies = [];
  controlLatencies.push(await clickAndMeasure({
    selector: "#projectButton",
    completionExpression: "document.querySelector('#projectMenu')?.hidden === false",
    label: "作品菜单打开",
  }));
  controlLatencies.push(await clickAndMeasure({
    selector: "#projectButton",
    completionExpression: "document.querySelector('#projectMenu')?.hidden === true",
    label: "作品菜单关闭",
  }));
  // Open the real card context menu and generation operation bar using native
  // CDP mouse events. This catches hit-testing regressions outside selection.
  const generationNodeId = visibleNodeIds[0];
  await contextClickCenter(`[data-canvas-node="${generationNodeId}"]`);
  await waitFor("document.querySelector('#whiteboardMenu')?.hidden === false", "卡片生成菜单打开");
  const directGenerationVisible = await evaluate("document.querySelector('[data-whiteboard-direct-generation]')?.hidden === false");
  let textGenerationSelector = "[data-whiteboard-direct-generation]";
  if (!directGenerationVisible) {
    controlLatencies.push(await clickAndMeasure({
      selector: "[data-whiteboard-action=\"toggle-generate\"]",
      completionExpression: "document.querySelector('#whiteboardGenerateMenu')?.hidden === false",
      label: "卡片生成子菜单打开",
    }));
    textGenerationSelector = "#whiteboardGenerateMenu [data-whiteboard-action=\"generate-text\"]";
  }
  const generationOpen = await clickAndMeasure({
    selector: textGenerationSelector,
    completionExpression: "document.querySelector('#whiteboardGenerateDialog')?.open === true",
    label: "文本生成操作栏打开",
  });
  controlLatencies.push(generationOpen);
  const generationReadyStart = await evaluate("performance.now()");
  await waitFor("document.querySelector('#whiteboardGenerateDialog')?.getAttribute('aria-busy') !== 'true'", "文本生成操作栏可交互");
  const generationReadyMs = generationOpen.latencyMs + (await evaluate("performance.now()") - generationReadyStart);
  const promptSelector = "#whiteboardGenerateDialog .whiteboard-generation-inline-mentions";
  await clickCenter(promptSelector);
  await cdp("Input.insertText", { text: "真实键盘输入提示词" });
  await waitFor("document.querySelector('#whiteboardGenerateForm').elements.instruction.value.includes('真实键盘输入提示词')", "卡片生成提示词真实输入");
  const promptInputState = await evaluate(`(() => {
    const dialog = document.querySelector('#whiteboardGenerateDialog');
    const editor = dialog?.querySelector('.whiteboard-generation-inline-mentions');
    return { focused: document.activeElement === editor, inert: dialog?.inert === true, busy: dialog?.getAttribute('aria-busy'), text: editor?.innerText || '' };
  })()`);
  assert.equal(promptInputState.focused, true, "生成操作栏提示词区域必须可获得真实键盘焦点");
  assert.equal(promptInputState.inert, false, "生成操作栏初始化后不得残留 inert 阻止输入");
  assert.notEqual(promptInputState.busy, "true", "生成操作栏初始化后不得残留忙碌门禁");
  assert.match(promptInputState.text, /真实键盘输入提示词/u);
  await evaluate(`document.querySelector('#whiteboardTextRuntimeButton')?.click(); true`);
  await waitFor("document.querySelector('#whiteboardTextRuntimePanel')?.hidden === false", "卡片文本模型设置展开");
  const modelVerificationEvidence = await evaluate(`(() => ({
    buttonVisible: document.querySelector('#checkWhiteboardTextModel')?.offsetParent !== null,
    buttonLabel: document.querySelector('#checkWhiteboardTextModel')?.textContent.trim() || '',
    status: document.querySelector('#whiteboardTextModelVerificationStatus')?.textContent.trim() || '',
    modelStates: [...document.querySelectorAll('#whiteboardTextModel option')].map((option) => option.dataset.modelState || ''),
  }))()`);
  const modelVerificationColors = await evaluate(`(() => {
    const container = document.querySelector('#whiteboardTextModelVerification');
    const status = document.querySelector('#whiteboardTextModelVerificationStatus');
    const originalState = container?.dataset.state || 'unknown';
    const colors = {};
    for (const stateName of ['unknown', 'catalog', 'checking', 'available', 'limited', 'unavailable']) {
      container.dataset.state = stateName;
      colors[stateName] = getComputedStyle(status).color;
    }
    container.dataset.state = originalState;
    return colors;
  })()`);
  assert.equal(modelVerificationEvidence.buttonVisible, false, "普通非免费卡片文字配置不得残留手动模型检查按钮");
  assert.equal(modelVerificationEvidence.buttonLabel, "检查当前模型");
  assert.ok(modelVerificationEvidence.status, "卡片文本生成设置必须显示当前模型状态");
  assert.ok(modelVerificationEvidence.modelStates.length > 0 && modelVerificationEvidence.modelStates.every(Boolean), "卡片模型列表必须为每个模型标记状态");
  assert.equal(new Set(Object.values(modelVerificationColors)).size, 5, `模型状态必须以五组可辨颜色显示：${JSON.stringify(modelVerificationColors)}`);
  if (screenshotPrefix) {
    const verificationScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(root, "artifacts", `${screenshotPrefix}-text-model-verification.png`), Buffer.from(verificationScreenshot.data, "base64"));
  }
  controlLatencies.push(await clickAndMeasure({
    selector: "#whiteboardGenerateDialog [data-close-whiteboard-dialog]",
    completionExpression: "document.querySelector('#whiteboardGenerateDialog')?.open !== true",
    label: "文本生成操作栏关闭",
  }));

  // Settings is outside the canvas event pipeline and catches whole-app click regressions.
  if (process.env.SHENSI_PROFILE_SETTINGS === "1") {
    await cdp("Profiler.enable");
    await cdp("Profiler.start");
  }
  const settingsOpen = await clickAndMeasure({
    selector: "#settingsButton",
    completionExpression: "document.querySelector('#settingsDialog')?.open === true",
    label: "设置弹窗打开",
  });
  controlLatencies.push(settingsOpen);
  const settingsReadyStart = await evaluate("performance.now()");
  await waitFor("document.querySelector('#settingsDialog')?.getAttribute('aria-busy') !== 'true'", "设置内容可交互");
  const settingsReadyMs = settingsOpen.latencyMs + (await evaluate("performance.now()") - settingsReadyStart);
  if (process.env.SHENSI_PROFILE_SETTINGS === "1") {
    const { profile } = await cdp("Profiler.stop");
    const nodes = new Map((profile.nodes || []).map((node) => [node.id, node.callFrame]));
    const totals = new Map();
    (profile.samples || []).forEach((nodeId, index) => {
      totals.set(nodeId, (totals.get(nodeId) || 0) + Number(profile.timeDeltas?.[index] || 0));
    });
    const top = [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 25).map(([nodeId, microseconds]) => ({
      functionName: nodes.get(nodeId)?.functionName || "(anonymous)",
      url: nodes.get(nodeId)?.url || "",
      lineNumber: Number(nodes.get(nodeId)?.lineNumber || 0) + 1,
      milliseconds: microseconds / 1000,
    }));
    console.log(`settings CPU profile: ${JSON.stringify(top)}`);
  }
  for (const section of ["model", "skill", "about", "account"]) {
    controlLatencies.push(await clickAndMeasure({
      selector: `[data-settings-section="${section}"]`,
      completionExpression: `document.querySelector('[data-settings-page="${section}"]')?.hidden === false`,
      label: `设置分页 ${section}`,
    }));
  }
  controlLatencies.push(await clickAndMeasure({
    selector: "#closeSettings",
    completionExpression: "document.querySelector('#settingsDialog')?.open !== true",
    label: "设置弹窗关闭",
  }));

  // Conversation controls are intentionally hidden in whiteboard mode. Move
  // to an isolated ordinary document, then verify cross-panel switching with
  // real clicks and make sure the previous surface no longer intercepts input.
  const ordinaryDocumentId = await evaluate(`(() => [...document.querySelectorAll('[data-document]')]
    .find((item) => item.dataset.document !== 'whiteboard-click-performance' && item.getBoundingClientRect().width > 2)?.dataset.document || '')()`);
  assert.ok(ordinaryDocumentId, "隔离作品中未找到普通文档用于侧栏点击验收");
  if (process.env.SHENSI_PROFILE_CLICKS === "1") {
    await cdp("Profiler.enable");
    await cdp("Profiler.start");
  }
  const documentSwitchControl = await clickAndMeasure({
    selector: `[data-document="${ordinaryDocumentId}"]`,
    completionExpression: `document.querySelector('#editor')?.hidden === false && (document.querySelector('#whiteboardEditor')?.hidden === true || document.querySelector('#whiteboardEditor')?.classList.contains('surface-suspended')) && document.querySelector('[data-document="${ordinaryDocumentId}"]')?.classList.contains('active') === true`,
    label: "切换普通文档",
  });
  controlLatencies.push(documentSwitchControl);
  if (process.env.SHENSI_PROFILE_CLICKS === "1") {
    const { profile } = await cdp("Profiler.stop");
    const nodes = new Map((profile.nodes || []).map((node) => [node.id, node.callFrame]));
    const totals = new Map();
    (profile.samples || []).forEach((nodeId, index) => {
      totals.set(nodeId, (totals.get(nodeId) || 0) + Number(profile.timeDeltas?.[index] || 0));
    });
    const top = [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20).map(([nodeId, microseconds]) => ({
      functionName: nodes.get(nodeId)?.functionName || "(anonymous)",
      url: nodes.get(nodeId)?.url || "",
      lineNumber: Number(nodes.get(nodeId)?.lineNumber || 0) + 1,
      milliseconds: microseconds / 1000,
    }));
    console.log(`document switch CPU profile: ${JSON.stringify(top)}`);
  }
  const chatPanelCollapsed = await evaluate("document.querySelector('.workspace')?.classList.contains('chat-panel-collapsed') === true");
  if (chatPanelCollapsed) {
    await clickCenter("#chatPanelToggle");
    await waitFor("document.querySelector('#referenceButton')?.getBoundingClientRect().width > 2", "右侧对话栏展开");
  }
  controlLatencies.push(await clickAndMeasure({
    selector: "#referenceButton",
    completionExpression: "document.querySelector('#referencePanel')?.hidden === false",
    label: "引用面板打开",
  }));
  controlLatencies.push(await clickAndMeasure({
    selector: "#conversationSwitcherButton",
    completionExpression: "document.querySelector('#taskPanel')?.hidden === false && document.querySelector('#referencePanel')?.hidden === true",
    label: "引用切换到对话面板",
  }));
  controlLatencies.push(await clickAndMeasure({
    selector: "#referenceButton",
    completionExpression: "document.querySelector('#referencePanel')?.hidden === false && document.querySelector('#taskPanel')?.hidden === true",
    label: "对话切换到引用面板",
  }));
  controlLatencies.push(await clickAndMeasure({
    selector: "#referenceButton",
    completionExpression: "document.querySelector('#referencePanel')?.hidden === true",
    label: "引用面板关闭",
  }));

  const persistedEdit = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const loaded = await fetch('/api/workspace/load', { method: 'POST', headers, body: JSON.stringify({ workspacePath: ${JSON.stringify(seeded.workspacePath)} }) }).then((response) => response.json());
    const node = loaded.state?.documents?.[${JSON.stringify(seeded.documentId)}]?.canvas?.nodes?.find((item) => item.id === ${JSON.stringify(editNodeId)});
    return { ok: loaded.ok === true, text: String(node?.text || '') };
  })()`);
  assert.equal(persistedEdit.ok, true, "隔离白板编辑后的工作区必须可回读");
  assert.ok(persistedEdit.text.includes(editMarker), "总览卡片编辑内容必须真实落盘");

  const mediaDocumentId = "whiteboard-real-video-performance";
  await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const workspacePath = ${JSON.stringify(seeded.workspacePath)};
    const loaded = await fetch('/api/workspace/load', { method: 'POST', headers, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
    if (!loaded.ok || !loaded.state) throw new Error(loaded.message || '媒体性能工作区读取失败');
    const state = loaded.state;
    const nodes = Array.from({ length: 36 }, (_, index) => ({
      id: 'video-perf-card-' + index,
      type: 'file',
      kind: 'video',
      name: '真实视频 ' + (index + 1),
      text: '',
      file: '附件/whiteboard-performance-video.mp4',
      mimeType: 'video/mp4',
      thumbnailRelativePath: '附件/whiteboard-performance-video.jpg',
      thumbnailMimeType: 'image/jpeg',
      x: 40 + (index % 6) * 420,
      y: 40 + Math.floor(index / 6) * 280,
      width: 320,
      height: 180,
      aspectRatio: 16 / 9,
      color: 'default',
    }));
    state.documents[${JSON.stringify(mediaDocumentId)}] = {
      title: '真实视频白板性能', moduleId: 'manuscript', documentKind: 'whiteboard', updatedAt: '现在',
      canvas: { nodes, edges: [], assets: [], viewport: { x: 20, y: 20, zoom: 1 }, settings: { snapToGrid: true, gridSize: 20 } },
    };
    state.moduleItems.manuscript ||= [];
    if (!state.moduleItems.manuscript.some((item) => item?.[0] === ${JSON.stringify(mediaDocumentId)})) state.moduleItems.manuscript.push([${JSON.stringify(mediaDocumentId)}, '真实视频白板性能']);
    state.activeModule = 'manuscript';
    state.activeDocument = ${JSON.stringify(mediaDocumentId)};
    const saved = await fetch('/api/workspace/save', { method: 'POST', headers, body: JSON.stringify({ workspacePath, state, expectedStateStamp: loaded.stateStamp || '' }) }).then((response) => response.json());
    if (!saved.ok) throw new Error(saved.message || '真实视频白板保存失败');
    const resumed = await fetch('/api/recovery/session', { method: 'POST', headers, body: JSON.stringify({ activeWorkspace: { workspacePath, workspaceKind: 'project', projectName: '点击性能隔离验收', activeModule: 'manuscript', activeDocument: ${JSON.stringify(mediaDocumentId)}, activeConversationId: state.activeConversationId || '', resumeRevision: Date.now() } }) }).then((response) => response.json());
    if (!resumed.ok) throw new Error(resumed.message || '真实视频白板恢复位置保存失败');
    return true;
  })()`);
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor(`document.querySelector('#whiteboardEditor')?.dataset.totalNodeCount === '36' && document.querySelector('#whiteboardEditor')?.dataset.virtualized === 'true'`, "真实视频白板媒体专项虚拟化");
  await waitFor("document.querySelectorAll('[data-canvas-node]').length > 0", "真实视频白板首屏卡片");
  const mediaInitial = await evaluate(`(() => ({
    totalNodes: Number(document.querySelector('#whiteboardEditor')?.dataset.totalNodeCount || 0),
    renderedNodes: Number(document.querySelector('#whiteboardEditor')?.dataset.renderedNodeCount || 0),
    videoElements: document.querySelectorAll('#whiteboardSurface .whiteboard-card-video').length,
    staticPosters: document.querySelectorAll('#whiteboardSurface .whiteboard-card-video-poster').length,
    longTasks: window.__shensiStartupResponsiveness?.longTasks || [],
  }))()`);
  assert.equal(mediaInitial.totalNodes, 36, `真实视频白板节点数量异常：${JSON.stringify(mediaInitial)}`);
  assert.ok(mediaInitial.renderedNodes < mediaInitial.totalNodes, `视频较多但不足 80 节点时也应裁剪屏外卡片：${JSON.stringify(mediaInitial)}`);
  assert.equal(mediaInitial.videoElements, 0, `休眠视频不得创建播放器：${JSON.stringify(mediaInitial)}`);
  assert.ok(mediaInitial.staticPosters >= 1, `可见视频必须显示静态封面：${JSON.stringify(mediaInitial)}`);

  const videoActivateStartedAt = await evaluate("performance.now()");
  await clickCenter("[data-whiteboard-video-activate]");
  await waitFor("document.querySelectorAll('#whiteboardSurface .whiteboard-card-video').length === 1", "点击后按需挂载单个视频");
  const videoActivationMs = await evaluate(`performance.now() - ${Number(videoActivateStartedAt)}`);
  const blankPoint = await evaluate(`(() => {
    const editor = document.querySelector('#whiteboardEditor').getBoundingClientRect();
    const candidates = [
      { x: editor.right - 26, y: editor.bottom - 90 },
      { x: editor.right - 26, y: editor.top + 90 },
      { x: editor.left + editor.width * 0.72, y: editor.bottom - 90 },
    ];
    const point = candidates.find((candidate) => !document.elementFromPoint(candidate.x, candidate.y)?.closest?.('[data-canvas-node], button, dialog')) || candidates[0];
    const hit = document.elementFromPoint(point.x, point.y);
    return { ...point, hitTag: hit?.tagName || '', hitId: hit?.id || '', hitClass: String(hit?.className || '') };
  })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: blankPoint.x, y: blankPoint.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: blankPoint.x, y: blankPoint.y, button: "left", clickCount: 1 });
  try {
    await waitFor("document.querySelectorAll('#whiteboardSurface .whiteboard-card-video').length === 0", "点击卡片外后释放视频播放器", 5_000);
  } catch (error) {
    const outsideReleaseDiagnostic = await evaluate(`(() => ({
      blankPoint: ${JSON.stringify(blankPoint)},
      videos: [...document.querySelectorAll('#whiteboardSurface .whiteboard-card-video')].map((video) => ({
        paused: video.paused,
        ended: video.ended,
        readyState: video.readyState,
        cardId: video.closest('[data-canvas-node]')?.dataset.canvasNode || '',
      })),
    }))()`);
    throw new Error(`${error.message}：${JSON.stringify(outsideReleaseDiagnostic)}`);
  }
  const mediaPersisted = await evaluate(`(async () => {
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const loaded = await fetch('/api/workspace/load', { method: 'POST', headers, body: JSON.stringify({ workspacePath: ${JSON.stringify(seeded.workspacePath)} }) }).then((response) => response.json());
    const nodes = loaded.state?.documents?.[${JSON.stringify(mediaDocumentId)}]?.canvas?.nodes || [];
    return { ok: loaded.ok === true, nodes: nodes.length, files: [...new Set(nodes.map((node) => node.file))], names: nodes.map((node) => node.name) };
  })()`);
  assert.deepEqual(mediaPersisted.files, ["附件/whiteboard-performance-video.mp4"], "媒体虚拟化不得改变视频来源路径");
  assert.equal(mediaPersisted.nodes, 36, "媒体虚拟化不得增删卡片数据");
  const mediaVirtualization = { ...mediaInitial, videoActivationMs, persisted: mediaPersisted };

  await delay(100);
  const longTasks = await evaluate("window.__shensiLongTasks || []");
  const controlLongTaskOverlaps = controlLatencies.flatMap((control) => longTasks
    .filter((task) => Number.isFinite(control.startedAt) && Number.isFinite(control.endedAt)
      && task.startTime < control.endedAt
      && task.startTime + task.duration > control.startedAt)
    .map((task) => ({ label: control.label, latencyMs: control.latencyMs, ...task })));

  const values = clickLatencies.map((item) => item.latencyMs).sort((left, right) => left - right);
  const percentile = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
  const ordinaryControlLatencies = controlLatencies.filter((item) => !["文本生成操作栏打开", "文本生成操作栏关闭", "设置弹窗打开", "设置弹窗关闭", "切换普通文档"].includes(item.label));
  const sortedOrdinaryControlLatencies = [...ordinaryControlLatencies].sort((left, right) => left.latencyMs - right.latencyMs);
  const report = {
    nodeCount: 240,
    renderedNodeCount,
    lowDetailNodeCount,
    visibleNodeCount: visibleNodeIds.length,
    cursorResponse,
    panningResponse,
    startupResponsiveness,
    attempts: clickLatencies.length,
    ineffectiveClicks: clickLatencies.filter((item) => !item.selected).length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maximumMs: values.at(-1),
    settingsLatencyMs: settingsOpen.latencyMs,
    settingsReadyMs,
    generationReadyMs,
    controlLatencies,
    controlP95Ms: [...controlLatencies].sort((left, right) => left.latencyMs - right.latencyMs)[Math.min(controlLatencies.length - 1, Math.floor(controlLatencies.length * 0.95))].latencyMs,
    controlMaximumMs: Math.max(...controlLatencies.map((item) => item.latencyMs)),
    ordinaryControlP95Ms: sortedOrdinaryControlLatencies[Math.min(sortedOrdinaryControlLatencies.length - 1, Math.floor(sortedOrdinaryControlLatencies.length * 0.95))].latencyMs,
    longTasks,
    controlLongTaskOverlaps,
    clickMisses: clickLatencies.filter((item) => !item.selected),
    mediaVirtualization,
  };
  assert.equal(report.ineffectiveClicks, 0, `存在无效点击：${JSON.stringify(report)}`);
  assert.equal(report.cursorResponse.active, true, `大型白板加载期间空格拖拽光标必须生效：${JSON.stringify(report)}`);
  assert.ok(report.cursorResponse.latencyMs < 80, `大型白板加载期间光标切换必须低于 80ms：${JSON.stringify(report)}`);
  assert.equal(report.panningResponse.active, true, `大型白板拖拽手掌状态必须生效：${JSON.stringify(report)}`);
  assert.ok(report.panningResponse.latencyMs < 80, `大型白板拖拽手掌切换必须低于 80ms：${JSON.stringify(report)}`);
  assert.ok(report.startupResponsiveness.maxTimerGapMs < 500, `大型白板启动期间不能阻塞主线程 500ms：${JSON.stringify(report)}`);
  assert.ok(report.p95Ms < 100, `大型白板点击 P95 必须低于 100ms：${JSON.stringify(report)}`);
  assert.ok(report.maximumMs < 180, `大型白板点击最大延迟必须低于 180ms：${JSON.stringify(report)}`);
  assert.ok(report.settingsLatencyMs < 140, `大型白板上打开原生模态设置必须低于 140ms：${JSON.stringify(report)}`);
  assert.ok(report.settingsReadyMs < 600, `设置内容必须在 600ms 内可交互：${JSON.stringify(report)}`);
  assert.ok(report.generationReadyMs < 600, `文本生成操作栏必须在 600ms 内可交互：${JSON.stringify(report)}`);
  assert.ok(generationOpen.latencyMs < 100, `文本生成操作栏必须在 100ms 内可见：${JSON.stringify(report)}`);
  assert.ok((controlLatencies.find((item) => item.label === "文本生成操作栏关闭")?.latencyMs ?? 1000) < 100, `文本生成操作栏必须在 100ms 内关闭：${JSON.stringify(report)}`);
  assert.ok(report.ordinaryControlP95Ms < 90, `普通常用控件点击 P95 必须低于 90ms：${JSON.stringify(report)}`);
  assert.ok(report.controlMaximumMs < 150, `包含原生模态与文档切换的最大延迟必须低于 150ms：${JSON.stringify(report)}`);
  assert.ok(report.mediaVirtualization.videoActivationMs < 180, `休眠视频首次播放挂载必须低于 180ms：${JSON.stringify(report.mediaVirtualization)}`);
  await evaluate(`document.querySelector('#settingsButton').click(); true`);
  await waitFor("document.querySelector('#settingsDialog')?.open === true", "重新打开语言设置");
  await evaluate(`(() => {
    const language = document.querySelector('#settingsForm [name="uiLanguage"]');
    language.value = 'en-US';
    language.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.documentElement.lang === 'en' && document.querySelector('#root')?.dataset.uiLocalizationLanguage === 'en-US'", "切换英文界面");
  await evaluate(`(() => {
    const language = document.querySelector('#settingsForm [name="uiLanguage"]');
    language.value = 'zh-CN';
    language.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('#root')?.dataset.uiLocalizationLanguage === 'zh-CN'", "恢复中文界面");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, reportPath, report }));
} finally {
  try { socket?.close(); } catch {}
  child.kill();
  await delay(400);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
