import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-media-choice-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const artifactRoot = join(root, "artifacts");
const screenshotRoot = join(root, "output", "playwright");
const screenshotPath = join(artifactRoot, "conversation-media-choice-embedded.png");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });
await mkdir(screenshotRoot, { recursive: true });

const debugPort = 9344;
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
if (!target) throw new Error(`媒体配置选择验收页面未启动：${stderr.slice(-1000)}`);

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
const waitFor = async (expression, label, timeout = 30_000) => {
  for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}；${stderr.slice(-800)}`);
};
const captureComposerChoice = async (filename) => {
  const clip = await evaluate(`(() => {
    const stack = document.querySelector('#conversationChoicePanel')?.closest('.chat-composer-stack');
    const rect = stack?.getBoundingClientRect();
    if (!rect) return null;
    const margin = 8;
    const x = Math.max(0, rect.x - margin);
    const y = Math.max(0, rect.y - margin);
    return {
      x,
      y,
      width: Math.min(window.innerWidth - x, rect.width + margin * 2),
      height: Math.min(window.innerHeight - y, rect.height + margin * 2),
    };
  })()`);
  if (!clip) throw new Error(`无法定位选择小卡截图区域：${filename}`);
  const result = await cdp("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
  const path = join(screenshotRoot, filename);
  await writeFile(path, Buffer.from(result.data, "base64"));
  return path;
};

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#chatInput')", "应用启动");
  await evaluate(`(() => {
    localStorage.setItem('shensi:creative-start-welcome:v1', 'seen');
    const welcome = document.querySelector('#creativeStartWelcomeDialog');
    if (welcome?.open) welcome.close();
    return true;
  })()`);
  await evaluate(`document.querySelector('#projectButton').click(); true`);
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate(`document.querySelector('#newWorkspaceButton').click(); true`);
  await waitFor("document.querySelector('#textDialog')?.open", "新建媒体选择验收作品");
  await evaluate(`(() => {
    const input = document.querySelector('#textDialogInput');
    input.value = '媒体选择小卡验收作品';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#textDialogForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('媒体选择小卡验收作品')", "媒体选择验收作品创建");
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = '生成一张红色方块图片';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === false && document.querySelector('[data-choice-type=\"media_connection_profile\"]')", "对话内图片配置选择小卡");
  await delay(250);
  await evaluate(`(() => {
    const welcome = document.querySelector('#creativeStartWelcomeDialog');
    if (welcome?.open) welcome.close();
    return true;
  })()`);
  await waitFor("![...document.querySelectorAll('dialog[open]')].some((dialog) => getComputedStyle(dialog).display !== 'none')", "媒体选择截图无遮挡");
  const profileState = await evaluate(`(() => ({
    panelBeforeInput: document.querySelector('#conversationChoicePanel').getBoundingClientRect().bottom <= document.querySelector('#chatInput').getBoundingClientRect().top,
    panelInComposer: document.querySelector('#conversationChoicePanel').closest('.chat-composer-stack') != null,
    profileLabels: [...document.querySelectorAll('[data-choice-type="media_connection_profile"]')].map((button) => button.textContent.trim()),
    centralDialogCount: document.querySelectorAll('dialog.conversation-media-connection-dialog').length,
    visibleModalDialogs: [...document.querySelectorAll('dialog[open]')].filter((dialog) => getComputedStyle(dialog).display !== 'none').length,
  }))()`);
  assert.equal(profileState.panelBeforeInput, true, "媒体配置小卡必须固定在对话输入口上方");
  assert.equal(profileState.panelInComposer, true, "媒体配置小卡必须属于输入区容器");
  assert.ok(profileState.profileLabels.some((label) => /OpenAI/u.test(label)), "配置选项必须显示具体连接名称");
  assert.equal(profileState.centralDialogCount, 0, "媒体配置选择不得再创建中央 dialog");
  assert.equal(profileState.visibleModalDialogs, 0, "媒体配置选择期间不得覆盖中央模态窗口");
  const profileScreenshot = await captureComposerChoice("conversation-image-choice-1-profile.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_profile"]').click(); true`);
  await waitFor("document.querySelector('[data-choice-type=\"media_connection_model\"]')", "图片模型二次选择");
  const modelState = await evaluate(`(() => ({
    modelLabels: [...document.querySelectorAll('[data-choice-type="media_connection_model"]')].map((button) => button.textContent.trim()),
    panelBeforeInput: document.querySelector('#conversationChoicePanel').hidden || document.querySelector('#conversationChoicePanel').getBoundingClientRect().bottom <= document.querySelector('#chatInput').getBoundingClientRect().top,
  }))()`);
  assert.equal(modelState.panelBeforeInput, true, "模型二次选择仍必须位于输入口上方");
  assert.ok(modelState.modelLabels.every(Boolean), "模型选项必须显示真实模型名称");
  const modelScreenshot = await captureComposerChoice("conversation-image-choice-2-model.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_model"]').click(); true`);
  await waitFor("document.querySelector('[data-choice-type=\"media_image_aspect\"]') && document.querySelector('[data-choice-type=\"media_image_quality\"]')", "图片比例和质量选择");
  const parameterState = await evaluate(`(() => ({
    aspectLabels: [...document.querySelectorAll('[data-choice-type="media_image_aspect"]')].map((button) => button.textContent.trim()),
    qualityLabels: [...document.querySelectorAll('[data-choice-type="media_image_quality"]')].map((button) => button.textContent.trim()),
    confirmDisabled: document.querySelector('[data-choice-type="media_image_parameters_confirm"]')?.disabled === true,
    actionRightAligned: getComputedStyle(document.querySelector('.conversation-choice-actions')).justifyContent === 'flex-end',
    actionRadius: Number.parseFloat(getComputedStyle(document.querySelector('[data-choice-type="media_image_parameters_confirm"]')).borderRadius),
    optionRadius: Number.parseFloat(getComputedStyle(document.querySelector('[data-choice-type="media_image_aspect"]')).borderRadius),
    actionButtons: [...document.querySelectorAll('.conversation-choice-actions .conversation-choice-option')].map((button) => ({
      label: button.textContent.trim(),
      left: Math.round(button.getBoundingClientRect().left),
      right: Math.round(button.getBoundingClientRect().right),
      width: Math.round(button.getBoundingClientRect().width),
    })),
    panelBeforeInput: document.querySelector('#conversationChoicePanel').getBoundingClientRect().bottom <= document.querySelector('#chatInput').getBoundingClientRect().top,
  }))()`);
  assert.ok(parameterState.aspectLabels.length > 0, "第三步必须显示当前模型支持的图片比例");
  assert.ok(parameterState.qualityLabels.length > 0, "第三步必须显示当前模型支持的图片质量");
  assert.equal(parameterState.confirmDisabled, true, "比例和质量未选择完整时不得提交");
  assert.equal(parameterState.actionRightAligned, true, "确认、返回模型和取消必须位于右对齐操作区");
  assert.ok(parameterState.actionRadius < parameterState.optionRadius, "操作按钮形状必须与胶囊参数选项明显区分");
  assert.equal(parameterState.panelBeforeInput, true, "图片参数仍必须位于输入口上方");
  const parameterScreenshot = await captureComposerChoice("conversation-image-choice-3-parameters.png");
  await evaluate(`document.querySelector('[data-choice-type="media_image_aspect"]').click(); document.querySelector('[data-choice-type="media_image_quality"]').click(); true`);
  await waitFor("document.querySelector('[data-choice-type=\"media_image_parameters_confirm\"]')?.disabled === false", "图片参数选择完整");
  const selectedParameterScreenshot = await captureComposerChoice("conversation-image-choice-4-parameters-selected.png");
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(result.data, "base64"));
  await evaluate(`document.querySelector('[data-choice-type="media_connection_action"][data-choice-value="cancel"]').click(); true`);
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === true", "取消媒体配置选择");
  await waitFor("!document.querySelector('[data-immediate-instruction]')", "取消后清理正在准备状态");
  const cancelledState = await evaluate(`(() => ({
    preparingInstructions: document.querySelectorAll('[data-immediate-instruction]').length,
    runningMediaMessages: [...document.querySelectorAll('.message')].filter((message) => /正在准备.*生成任务/u.test(message.textContent)).length,
  }))()`);
  assert.equal(cancelledState.preparingInstructions, 0, "取消配置选择后不得残留正在准备指令");
  assert.equal(cancelledState.runningMediaMessages, 0, "取消配置选择后不得创建媒体任务消息");
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = '使用 OpenAI gpt-image-2 生成一张 9:16 的蓝色圆形图片';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('[data-choice-type=\"media_image_quality\"]') && !document.querySelector('[data-choice-type=\"media_image_aspect\"]')", "已明确比例时只补质量");
  const qualityOnlyScreenshot = await captureComposerChoice("conversation-image-choice-5-quality-only.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_action"][data-choice-value="cancel"]').click(); true`);
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === true", "取消只补质量选择");
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = '生成一个视频';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === false && document.querySelector('[data-choice-type=\"media_connection_profile\"]')", "对话内视频配置选择小卡");
  const videoProfileState = await evaluate(`(() => ({
    panelBeforeInput: document.querySelector('#conversationChoicePanel').getBoundingClientRect().bottom <= document.querySelector('#chatInput').getBoundingClientRect().top,
    profileLabels: [...document.querySelectorAll('[data-choice-type="media_connection_profile"]')].map((button) => button.textContent.trim()),
  }))()`);
  assert.equal(videoProfileState.panelBeforeInput, true, "视频配置小卡必须固定在对话输入口上方");
  assert.ok(videoProfileState.profileLabels.length > 0, "视频配置选择必须显示可用配置");
  const videoProfileScreenshot = await captureComposerChoice("conversation-video-choice-1-profile.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_profile"]').click(); true`);
  await waitFor("document.querySelector('[data-choice-type=\"media_connection_model\"]')", "视频模型二次选择");
  const videoModelState = await evaluate(`(() => ({
    panelBeforeInput: document.querySelector('#conversationChoicePanel').getBoundingClientRect().bottom <= document.querySelector('#chatInput').getBoundingClientRect().top,
    modelLabels: [...document.querySelectorAll('[data-choice-type="media_connection_model"]')].map((button) => button.textContent.trim()),
  }))()`);
  assert.equal(videoModelState.panelBeforeInput, true, "视频模型选择仍必须位于输入口上方");
  assert.ok(videoModelState.modelLabels.length > 0, "视频模型选择必须显示真实模型名称");
  const videoModelScreenshot = await captureComposerChoice("conversation-video-choice-2-model.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_model"]').click(); true`);
  await waitFor("document.querySelector('[data-choice-type=\"media_video_aspect\"]') && document.querySelector('[data-choice-type=\"media_video_resolution\"]') && document.querySelector('[data-choice-type=\"media_video_duration\"]')", "视频比例、清晰度和时长选择");
  const videoParameterState = await evaluate(`(() => ({
    panelBeforeInput: document.querySelector('#conversationChoicePanel').getBoundingClientRect().bottom <= document.querySelector('#chatInput').getBoundingClientRect().top,
    aspectLabels: [...document.querySelectorAll('[data-choice-type="media_video_aspect"]')].map((button) => button.textContent.trim()),
    resolutionLabels: [...document.querySelectorAll('[data-choice-type="media_video_resolution"]')].map((button) => button.textContent.trim()),
    durationLabels: [...document.querySelectorAll('[data-choice-type="media_video_duration"]')].map((button) => button.textContent.trim()),
    confirmDisabled: document.querySelector('[data-choice-type="media_video_parameters_confirm"]')?.disabled === true,
    durationHint: document.querySelector('#conversationChoiceHint')?.textContent.includes('视频时长不会保存为默认值') === true,
  }))()`);
  assert.equal(videoParameterState.panelBeforeInput, true, "视频参数选择必须位于输入口上方");
  assert.ok(videoParameterState.aspectLabels.length > 0, "视频参数必须显示当前模型支持的比例");
  assert.ok(videoParameterState.resolutionLabels.length > 0, "视频参数必须显示当前模型支持的清晰度");
  assert.ok(videoParameterState.durationLabels.length > 0, "视频生成必须显示本次时长选项");
  assert.equal(videoParameterState.confirmDisabled, true, "视频参数未选完整时不得提交");
  assert.equal(videoParameterState.durationHint, true, "视频选择卡必须明确时长不保存为默认值");
  const videoParameterScreenshot = await captureComposerChoice("conversation-video-choice-3-parameters.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_action"][data-choice-value="cancel"]').click(); true`);
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === true", "取消视频参数选择");
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = '使用 OpenAI gpt-image-2 以高清质量生成一张蓝色圆形图片';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('[data-choice-type=\"media_image_aspect\"]') && !document.querySelector('[data-choice-type=\"media_image_quality\"]')", "已明确质量时只补比例");
  const aspectOnlyScreenshot = await captureComposerChoice("conversation-image-choice-6-aspect-only.png");
  await evaluate(`document.querySelector('[data-choice-type="media_connection_action"][data-choice-value="cancel"]').click(); true`);
  console.log(JSON.stringify({
    ok: true,
    profileState,
    modelState,
    parameterState,
    cancelledState,
    screenshotPath,
    screenshots: {
      profileScreenshot,
      modelScreenshot,
      parameterScreenshot,
      selectedParameterScreenshot,
      videoProfileScreenshot,
      videoModelScreenshot,
      videoParameterScreenshot,
      qualityOnlyScreenshot,
      aspectOnlyScreenshot,
    },
  }, null, 2));
} finally {
  socket.close();
  child.kill();
  await delay(500);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
