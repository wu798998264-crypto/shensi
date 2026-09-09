import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-skill-relation-ui-"));
const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const reserveDebugPort = () => new Promise((resolvePromise, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolvePromise(address.port));
  });
});

let child = null;
let socket = null;
let debugPort = 0;
let childOutput = "";
let cdp = null;
let evaluate = null;
let waitFor = null;

const startDesktop = async () => {
  debugPort = await reserveDebugPort();
  childOutput = "";
  child = spawn(join(root, "node_modules", "electron", "dist", "electron.exe"), [
    `--remote-debugging-port=${debugPort}`,
    "--disable-gpu",
    join(root, "packaging", "windows", "desktop-app"),
  ], {
    cwd: root,
    env: {
      ...process.env,
      SHENSI_DATA_ROOT: join(runtimeRoot, "data"),
      SHENSI_MACHINE_DATA_ROOT: join(runtimeRoot, "data"),
      SHENSI_DESKTOP_USER_DATA_ROOT: join(runtimeRoot, "electron-user"),
      SHENSI_SKIP_UPDATE_CHECK: "1",
      SHENSI_TEST_DESKTOP_RUNTIME: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_000); });
  child.stderr?.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_000); });
  let target;
  for (let deadline = Date.now() + 60_000; Date.now() < deadline && !target;) {
    if (child.exitCode !== null) break;
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
    } catch {}
    if (!target) await delay(150);
  }
  if (!target) throw new Error(`Skill 面板关系布局验收页面未启动（退出码：${child.exitCode ?? "未退出"}；调试端口：${debugPort}；输出：${childOutput || "无"}）`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolvePromise, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "界面脚本执行失败");
    }
    return result.result?.value;
  };
  waitFor = async (expression, label) => {
    for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw new Error(`等待超时：${label}`);
  };
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "应用启动");
};

const stopDesktop = async () => {
  socket?.close();
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, delay(3_000)]);
  await delay(350);
};

const openSkillPanel = async () => {
  await evaluate(`document.querySelector('#settingsButton').click(); true`);
  await waitFor("document.querySelector('#settingsDialog')?.open", "设置窗口");
  await evaluate(`document.querySelector('[data-settings-section="skill"]').click(); true`);
  await waitFor("document.querySelector('.capability-template-manager')", "Skill 面板");
  // Settings performs a deliberately deferred catalog refresh. Let that
  // refresh settle before mutating the capability draft in this isolated UI
  // test, otherwise a late catalog response can repaint a clean draft.
  await delay(3_000);
};

const openNode = async (nodeType, nodeId) => {
  const selector = `[data-open-capability-node="${nodeType}"][data-capability-node-id="${nodeId}"]`;
  await waitFor(`document.querySelector(${JSON.stringify(selector)})`, `${nodeId} 入口`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  await waitFor(`document.querySelector('[data-capability-node-context-id="${nodeId}"]')`, nodeId);
};

const dragMember = async (sourceId, targetId, ratio = 0.5) => evaluate(`(() => {
  const source = document.querySelector('[data-capability-member-id="${sourceId}"]');
  const target = document.querySelector('[data-capability-member-id="${targetId}"]');
  const transfer = new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  const rect = target.getBoundingClientRect();
  const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + rect.width * ${ratio} });
  target.dispatchEvent(event);
  const indicator = {
    accepted: event.defaultPrevented,
    leadHighlighted: Boolean(document.querySelector('.capability-role-zone.is-drop-swap')),
    label: document.querySelector('.capability-role-zone.is-drop-swap')?.dataset.dropLabel || '',
    before: target.classList.contains('is-drop-before'),
    after: target.classList.contains('is-drop-after'),
  };
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + rect.width * ${ratio} }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  return indicator;
})()`);

const cancelDrag = async (sourceId) => evaluate(`(() => {
  const source = document.querySelector('[data-capability-member-id="${sourceId}"]');
  const transfer = new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  return true;
})()`);

const memberState = () => evaluate(`[...document.querySelectorAll('.capability-board [data-capability-member-id]')].map((item) => ({ id: item.dataset.capabilityMemberId, role: item.dataset.relationRole }))`);

const saveCurrentScope = async (scopeLabel) => {
  await evaluate(`document.querySelector('#toast').textContent = ''; document.querySelector('[data-save-capability-scope]').click(); true`);
  await waitFor(`document.querySelector('#toast')?.textContent.includes(${JSON.stringify(`${scopeLabel} v`)}) && document.querySelector('#toast')?.textContent.includes('已保存')`, `保存${scopeLabel}关系布局`);
};

try {
  await startDesktop();
  await openSkillPanel();
  await openNode("group", "group:novel");
  await openNode("module", "module:novel-writer");
  assert.deepEqual(await memberState(), [
    { id: "slot:novel-writer", role: "primary" },
    { id: "slot:chinese-novelist-skill", role: "secondary" },
  ], "隔离测试必须从默认小说主笔关系开始");

  const primaryLayout = await evaluate(`(() => {
    const board = document.querySelector('.capability-relation-primary-secondary');
    const primary = board.querySelector('.capability-board-cell[data-relation-role="primary"]').getBoundingClientRect();
    const secondary = board.querySelector('.capability-board-cell[data-relation-role="secondary"]').getBoundingClientRect();
    return {
      gap: secondary.left - primary.right,
      sameSize: Math.abs(primary.width - secondary.width) < 2 && Math.abs(primary.height - secondary.height) < 2,
      primaryLeft: primary.left < secondary.left,
      primary: { width: primary.width, height: primary.height, left: primary.left, top: primary.top },
      secondary: { width: secondary.width, height: secondary.height, left: secondary.left, top: secondary.top },
    };
  })()`);
  assert.equal(primaryLayout.primaryLeft, true);
  assert.equal(primaryLayout.sameSize, true, JSON.stringify(primaryLayout));
  assert.ok(Math.abs(primaryLayout.gap - 32) < 1, `主要区水平间隔应为 32px，实际为 ${primaryLayout.gap}`);

  const primarySwapIndicator = await dragMember("slot:chinese-novelist-skill", "slot:novel-writer");
  assert.deepEqual(primarySwapIndicator, { accepted: true, leadHighlighted: true, label: "替换主要节点", before: false, after: false });
  assert.deepEqual(await memberState(), [
    { id: "slot:chinese-novelist-skill", role: "primary" },
    { id: "slot:novel-writer", role: "secondary" },
  ]);
  const beforeCancel = await memberState();
  await cancelDrag("slot:novel-writer");
  assert.deepEqual(await memberState(), beforeCancel, "取消拖拽不得改变草稿");

  await cdp("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrowLayout = await evaluate(`(() => {
    const primary = document.querySelector('.capability-primary-zone').getBoundingClientRect();
    const secondary = document.querySelector('.capability-secondary-zone').getBoundingClientRect();
    return { stacked: secondary.top >= primary.bottom + 31, labels: [...document.querySelectorAll('.capability-role-zone-caption')].map((item) => item.textContent.trim()) };
  })()`);
  assert.equal(narrowLayout.stacked, true, "窄宽度下主要区必须位于次要区上方");
  assert.deepEqual(narrowLayout.labels, ["主要区", "次要区"]);
  await cdp("Emulation.clearDeviceMetricsOverride");
  await saveCurrentScope("模块");

  await evaluate(`document.querySelector('[data-capability-breadcrumb="1"]').click(); true`);
  await waitFor(`document.querySelector('[data-capability-node-context-id="group:novel"]')`, "返回长篇小说模组");
  await openNode("group", "group:novel-theory");
  const organizationLayout = await evaluate(`(() => {
    const board = document.querySelector('.capability-relation-organization');
    const upper = board.querySelector('.capability-board-cell[data-relation-role="upper"]').getBoundingClientRect();
    const lower = board.querySelector('.capability-board-cell[data-relation-role="lower"]').getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    return {
      gap: lower.top - upper.bottom,
      sameSize: Math.abs(upper.width - lower.width) < 2 && Math.abs(upper.height - lower.height) < 2,
      upperCentered: Math.abs((upper.left + upper.width / 2) - (boardRect.left + boardRect.width / 2)) < 1,
      allBelow: [...board.querySelectorAll('.capability-board-cell[data-relation-role="lower"]')].every((item) => item.getBoundingClientRect().top >= upper.bottom),
    };
  })()`);
  assert.equal(organizationLayout.sameSize, true);
  assert.equal(organizationLayout.upperCentered, true);
  assert.equal(organizationLayout.allBelow, true);
  assert.ok(Math.abs(organizationLayout.gap - 32) < 1, `上下位垂直间隔应为 32px，实际为 ${organizationLayout.gap}`);

  const upperSwapIndicator = await dragMember("place:novel-theory:female-web", "place:novel-theory:advisor");
  assert.equal(upperSwapIndicator.accepted, true);
  assert.equal(upperSwapIndicator.leadHighlighted, true);
  assert.equal(upperSwapIndicator.label, "替换上位节点");
  assert.deepEqual((await memberState()).slice(0, 3), [
    { id: "place:novel-theory:female-web", role: "upper" },
    { id: "place:novel-theory:science-fiction", role: "lower" },
    { id: "place:novel-theory:male-web", role: "lower" },
  ]);

  const lowerReorderIndicator = await dragMember("place:novel-theory:advisor", "place:novel-theory:science-fiction", 0.25);
  assert.equal(lowerReorderIndicator.accepted, true);
  assert.equal(lowerReorderIndicator.before, true);
  assert.equal(lowerReorderIndicator.leadHighlighted, false);
  assert.deepEqual((await memberState()).slice(0, 3), [
    { id: "place:novel-theory:female-web", role: "upper" },
    { id: "place:novel-theory:advisor", role: "lower" },
    { id: "place:novel-theory:science-fiction", role: "lower" },
  ]);

  await saveCurrentScope("模组");

  await stopDesktop();
  await startDesktop();
  await openSkillPanel();
  await openNode("group", "group:novel");
  await openNode("module", "module:novel-writer");
  assert.deepEqual(await memberState(), [
    { id: "slot:chinese-novelist-skill", role: "primary" },
    { id: "slot:novel-writer", role: "secondary" },
  ], "重启后必须恢复已保存的主要/次要关系");
  await evaluate(`document.querySelector('[data-capability-breadcrumb="1"]').click(); true`);
  await openNode("group", "group:novel-theory");
  assert.deepEqual((await memberState()).slice(0, 3), [
    { id: "place:novel-theory:female-web", role: "upper" },
    { id: "place:novel-theory:advisor", role: "lower" },
    { id: "place:novel-theory:science-fiction", role: "lower" },
  ], "重启后必须恢复已保存的上下位关系和下位排序");

  console.log("Skill panel real UI layout, drag, persistence, and restart checks passed");
} finally {
  await stopDesktop().catch(() => {});
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
