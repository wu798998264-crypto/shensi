import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-history-layout-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const screenshotPath = join(root, "artifacts", "history-action-horizontal.png");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(dirname(screenshotPath), { recursive: true });

const debugPort = 9362;
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
if (!target) throw new Error(`历史版本布局验收页面未启动：${stderr.slice(-1000)}`);

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

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 420, deviceScaleFactor: 1, mobile: false });
  for (let deadline = Date.now() + 45_000;;) {
    if (await evaluate("document.documentElement.dataset.bootReady === 'true'")) break;
    if (Date.now() >= deadline) throw new Error(`应用启动超时：${stderr.slice(-800)}`);
    await delay(100);
  }
  const geometry = await evaluate(`(() => {
    for (const child of [...document.body.children]) child.style.display = 'none';
    const fixture = document.createElement('article');
    fixture.className = 'history-item';
    fixture.style.cssText = 'position:fixed;left:20px;top:20px;width:272px;z-index:999999;background:var(--surface,#fff);border:1px solid var(--border,#ddd)';
    fixture.innerHTML = '<strong>写入结果完整版本</strong><div><span>v1 · 2026-09-15</span><span class="history-actions"><button type="button">设为当前</button><button class="icon-button bare tiny" type="button">✎</button><button class="icon-button bare tiny" type="button">□</button><button class="icon-button bare tiny" type="button">×</button></span></div>';
    document.body.append(fixture);
    const row = fixture.querySelector(':scope > div');
    const actions = fixture.querySelector('.history-actions');
    const restore = actions.querySelector('button');
    const fixtureRect = fixture.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const restoreRect = restore.getBoundingClientRect();
    const style = getComputedStyle(restore);
    return {
      fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
      actionsInside: actionsRect.right <= fixtureRect.right + 1,
      restoreRatio: restoreRect.width / restoreRect.height,
      rowHeight: row.getBoundingClientRect().height,
      whiteSpace: style.whiteSpace,
      writingMode: style.writingMode,
      flexWrap: getComputedStyle(actions).flexWrap,
    };
  })()`);
  assert.ok(geometry.fixtureOverflow <= 1, `窄历史面板不得横向溢出：${JSON.stringify(geometry)}`);
  assert.equal(geometry.actionsInside, true, "历史版本动作按钮必须保持在面板内");
  assert.ok(geometry.restoreRatio > 1.4, "设为当前按钮必须横向显示");
  assert.equal(geometry.whiteSpace, "nowrap");
  assert.equal(geometry.writingMode, "horizontal-tb");
  assert.equal(geometry.flexWrap, "nowrap");
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ ok: true, screenshotPath, geometry }));
} finally {
  socket.close();
  child.kill();
  await delay(800);
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
}
