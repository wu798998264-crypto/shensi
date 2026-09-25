import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = join(root, "output", "playwright");
const installedExecutable = String(process.env.SHENSI_TEST_INSTALLED_EXE || "C:\\Users\\Administrator\\AppData\\Local\\Programs\\Shensi\\Shensi.exe").trim();
const debugPort = 9397;
const coldWaitMs = Math.max(1_000, Number(process.env.SHENSI_UI_COLD_WAIT_MS || 45_000) || 45_000);
const screenshots = {
  coldStart: join(outputRoot, "installed-7.7.5-cold-start-no-dreamina-lock.png"),
  workBuddyModels: join(outputRoot, "installed-7.7.5-workbuddy-models.png"),
  dreaminaVerification: join(outputRoot, "installed-7.7.5-dreamina-single-verification.png"),
};

await mkdir(outputRoot, { recursive: true });
const child = spawn(installedExecutable, [`--remote-debugging-port=${debugPort}`], {
  cwd: root,
  env: { ...process.env, SHENSI_SKIP_UPDATE_CHECK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
let socket;

try {
  let target = null;
  for (let deadline = Date.now() + 60_000; Date.now() < deadline && !target;) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
    } catch {}
    if (!target) await delay(150);
  }
  assert.ok(target, `安装版神思窗口未启动：${stderr}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
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
  const cdp = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new Error(`安装版 UI 验收命令超时：${method}`));
    }, 60_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveCall(value); },
      reject: (error) => { clearTimeout(timer); rejectCall(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeout = 90_000) => {
    for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        if (!/navigated|context|destroyed/iu.test(String(error?.message || error))) throw error;
      }
      await delay(100);
    }
    throw new Error(`等待超时：${label}`);
  };
  const capture = async (path) => {
    const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path, Buffer.from(screenshot.data, "base64"));
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.bringToFront");
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "安装版神思启动", 120_000);
  await evaluate("localStorage.setItem('shensi:creative-start-welcome:v1', 'seen'); document.querySelector('#creativeStartWelcomeDialog')?.close(); true");
  await delay(coldWaitMs);

  const coldStart = await evaluate(`(() => ({
    title: document.title,
    version: document.title.match(/[0-9]+(?:\\.[0-9]+){2}/u)?.[0] || '',
    profileLockOpen: Boolean(document.querySelector('#dreaminaProfileLockDialog')?.open),
    occupantsOpen: Boolean(document.querySelector('#dreaminaLockOccupantsDialog')?.open),
    reverifyOpen: Boolean(document.querySelector('#dreaminaReverifyDialog')?.open),
    visibleDialogs: [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.id),
  }))()`);
  assert.equal(coldStart.version, "7.7.5");
  assert.equal(coldStart.profileLockOpen, false, "冷启动不得弹出即梦锁占用窗口");
  assert.equal(coldStart.occupantsOpen, false, "冷启动不得弹出即梦锁待处理窗口");
  assert.equal(coldStart.reverifyOpen, false, "冷启动不得主动弹出即梦账号核验窗口");
  await capture(screenshots.coldStart);

  await evaluate(`(() => {
    document.querySelector('#settingsButton')?.click();
    document.querySelector('[data-settings-section="model"]')?.click();
    document.querySelector('[data-model-settings-channel="text"]')?.click();
    const select = document.querySelector('#textConnectionSelect');
    if (!select?.querySelector('option[value="text-workbuddy-cli"]')) throw new Error('WorkBuddy 配置不存在');
    select.value = 'text-workbuddy-cli';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.querySelector('#settingsDialog')?.open", "模型设置窗口");
  await delay(1_500);
  await evaluate(`(() => {
    const engine = document.querySelector('#textAgentEngineSelect');
    engine.value = 'workbuddy';
    engine.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.querySelector('#textAgentEngineSelect')?.value === 'workbuddy'", "WorkBuddy 配置选中");
  await waitFor("document.querySelector('#modelInput')?.options?.length >= 8", "WorkBuddy 模型目录", 60_000);
  await delay(750);
  const workBuddy = await evaluate(`(() => {
    const engine = document.querySelector('#textAgentEngineSelect');
    if (engine.value !== 'workbuddy') {
      engine.value = 'workbuddy';
      engine.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const select = document.querySelector('#modelInput');
    const models = [...select.options].map((option) => ({ value: option.value, label: option.textContent.trim() })).filter((item) => item.value);
    select.size = Math.min(10, Math.max(6, models.length));
    select.style.minHeight = '280px';
    select.closest('label')?.scrollIntoView({ block: 'center' });
    return { engine: document.querySelector('#textAgentEngineSelect')?.value, models };
  })()`);
  assert.equal(workBuddy.engine, "workbuddy");
  assert.ok(workBuddy.models.length >= 8, "WorkBuddy 必须显示真实模型目录");
  await capture(screenshots.workBuddyModels);

  await evaluate(`(() => {
    document.querySelector('#modelInput').size = 0;
    document.querySelector('#modelInput').style.minHeight = '';
    document.querySelector('[data-model-settings-channel="image"]')?.click();
    const select = document.querySelector('#imageConnectionSelect');
    const dreamina = [...select.options].find((option) => /^image-dreamina-cli(?:$|-)/u.test(option.value));
    if (!dreamina) throw new Error('即梦图片配置不存在');
    select.value = dreamina.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return dreamina.value;
  })()`);
  await waitFor("!document.querySelector('#dreaminaAccountPanel')?.hidden", "即梦账号面板");
  await delay(1_500);
  const dreamina = await evaluate(`(() => {
    const panel = document.querySelector('#dreaminaAccountPanel');
    panel.scrollIntoView({ block: 'center' });
    const visibleVerificationButtons = [...document.querySelectorAll('#settingsDialog button')].filter((button) => {
      const style = getComputedStyle(button);
      return button.textContent.trim() === '核验账号' && !button.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    });
    return {
      title: document.querySelector('#dreaminaAccountTitle')?.textContent.trim(),
      status: document.querySelector('#dreaminaAccountStatus')?.textContent.trim(),
      verificationButtonCount: visibleVerificationButtons.length,
      labels: visibleVerificationButtons.map((button) => button.textContent.trim()),
    };
  })()`);
  assert.equal(dreamina.verificationButtonCount, 1, "即梦配置面板只能显示一个核验账号按钮");
  await capture(screenshots.dreaminaVerification);

  console.log(JSON.stringify({ ok: true, coldStart, workBuddy: { ...workBuddy, modelCount: workBuddy.models.length }, dreamina, screenshots }, null, 2));
} finally {
  socket?.close();
  child.kill();
  await delay(500);
}
