import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-codex-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const artifactRoot = join(root, "artifacts");
const paths = {
  current: join(artifactRoot, "codex-ui-current-connection.png"),
  settings: join(artifactRoot, "codex-ui-settings-connection.png"),
  settingsStatus: join(artifactRoot, "codex-ui-settings-account-status.png"),
  runnerActions: join(artifactRoot, "codex-ui-new-agent-runner-actions.png"),
  detected: join(artifactRoot, "codex-ui-detected-unselected.png"),
  login: join(artifactRoot, "codex-ui-detected-login.png"),
  guidance: join(artifactRoot, "codex-ui-agent-guidance.png"),
  writing: join(artifactRoot, "codex-ui-writing-no-guidance.png"),
};
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

const debugPort = 9341;
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
if (!target) throw new Error(`Codex UI 验收页面未启动：${stderr.slice(-1200)}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  socket.addEventListener("open", resolvePromise, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "runtime exception");
  if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") runtimeErrors.push((message.params.args || []).map((item) => item.value || item.description || "").join(" "));
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
const waitFor = async (expression, label, timeout = 30_000) => {
  for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  const diagnostic = await evaluate(`(() => ({ panelHidden: document.querySelector('#quickModelPanel')?.hidden, button: Boolean(document.querySelector('#quickModelButton')), welcomeOpen: document.querySelector('#creativeStartWelcomeDialog')?.open, settingsOpen: document.querySelector('#settingsDialog')?.open, text: document.body?.innerText?.slice(-500) }))()`).catch(() => null);
  throw new Error(`等待超时：${label}；页面=${JSON.stringify(diagnostic)}；运行时错误=${runtimeErrors.slice(-5).join(" | ")}；${stderr.slice(-800)}`);
};
const screenshot = async (path) => {
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path, Buffer.from(result.data, "base64"));
};

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#quickModelButton')", "应用启动");
  await waitFor("document.querySelector('#creativeStartWelcomeDialog')", "首次介绍容器");
  await evaluate(`if (document.querySelector('#creativeStartWelcomeDialog')?.open) document.querySelector('#dismissCreativeStartWelcome')?.click(); true`);
  await waitFor("!document.querySelector('#creativeStartWelcomeDialog')?.open", "关闭首次介绍");
  await evaluate(`document.querySelector('#projectButton').click(); true`);
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate(`document.querySelector('#newWorkspaceButton').click(); true`);
  await waitFor("document.querySelector('#textDialog')?.open", "新建验收作品");
  await evaluate(`(() => { const input = document.querySelector('#textDialogInput'); input.value = 'Codex UI 验收作品'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#textDialogForm').requestSubmit(); return true; })()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('Codex UI 验收作品')", "验收作品创建", 30_000);
  await evaluate(`(() => { const panel = document.querySelector('#quickModelPanel'); const button = document.querySelector('#quickModelButton'); if (panel?.hidden) button?.click(); if (panel?.hidden) { panel.hidden = false; button?.setAttribute('aria-expanded', 'true'); } return true; })()`);
  await waitFor("!document.querySelector('#quickModelPanel')?.hidden", "模型选择器", 5_000);
  if (process.env.SHENSI_AGENT_MODE_BLOCKING_ONLY === "1") {
    const chatOnlyConnection = await evaluate(`(() => {
      const select = document.querySelector('#quickTextConnection');
      for (const option of [...select.options]) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const agent = document.querySelector('#chatProviderSelect option[value="codex_agent"]');
        if (agent?.dataset.supported === 'false') return option.textContent.trim();
      }
      return '';
    })()`);
    assert.ok(chatOnlyConnection, "隔离环境中必须存在仅支持 Chat 的文字连接");
    const unsupportedAgentOption = await evaluate(`(() => { const option = document.querySelector('#chatProviderSelect option[value="codex_agent"]'); return { disabled: option.disabled, supported: option.dataset.supported }; })()`);
    assert.deepEqual(unsupportedAgentOption, { disabled: false, supported: "false" });
    await evaluate(`(() => { window.__providerSwitchCalls = 0; const originalFetch = window.fetch; window.fetch = (...args) => { if (String(args[0] || '').includes('/api/codex-agent/provider')) window.__providerSwitchCalls += 1; return originalFetch(...args); }; const mode = document.querySelector('#chatProviderSelect'); mode.value = 'codex_agent'; mode.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor("document.querySelector('#unsupportedAgentModeDialog')?.open", "不支持 Agent 提示");
    assert.equal(await evaluate(`document.querySelector('#chatProviderSelect')?.value`), "gpt_cli");
    assert.match(await evaluate(`document.querySelector('#unsupportedAgentModeDialog')?.textContent || ''`), /当前连接不支持Agent模式，请更换连接。/u);
    assert.equal(await evaluate(`window.__providerSwitchCalls`), 0, "不支持 Agent 时不得请求服务端切换模式");
    await evaluate(`document.querySelector('#unsupportedAgentModeDialog').close(); document.querySelector('#closeQuickModel').click(); document.querySelector('#settingsButton').click(); true`);
    await waitFor("document.querySelector('#settingsDialog')?.open", "设置");
    await evaluate(`document.querySelector('[data-settings-section="about"]').click(); true`);
    await waitFor(`!document.querySelector('[data-settings-page="about"]')?.hidden`, "关于页面");
    const aboutText = await evaluate(`document.querySelector('[data-settings-page="about"]')?.textContent || ''`);
    assert.match(aboutText, /我制作神思，是希望真正改变 AI 写作中“模型替作者决定一切”的模式/u);
    assert.doesNotMatch(aboutText, /联系方式|wu798998264|赞助|收款码/u);
    assert.equal(await evaluate(`document.querySelector('[data-settings-page="about"] img')`), null);
    console.log(JSON.stringify({ ok: true, chatOnlyConnection, unsupportedAgentOption, providerSwitchCalls: 0, about: "clean" }, null, 2));
  } else {
  await evaluate(`(() => {
    const select = document.querySelector('#quickTextConnection');
    const option = [...select.options].find((item) => /OpenAI CLI|GPT Chat · Codex CLI/u.test(item.textContent));
    if (!option) throw new Error('缺少独立 Codex CLI 配置');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const mode = document.querySelector('#chatProviderSelect');
    mode.size = 2;
    return option.value;
  })()`);
  await waitFor("document.querySelector('#codexConnectionStatus')?.textContent.trim() === 'Codex 已连接'", "当前 Codex CLI 登录会话", 30_000);
  const current = await evaluate(`(() => ({
    modes: [...document.querySelectorAll('#chatProviderSelect option')].map((item) => item.textContent.trim()),
    selected: document.querySelector('#quickTextConnection')?.selectedOptions[0]?.textContent.trim(),
    status: document.querySelector('#codexConnectionStatus')?.textContent.trim(),
    loginHidden: document.querySelector('#codexAgentLogin')?.hidden === true,
    disconnect: document.querySelector('#codexAgentDisconnect')?.hidden === false,
    connectionHidden: document.querySelector('#quickCodexConnection')?.hidden === true,
  }))()`);
  assert.deepEqual(current.modes, ["Chat（快速问答、讨论与单次写作）", "Agent（复杂任务、工具调用与多步执行）"]);
  assert.equal(current.status, "Codex 已连接");
  assert.equal(current.loginHidden, true, "对话区登录成功后必须隐藏登录按钮");
  assert.equal(current.disconnect, false, "对话区不得显示断开 Codex；断开入口只保留在设置页");
  assert.equal(current.connectionHidden, true, "Codex 已连接后必须隐藏整个登录区并恢复原版模型界面");
  await evaluate(`(() => { const mode = document.querySelector('#chatProviderSelect'); mode.value = 'codex_agent'; mode.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#quickAgentFields')?.hidden === false && document.querySelector('#quickCodexConnection')?.hidden === true", "原版 Codex Agent 模型界面");
  const originalAgentLayout = await evaluate(`(() => ({
    labels: [...document.querySelectorAll('#quickAgentFields label')].map((item) => item.childNodes[0]?.textContent?.trim()).filter(Boolean),
    hasWorkspace: document.querySelector('#quickAgentFields #selectCodexProject')?.textContent.trim() === '更换目录',
  }))()`);
  assert.deepEqual(originalAgentLayout.labels, ["Agent 配置", "Agent 模型", "推理强度", "响应速度"]);
  assert.equal(originalAgentLayout.hasWorkspace, true);
  await screenshot(paths.current);

  await evaluate(`(() => { const mode = document.querySelector('#chatProviderSelect'); mode.size = 0; mode.value = 'gpt_cli'; mode.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#closeQuickModel').click(); document.querySelector('#settingsButton').click(); return true; })()`);
  await waitFor("document.querySelector('#settingsDialog')?.open", "设置");
  await evaluate(`document.querySelector('[data-settings-section="about"]').click(); true`);
  await waitFor(`!document.querySelector('[data-settings-page="about"]')?.hidden`, "关于页面");
  const aboutText = await evaluate(`document.querySelector('[data-settings-page="about"]')?.textContent || ''`);
  assert.match(aboutText, /我制作神思，是希望真正改变 AI 写作中“模型替作者决定一切”的模式/u);
  assert.doesNotMatch(aboutText, /联系方式|wu798998264|赞助|收款码/u);
  assert.equal(await evaluate(`document.querySelector('[data-settings-page="about"] img')`), null);
  await evaluate(`document.querySelector('[data-settings-section="model"]').click(); true`);
  await waitFor(`!document.querySelector('[data-settings-page="model"]')?.hidden && document.querySelector('#codexSettingsConnection')?.hidden === false`, "Codex 设置区");
  const settings = await evaluate(`(() => { const select = document.querySelector('[name="textExecutionMode"]'); select.size = 3; select.style.height = '86px'; return {
    modes: [...select.options].map((item) => item.textContent.trim()),
    status: document.querySelector('#codexSettingsAccountStatus')?.textContent.trim(),
    disconnect: document.querySelector('#codexSettingsDisconnect')?.hidden === false,
    connectCodexHidden: document.querySelector('#connectLocalCodex')?.hidden,
    addOpenCodeHidden: document.querySelector('#addOpenCodeConnection')?.hidden,
    refreshModelsVisible: document.querySelector('#refreshModels')?.hidden === false,
    realTestVisible: document.querySelector('#testAdapter')?.hidden === false,
  }; })()`);
  assert.deepEqual(settings.modes, ["Chat（快速问答、讨论与单次写作）", "Agent（复杂任务、工具调用与多步执行）", "Chat 与 Agent（同一配置兼备两种运行模式）"]);
  assert.equal(settings.status, "Codex 已连接");
  assert.equal(settings.disconnect, true);
  assert.equal(settings.connectCodexHidden, true, "已连接 Codex 不应继续显示连接按钮");
  assert.equal(settings.addOpenCodeHidden, true, "已有 Codex 配置内部不应显示 OpenCode 新增入口");
  assert.equal(settings.refreshModelsVisible, true);
  assert.equal(settings.realTestVisible, true);
  await screenshot(paths.settings);
  await evaluate(`document.querySelector('[name="textExecutionMode"]').size = 0; document.querySelector('[name="textExecutionMode"]').style.height = ''; document.querySelector('#codexSettingsConnection').scrollIntoView({ block: 'center' }); true`);
  await delay(150);
  await screenshot(paths.settingsStatus);

  await evaluate(`document.querySelector('[data-add-generation-connection="text"]').click(); true`);
  const openCodeDraftId = await evaluate(`(() => {
    const form = document.querySelector('#settingsForm');
    form.elements.textExecutionMode.value = 'agent';
    form.elements.textExecutionMode.dispatchEvent(new Event('change', { bubbles: true }));
    return document.querySelector('#textConnectionSelect')?.value;
  })()`);
  await waitFor("document.querySelector('#addOpenCodeConnection')?.hidden === false", "新 Agent 草稿的 OpenCode 入口");
  assert.equal(await evaluate(`document.querySelector('#connectLocalCodex')?.hidden`), true, "已存在 Codex 配置时不能重复显示 Codex 连接入口");
  const profileCountBeforeOpenCode = await evaluate(`document.querySelector('#textConnectionSelect')?.options.length`);
  await evaluate(`document.querySelector('#addOpenCodeConnection').click(); true`);
  await waitFor("document.querySelector('[name=\"textAgentEngine\"]')?.value === 'opencode'", "OpenCode 复用当前草稿", 30_000);
  const profileCountAfterOpenCode = await evaluate(`document.querySelector('#textConnectionSelect')?.options.length`);
  assert.equal(profileCountAfterOpenCode, profileCountBeforeOpenCode, `OpenCode 不应额外新增配置：${openCodeDraftId}`);
  assert.equal(await evaluate(`document.querySelector('#textConnectionSelect')?.value`), openCodeDraftId, "OpenCode 必须复用当前草稿 ID");
  assert.equal(await evaluate(`document.querySelector('#addOpenCodeConnection')?.hidden`), true);
  assert.equal(await evaluate(`document.querySelector('[data-remove-generation-connection="text"]')?.disabled`), false);
  await evaluate(`(() => { const original = window.confirm; window.confirm = () => true; document.querySelector('[data-remove-generation-connection="text"]').click(); window.confirm = original; return true; })()`);
  await waitFor(`document.querySelector('#textConnectionSelect')?.value !== ${JSON.stringify(openCodeDraftId)}`, "移除 OpenCode 草稿后返回既有配置");
  const restoredProfile = await evaluate(`(() => ({ adapter: document.querySelector('[name="adapter"]')?.value, engine: document.querySelector('[name="textAgentEngine"]')?.value, label: document.querySelector('[data-generation-profile-current="text"]')?.textContent.trim() }))()`);
  assert.notEqual(restoredProfile.engine, "opencode", JSON.stringify(restoredProfile));

  await evaluate(`document.querySelector('[data-add-generation-connection="text"]').click(); true`);
  await evaluate(`(() => { const form = document.querySelector('#settingsForm');
    form.elements.textRemarkName.value = '隔离验收 DeepSeek';
    form.elements.adapter.value = 'api'; form.elements.adapter.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.provider.value = 'DeepSeek'; form.elements.provider.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  await delay(100);
  await evaluate(`(() => { const form = document.querySelector('#settingsForm');
    form.elements.protocol.value = 'chat_completions'; form.elements.baseUrl.value = 'https://api.deepseek.com';
    form.elements.model.value = [...form.elements.model.options].find((item) => /deepseek/iu.test(item.value))?.value || form.elements.model.options[0]?.value || 'deepseek-chat';
    form.elements.textExecutionMode.value = 'chat'; form.requestSubmit(); return true; })()`);
  await waitFor("document.querySelector('.toast:not([hidden])')?.textContent.includes('设置已保存')", "保存隔离配置");
  await evaluate(`document.querySelector('[data-generation-profile-toggle="text"]').click(); true`);
  await waitFor(`[...document.querySelectorAll('[data-generation-order-list="text"] [data-generation-order-profile]')].some((row) => /OpenAI CLI|GPT Chat/u.test(row.textContent))`, "Codex 配置行");
  await evaluate(`(() => { const row = [...document.querySelectorAll('[data-generation-order-list="text"] [data-generation-order-profile]')].find((item) => /OpenAI CLI|GPT Chat/u.test(item.textContent)); row.click(); return true; })()`);
  await waitFor(`/OpenAI CLI|GPT Chat/u.test(document.querySelector('[data-generation-profile-current="text"]')?.textContent || '')`, "选中 Codex 配置");
  await evaluate(`(() => { const original = window.confirm; window.confirm = () => true; document.querySelector('[data-remove-generation-connection="text"]').click(); window.confirm = original; return true; })()`);
  await waitFor(`!/OpenAI CLI|GPT Chat/u.test(document.querySelector('[data-generation-profile-current="text"]')?.textContent || '')`, "移除 Codex 配置");
  const formValidity = await evaluate(`(() => { const form = document.querySelector('#settingsForm'); return { valid: form.checkValidity(), invalid: [...form.elements].filter((item) => item.matches?.(':invalid')).map((item) => ({ name: item.name, value: item.value })) }; })()`);
  assert.equal(formValidity.valid, true, `设置表单存在无效字段：${JSON.stringify(formValidity.invalid)}`);
  await evaluate(`document.querySelector('.toast')?.classList.remove('visible'); document.querySelector('#settingsForm').requestSubmit(); true`);
  await waitFor("document.querySelector('.toast.visible')?.textContent.trim()", "保存删除标记");
  const deleteSaveMessage = await evaluate(`document.querySelector('.toast.visible')?.textContent.trim() || ''`);
  assert.match(deleteSaveMessage, /设置已保存/u, `删除 Codex 配置保存失败：${deleteSaveMessage}`);
  await evaluate(`document.querySelector('[data-add-generation-connection="text"]').click(); true`);
  await evaluate(`(() => { const form = document.querySelector('#settingsForm'); form.elements.textExecutionMode.value = 'agent'; form.elements.textExecutionMode.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#connectLocalCodex').scrollIntoView({ block: 'center' }); return true; })()`);
  await waitFor("document.querySelector('#connectLocalCodex')?.hidden === false && document.querySelector('#addOpenCodeConnection')?.hidden === false", "未配置运行器时并列入口");
  const actionLabels = await evaluate(`(() => ({ codex: document.querySelector('#connectLocalCodex')?.textContent.trim(), openCode: document.querySelector('#addOpenCodeConnection')?.textContent.trim(), codexDisabled: document.querySelector('#connectLocalCodex')?.disabled }))()`);
  assert.deepEqual(actionLabels, { codex: "连接当前 Codex CLI", openCode: "新增 OpenCode Agent", codexDisabled: false });
  await screenshot(paths.runnerActions);
  await evaluate(`(() => { const original = window.confirm; window.confirm = () => true; document.querySelector('[data-remove-generation-connection="text"]').click(); window.confirm = original; return true; })()`);
  await waitFor("!/新建文字 AI 配置/u.test(document.querySelector('[data-generation-profile-current=\"text\"]')?.textContent || '')", "移除未保存运行器草稿");
  await evaluate(`(() => { document.querySelector('#closeSettings').click(); const panel = document.querySelector('#quickModelPanel'); const button = document.querySelector('#quickModelButton'); if (panel?.hidden) button?.click(); if (panel?.hidden) { panel.hidden = false; button?.setAttribute('aria-expanded', 'true'); } return true; })()`);
  await waitFor("[...document.querySelectorAll('#quickTextConnection option')].some((item) => item.textContent.includes('本机已检测'))", "临时 Codex 入口");
  const detected = await evaluate(`(() => ({ selected: document.querySelector('#quickTextConnection').value, loginHidden: document.querySelector('#quickCodexConnection').hidden, options: [...document.querySelectorAll('#quickTextConnection option')].map((item) => item.textContent.trim()) }))()`);
  assert.notEqual(detected.selected, "__detected_codex_cli__");
  assert.equal(detected.loginHidden, true);
  await screenshot(paths.detected);
  await evaluate(`(() => { const select = document.querySelector('#quickTextConnection'); select.value = '__detected_codex_cli__'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#codexAgentLogin')?.hidden === false", "临时 Codex 登录按钮");
  assert.equal(await evaluate(`document.querySelector('#codexConnectionStatus')?.textContent.trim()`), "Codex 未连接");
  await screenshot(paths.login);

  await evaluate(`(() => { const select = document.querySelector('#quickTextConnection'); select.value = [...select.options].find((item) => item.value !== '__detected_codex_cli__').value; select.dispatchEvent(new Event('change', { bubbles: true })); const mode = document.querySelector('#chatProviderSelect'); mode.value = 'gpt_cli'; mode.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#chatProviderSelect option[value=\"codex_agent\"]')?.dataset.supported === 'false'", "Chat-only 连接能力状态");
  const unsupportedAgentOption = await evaluate(`(() => { const option = document.querySelector('#chatProviderSelect option[value="codex_agent"]'); return { disabled: option.disabled, supported: option.dataset.supported }; })()`);
  assert.deepEqual(unsupportedAgentOption, { disabled: false, supported: "false" });
  await evaluate(`(() => { window.__providerSwitchCalls = 0; const originalFetch = window.fetch; window.fetch = (...args) => { if (String(args[0] || '').includes('/api/codex-agent/provider')) window.__providerSwitchCalls += 1; return originalFetch(...args); }; const mode = document.querySelector('#chatProviderSelect'); mode.value = 'codex_agent'; mode.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor("document.querySelector('#unsupportedAgentModeDialog')?.open", "不支持 Agent 提示");
  assert.equal(await evaluate(`document.querySelector('#chatProviderSelect')?.value`), "gpt_cli");
  assert.match(await evaluate(`document.querySelector('#unsupportedAgentModeDialog')?.textContent || ''`), /当前连接不支持Agent模式，请更换连接。/u);
  assert.equal(await evaluate(`window.__providerSwitchCalls`), 0, "不支持 Agent 时不得请求服务端切换模式");
  await evaluate(`document.querySelector('#unsupportedAgentModeDialog').close(); document.querySelector('#closeQuickModel').click(); true`);
  await delay(200);
  await evaluate(`(() => { const input = document.querySelector('#chatInput'); input.value = '请修改多个本地源码文件，并运行定向测试和打包验证'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chatForm').requestSubmit(); return true; })()`);
  await waitFor("document.querySelector('[data-chat-agent-guidance]')", "Agent 推荐");
  assert.equal(await evaluate(`document.querySelectorAll('[data-chat-agent-guidance]').length`), 1);
  assert.match(await evaluate(`document.querySelector('[data-chat-agent-guidance]')?.textContent || ''`), /请选择可用的 Agent 配置/u);
  assert.equal(await evaluate(`document.querySelector('#conversationChoicePanel')?.hidden`), false);
  assert.deepEqual(await evaluate(`([...document.querySelectorAll('#conversationChoicePanel [data-conversation-choice][data-choice-type="chat_agent_guidance"]')].map((item) => item.textContent.trim()))`), ["选择 Agent 配置", "取消"]);
  assert.equal(await evaluate(`document.querySelectorAll('[data-chat-agent-guidance] [data-conversation-choice], [data-chat-agent-guidance] [data-chat-agent-guidance-action]').length`), 0);
  await screenshot(paths.guidance);

  await cdp("Page.reload", { ignoreCache: true });
  await delay(600);
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#chatInput')", "普通写作重载");
  await evaluate(`(() => { const input = document.querySelector('#chatInput'); input.value = '续写当前章节的下一段'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chatForm').requestSubmit(); return true; })()`);
  await delay(300);
  assert.equal(await evaluate(`document.querySelectorAll('[data-chat-agent-guidance]').length`), 0);
  await screenshot(paths.writing);
  console.log(JSON.stringify({ ok: true, current, settings, detected, paths }, null, 2));
  }
} finally {
  try { socket.close(); } catch {}
  child.kill();
  await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => {});
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
}
