import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-custom-multimodal-ui-"));
const debugPort = 9356;
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
if (!target) throw new Error("多模态能力验收页面未启动");
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
const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const waitFor = async (expression, label) => {
  for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
};

try {
  await cdp("Runtime.enable");
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "应用启动");
  await evaluate(`document.querySelector('#settingsButton').click(); true`);
  await waitFor("document.querySelector('#settingsDialog')?.open", "设置窗口");
  await evaluate(`document.querySelector('[data-settings-section="model"]').click(); true`);
  await evaluate(`(() => {
    document.querySelector('[data-add-generation-connection="text"]').click();
    const form = document.querySelector('#settingsForm');
    const set = (name, value, type = 'change') => {
      const control = form.elements.namedItem(name);
      control.value = value;
      control.dispatchEvent(new Event(type, { bubbles: true }));
    };
    set('adapter', 'api');
    set('provider', '自定义兼容接口');
    set('baseUrl', 'http://127.0.0.1:59999/v1', 'input');
    const customModel = document.querySelector('#customModelInput');
    customModel.value = 'custom-text-model';
    customModel.dispatchEvent(new Event('input', { bubbles: true }));
    set('apiKey', 'ui-test-key', 'input');
    return true;
  })()`);
  await waitFor("document.querySelector('#customApiCapabilityPanel')?.hidden === false", "通用能力面板显示");
  const apiState = await evaluate(`(() => ({
    title: document.querySelector('#customApiCapabilityTitle').textContent,
    channels: [...document.querySelectorAll('[data-custom-api-capability]')].map(item => ({ channel: item.dataset.customApiCapability, text: item.textContent })),
    refreshVisible: document.querySelector('#refreshCustomApiCapabilities').offsetParent !== null,
    refreshTitle: document.querySelector('#refreshCustomApiCapabilities').title,
  }))()`);
  assert.match(apiState.title, /^多模态能力/u);
  assert.deepEqual(apiState.channels.map((item) => item.channel), ["text", "image", "video", "audio"]);
  assert.equal(apiState.refreshVisible, true);
  assert.equal(apiState.refreshTitle, "刷新多模态能力状态");

  await evaluate(`(() => {
    window.__customCapabilityProbeCalls = [];
    window.__customCapabilityOriginalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      window.__customCapabilityProbeCalls.push(url);
      if (url === '/api/models/list') {
        const models = [{ slug: 'custom-text-model' }, { slug: 'custom-image-model' }, { slug: 'custom-voice-model' }];
        return new Response(JSON.stringify({ ok: true, models }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/media/capabilities/probe') return new Response(JSON.stringify({ ok: true, connected: false, driverRegistered: false, reason: 'driver_not_registered', models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return window.__customCapabilityOriginalFetch(input, init);
    };
    document.querySelector('#refreshCustomApiCapabilities').click();
    return true;
  })()`);
  await waitFor("document.querySelector('#refreshCustomApiCapabilities')?.disabled === false", "多模态状态刷新完成");
  const refreshEvidence = await evaluate(`(() => ({
    calls: window.__customCapabilityProbeCalls,
    textState: document.querySelector('[data-custom-api-capability="text"]').textContent,
    imageState: document.querySelector('[data-custom-api-capability="image"]').textContent,
    videoState: document.querySelector('[data-custom-api-capability="video"]').textContent,
    audioState: document.querySelector('[data-custom-api-capability="audio"]').textContent,
    syncVisible: document.querySelector('#syncCustomApiCapabilities').hidden === false,
    syncChannels: document.querySelector('#syncCustomApiCapabilities').dataset.syncChannels,
  }))()`);
  assert.equal(refreshEvidence.calls.includes("/api/models/list"), true);
  assert.equal(refreshEvidence.calls.filter((url) => url === "/api/models/list").length, 1, "同一自定义 API 刷新应只读取一次模型目录");
  assert.equal(refreshEvidence.textState, "目录可用 · 待实测");
  assert.equal(refreshEvidence.imageState, "目录可用 · 待实测");
  assert.equal(refreshEvidence.videoState, "不支持");
  assert.equal(refreshEvidence.audioState, "已识别 · 待接入");
  assert.equal(refreshEvidence.syncVisible, true);
  assert.equal(refreshEvidence.syncChannels, "image");
  assert.equal(refreshEvidence.calls.some((url) => /\/api\/(?:images|videos)\/generate|\/api\/generation\/jobs\/media|smoke/u.test(url)), false, "普通刷新不得提交收费生成任务");
  const beforeSync = await evaluate(`(() => ({
    activeImage: document.querySelector('#imageConnectionSelect').value,
    imageProfileCount: document.querySelectorAll('#imageConnectionSelect option').length,
  }))()`);
  await evaluate(`document.querySelector('#syncCustomApiCapabilities').click(); true`);
  await waitFor("document.querySelector('#syncCustomApiCapabilities')?.hidden === true", "已检测能力同步完成");
  const syncEvidence = await evaluate(`(() => ({
    activeImage: document.querySelector('#imageConnectionSelect').value,
    imageProfiles: [...document.querySelectorAll('#imageConnectionSelect option')].map((item) => item.textContent),
    videoProfiles: [...document.querySelectorAll('#videoConnectionSelect option')].map((item) => item.textContent),
    audioProfiles: [...document.querySelectorAll('#audioConnectionSelect option')].map((item) => item.textContent),
  }))()`);
  assert.equal(syncEvidence.activeImage, beforeSync.activeImage, "同步能力配置不得切换用户当前图片配置");
  assert.equal(syncEvidence.imageProfiles.length, beforeSync.imageProfileCount + 1, "只应新增一个检测到的图片配置");
  assert.equal(syncEvidence.imageProfiles.some((item) => /自定义兼容接口.*图片/u.test(item)), true, "检测到图片能力后应创建图片配置");
  assert.equal(syncEvidence.videoProfiles.some((item) => /自定义兼容接口.*视频/u.test(item)), false, "未检测到视频能力不得创建视频配置");
  assert.equal(syncEvidence.audioProfiles.some((item) => /自定义兼容接口.*音频/u.test(item)), false, "音频仅识别但软件未接入时不得创建正式音频配置");
  await evaluate(`window.fetch = window.__customCapabilityOriginalFetch; true`);

  await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    const set = (name, value, type = 'change') => {
      const control = form.elements.namedItem(name);
      control.value = value;
      control.dispatchEvent(new Event(type, { bubbles: true }));
    };
    set('adapter', 'cli');
    set('cliPath', 'custom-runner', 'input');
    return true;
  })()`);
  await waitFor("document.querySelector('#customApiCapabilityPanel')?.hidden === false", "自定义 CLI 能力面板显示");
  const cliDiagnostic = await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    return { provider: form.elements.provider.value, adapter: form.elements.adapter.value, cliPath: form.elements.cliPath.value, channel: window.ui?.modelSettingsChannel, panelHidden: document.querySelector('#customApiCapabilityPanel').hidden };
  })()`);
  const cliVisible = cliDiagnostic.panelHidden === false;
  assert.equal(cliVisible, true, "自定义 CLI 必须共用四模态能力面板");

  await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    form.elements.provider.value = 'OpenAI';
    form.elements.provider.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.querySelector('#customApiCapabilityPanel')?.hidden === true", "内置配置隐藏通用面板");
  console.log(JSON.stringify({ ok: true, apiState, refreshEvidence, cliVisible, cliDiagnostic }, null, 2));
} finally {
  socket.close();
  child.kill();
  await delay(500);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
