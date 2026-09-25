import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-marketplace-share-ui-"));
const screenshotPath = join(root, "artifacts", "skill-marketplace-share-horizontal.png");
const installedExecutable = String(process.env.SHENSI_E2E_INSTALLED_EXE || "").trim();
const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const reserveDebugPort = () => new Promise((resolvePromise, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolvePromise(address.port));
  });
});

await mkdir(dirname(screenshotPath), { recursive: true });
const debugPort = await reserveDebugPort();
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const child = spawn(installedExecutable || electron, installedExecutable
  ? [`--remote-debugging-port=${debugPort}`, "--disable-gpu", "--disable-gpu-compositing"]
  : [`--remote-debugging-port=${debugPort}`, "--disable-gpu", "--disable-gpu-compositing", desktopEntry], {
  cwd: root,
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: join(runtimeRoot, "data"),
    SHENSI_MACHINE_DATA_ROOT: join(runtimeRoot, "data"),
    SHENSI_DESKTOP_USER_DATA_ROOT: join(runtimeRoot, "electron-user"),
    SHENSI_SKIP_UPDATE_CHECK: "1",
    SHENSI_DISABLE_HARDWARE_ACCELERATION: "1",
    SHENSI_TEST_DESKTOP_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let childOutput = "";
child.stdout?.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_000); });
child.stderr?.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-8_000); });
let socket;
try {
  let target;
  for (let deadline = Date.now() + 60_000; Date.now() < deadline && !target;) {
    if (child.exitCode !== null) break;
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
    } catch {}
    if (!target) await delay(150);
  }
  if (!target) throw new Error(`Skill 广场桌面验收页面未启动：${childOutput || "无输出"}`);

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
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
  const waitFor = async (expression, label, timeout = 45_000) => {
    for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw new Error(`等待超时：${label}`);
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "应用启动", 60_000);
  await evaluate("document.querySelector('#dismissCreativeStartWelcome')?.click(); true");
  await evaluate("document.querySelector('#settingsButton').click(); true");
  await waitFor("document.querySelector('#settingsDialog')?.open", "设置窗口");
  await evaluate("document.querySelector('[data-settings-section=\"skill\"]').click(); true");
  await waitFor("document.querySelector('[data-skill-settings-tab=\"marketplace\"]')", "Skill 广场标签");
  await evaluate("document.querySelector('[data-skill-settings-tab=\"marketplace\"]').click(); true");
  await waitFor("document.querySelector('#shareSkillToMarketplace')", "分享按钮");

  const geometry = await evaluate(`(() => {
    const button = document.querySelector('#shareSkillToMarketplace');
    const actions = button.closest('.marketplace-share-actions');
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const label = button.querySelector(':scope > span');
    const labelStyle = getComputedStyle(label);
    const visibleExactLabelLeaves = [...document.querySelectorAll('body *')].filter((element) => {
      if (element.children.length || element.textContent.trim() !== '分享到Skill广场') return false;
      const elementStyle = getComputedStyle(element);
      const elementRect = element.getBoundingClientRect();
      return elementStyle.display !== 'none' && elementStyle.visibility !== 'hidden' && elementRect.width > 0 && elementRect.height > 0;
    });
    return {
      buttonCount: document.querySelectorAll('#shareSkillToMarketplace').length,
      directChildren: [...button.children].map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent.trim() })),
      iconCount: button.querySelectorAll('.icon').length,
      text: button.textContent.trim(),
      width: rect.width,
      height: rect.height,
      ratio: rect.width / rect.height,
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
      writingMode: style.writingMode,
      labelWhiteSpace: labelStyle.whiteSpace,
      labelWritingMode: labelStyle.writingMode,
      actionsWidth: actions.getBoundingClientRect().width,
      visibleExactLabelLeafCount: visibleExactLabelLeaves.length,
    };
  })()`);

  assert.equal(geometry.buttonCount, 1, "Skill 广场只能显示一个主分享按钮");
  assert.deepEqual(geometry.directChildren, [{ tag: "SPAN", className: "", text: "分享到Skill广场" }]);
  assert.equal(geometry.iconCount, 0, "主分享按钮不得保留旧私有字体图标");
  assert.equal(geometry.text, "分享到Skill广场");
  assert.ok(geometry.ratio > 2.5, `分享按钮必须横向显示：${JSON.stringify(geometry)}`);
  assert.equal(geometry.whiteSpace, "nowrap");
  assert.equal(geometry.wordBreak, "keep-all");
  assert.equal(geometry.writingMode, "horizontal-tb");
  assert.equal(geometry.labelWhiteSpace, "nowrap");
  assert.equal(geometry.labelWritingMode, "horizontal-tb");
  assert.ok(geometry.actionsWidth >= geometry.width, "操作区不得把按钮压成窄列");
  assert.equal(geometry.visibleExactLabelLeafCount, 1, "页面不得显示重复的分享文案");

  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ ok: true, screenshotPath, geometry }, null, 2));
} finally {
  socket?.close();
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, delay(3_000)]);
  }
  await delay(350);
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
}
