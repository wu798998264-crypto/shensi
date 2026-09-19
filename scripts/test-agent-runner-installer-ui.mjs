import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-agent-runner-installer-ui-"));
const artifactRoot = join(root, "artifacts");
const screenshots = {
  missing: join(artifactRoot, "agent-runner-missing-install-dialog.png"),
  completed: join(artifactRoot, "agent-runner-install-completed-selection.png"),
};
await mkdir(artifactRoot, { recursive: true });
const debugPort = 9368;
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
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
let target = null;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !target;) {
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
  } catch {}
  if (!target) await delay(150);
}
if (!target) throw new Error(`运行器安装 UI 验收页面未启动：${stderr}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
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
  pending.set(id, { resolve: resolveCall, reject: rejectCall });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label) => {
  for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
};
const screenshot = async (path) => {
  const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path, Buffer.from(image.data, "base64"));
};

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true'", "应用启动");
  await evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__simulatedRunnerInstalled = false;
    window.fetch = async (input, init = {}) => {
      const url = String(input?.url || input);
      if (url.includes('/api/agent-runners/status')) {
        const installed = window.__simulatedRunnerInstalled;
        return new Response(JSON.stringify({ ok: true, runners: {
          codex: { id: 'codex', label: 'Codex', installed: true, available: true, version: 'codex-cli test' },
          opencode: { id: 'opencode', label: 'OpenCode', installed: true, available: true, version: 'OpenCode test' },
          claude_code: { id: 'claude_code', label: 'Claude Code', installed, available: installed, version: installed ? 'Claude Code simulated 1.0' : '', officialUrl: 'https://code.claude.com/docs/en/installation' }
          ,workbuddy: { id: 'workbuddy', label: 'WorkBuddy', installed: true, available: false, ready: false, state: 'login_required', version: 'WorkBuddy simulated 1.0', message: 'WorkBuddy 已安装但尚未登录' }
        }}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/agent-runners/install')) {
        return new Response(JSON.stringify({ ok: true, job: { id: 'simulated-job', runnerId: 'claude_code', label: 'Claude Code', status: 'running', stage: 'installing', progress: 42, message: '正在通过官方来源模拟下载与装配…', officialUrl: 'https://code.claude.com/docs/en/installation' } }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/agent-runners/install/status')) {
        window.__simulatedRunnerInstalled = true;
        return new Response(JSON.stringify({ ok: true, job: { id: 'simulated-job', runnerId: 'claude_code', label: 'Claude Code', status: 'completed', stage: 'completed', progress: 100, message: 'Claude Code 已完成下载、装配和版本复检', officialUrl: 'https://code.claude.com/docs/en/installation', capability: { available: true, installed: true, version: 'Claude Code simulated 1.0' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return nativeFetch(input, init);
    };
    return true;
  })()`);
  await evaluate(`document.querySelector('#settingsButton').click(); true`);
  await waitFor("document.querySelector('#settingsDialog')?.open", "设置窗口");
  await evaluate(`document.querySelector('[data-settings-section="model"]').click(); true`);
  await waitFor(`document.querySelector('#textAgentEngineSelect option[value="claude_code"]')?.textContent.includes('未安装')`, "Claude Code 未安装状态");
  await evaluate(`(() => {
    document.querySelector('[data-model-settings-channel="text"]')?.click();
    document.querySelector('[data-add-generation-connection="text"]')?.click();
    return true;
  })()`);
  await waitFor("document.querySelector('#textAgentEngineSelect')?.selectedOptions?.[0]?.textContent.trim() === '请选择运行器'", "新建配置运行器引导文字");
  assert.equal(await evaluate(`document.querySelector('#textAgentEngineSelect')?.selectedOptions?.[0]?.textContent.trim()`), "请选择运行器");
  await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    form.elements.textExecutionMode.value = 'agent';
    form.elements.textExecutionMode.dispatchEvent(new Event('change', { bubbles: true }));
    const select = document.querySelector('#textAgentEngineSelect');
    select.value = 'claude_code';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.querySelector('#agentRunnerInstallDialog')?.open", "安装对话框");
  const missingState = await evaluate(`(() => ({
    option: document.querySelector('#textAgentEngineSelect option[value="claude_code"]')?.textContent,
    dialogTitle: document.querySelector('#agentRunnerInstallTitle')?.textContent,
    button: document.querySelector('#startAgentRunnerInstall')?.textContent,
    stage: document.querySelector('#agentRunnerInstallStage')?.textContent,
    terminatePresent: Boolean(document.querySelector('#terminateAgentRunnerInstall')),
    selected: document.querySelector('#textAgentEngineSelect')?.value,
  }))()`);
  assert.match(missingState.option, /未安装/u);
  assert.equal(missingState.dialogTitle, "Claude Code 下载与装配");
  assert.equal(missingState.button, "下载并装配");
  assert.match(missingState.stage, /当前阶段/u);
  assert.equal(missingState.terminatePresent, true);
  assert.notEqual(missingState.selected, "claude_code", "未安装运行器不得写入当前配置");
  await screenshot(screenshots.missing);

  await evaluate(`document.querySelector('#startAgentRunnerInstall').click(); true`);
  await waitFor("!document.querySelector('#agentRunnerInstallDialog')?.open && document.querySelector('#textAgentEngineSelect')?.value === 'claude_code'", "安装完成自动复检并选择");
  const completedState = await evaluate(`(() => ({
    selected: document.querySelector('#textAgentEngineSelect')?.value,
    option: document.querySelector('#textAgentEngineSelect option[value="claude_code"]')?.textContent,
    installed: window.__simulatedRunnerInstalled,
  }))()`);
  assert.deepEqual(completedState, { selected: "claude_code", option: "Claude Code", installed: true });
  await screenshot(screenshots.completed);

  await evaluate(`(() => {
    const select = document.querySelector('#textAgentEngineSelect');
    select.value = 'workbuddy';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.querySelector('#agentRunnerInstallDialog')?.open", "WorkBuddy 登录提示");
  const workbuddyCopy = await evaluate(`document.querySelector('#agentRunnerInstallCopy')?.textContent`);
  assert.match(workbuddyCopy, /已安装并通过版本检查，但尚未登录/u);
  assert.doesNotMatch(workbuddyCopy, /本机未检测到/u, "已安装待登录不得继续显示本机未检测到");
  console.log(JSON.stringify({ ok: true, missingState, completedState, screenshots }, null, 2));
} finally {
  socket.close();
  child.kill();
  await delay(400);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
