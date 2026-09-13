import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-provider-model-ui-"));
const artifactRoot = join(root, "artifacts");
const screenshotPath = join(artifactRoot, "deepseek-provider-model-isolation.png");
await mkdir(artifactRoot, { recursive: true });
const debugPort = 9344;
const child = spawn(join(root, "node_modules", "electron", "dist", "electron.exe"), [
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
const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let target;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !target;) {
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
  } catch {}
  if (!target) await delay(150);
}
if (!target) throw new Error("DeepSeek 模型联动验收页面未启动");
const socket = new WebSocket(target.webSocketDebuggerUrl);
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
const cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: resolvePromise, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "界面脚本执行失败");
  return result.result?.value;
};
const waitFor = async (expression, label) => {
  for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
};

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "应用启动");
  await evaluate(`document.querySelector('#settingsButton').click(); true`);
  await waitFor("document.querySelector('#settingsDialog')?.open", "设置窗口");
  await waitFor("document.querySelector('#settingsDialog')?.inert === false && document.querySelector('#settingsDialog')?.getAttribute('aria-busy') !== 'true'", "设置窗口可交互");
  await evaluate(`document.querySelector('[data-settings-section="model"]').click(); true`);
  await waitFor("document.querySelector('#textAgentEngineSelect option[value=\"opencode\"]')?.dataset.runnerState === 'installed'", "OpenCode 运行器检测");
  await evaluate(`document.querySelector('.add-generation-configuration[data-add-generation-connection="text"]').click(); true`);
  await delay(100);
  await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    const set = (name, value) => {
      const control = form.elements.namedItem(name);
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('textAgentEngine', 'opencode');
    return true;
  })()`);
  await delay(300);
  await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    const set = (name, value) => {
      const control = form.elements.namedItem(name);
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('textCredentialSource', 'shensi');
    set('provider', 'DeepSeek');
    return true;
  })()`);
  try {
    await waitFor("[...document.querySelector('#modelInput').options].some(o => o.value.startsWith('deepseek/'))", "DeepSeek 模型目录");
  } catch (error) {
    const diagnostics = await evaluate(`(() => ({
      provider: document.querySelector('#settingsForm').elements.provider.value,
      engine: document.querySelector('#settingsForm').elements.textAgentEngine.value,
      credentialSource: document.querySelector('#settingsForm').elements.textCredentialSource.value,
      adapter: document.querySelector('#settingsForm').elements.adapter.value,
      models: [...document.querySelector('#modelInput').options].map(item => item.value),
      result: document.querySelector('#adapterResult')?.textContent || '',
    }))()`);
    throw new Error(`${error.message}；${JSON.stringify(diagnostics)}`);
  }
  const state = await evaluate(`(() => ({
    provider: document.querySelector('#settingsForm').elements.provider.value,
    engine: document.querySelector('#settingsForm').elements.textAgentEngine.value,
    models: [...document.querySelector('#modelInput').options].map(item => item.value).filter(Boolean),
    selected: document.querySelector('#modelInput').value,
    codexVisible: document.querySelector('#codexSettingsConnection')?.hidden === false,
  }))()`);
  assert.equal(state.provider, "DeepSeek");
  assert.equal(state.engine, "opencode");
  assert.ok(state.models.length >= 2);
  assert.ok(state.models.every((model) => model.startsWith("deepseek/")), `发现跨服务商模型：${state.models.join(", ")}`);
  assert.ok(state.selected.startsWith("deepseek/"));
  assert.equal(state.codexVisible, false, "OpenCode+DeepSeek 不得显示 Codex 登录区");
  await evaluate(`document.querySelector('#modelInput').scrollIntoView({ block: 'center' }); true`);
  await delay(250);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ ok: true, state, screenshotPath }, null, 2));
} finally {
  socket.close();
  child.kill();
  await delay(500);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
