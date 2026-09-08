import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-choice-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const artifactRoot = join(root, "artifacts");
const screenshotPath = join(artifactRoot, "conversation-choice-embedded.png");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

const debugPort = 9343;
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
if (!target) throw new Error(`候选选框验收页面未启动：${stderr.slice(-1000)}`);

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

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#chatInput')", "应用启动");
  await evaluate(`if (document.querySelector('#creativeStartWelcomeDialog')?.open) document.querySelector('#dismissCreativeStartWelcome')?.click(); true`);
  await evaluate(`document.querySelector('#projectButton').click(); true`);
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate(`document.querySelector('#newWorkspaceButton').click(); true`);
  await waitFor("document.querySelector('#textDialog')?.open", "新建候选验收作品");
  await evaluate(`(() => {
    const input = document.querySelector('#textDialogInput');
    input.value = '候选选框验收作品';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#textDialogForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('候选选框验收作品')", "候选验收作品创建");
  await evaluate(`(() => {
    const select = document.querySelector('#quickTextConnection');
    const option = [...select.options].find((item) => item.value !== '__detected_codex_cli__' && !/Codex CLI|OpenAI CLI/u.test(item.textContent));
    if (option) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return option?.textContent || '';
  })()`);
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = '为当前文档生成3份候选稿';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#conversationChoicePanel')?.hidden === false", "候选方式选框");
  const state = await evaluate(`(() => ({
    question: document.querySelector('#conversationChoiceQuestion')?.textContent.trim(),
    questionHidden: getComputedStyle(document.querySelector('#conversationChoiceQuestion')).display === 'none',
    hint: document.querySelector('#conversationChoiceHint')?.textContent.trim(),
    options: [...document.querySelectorAll('#conversationChoiceOptions button')].map((item) => item.querySelector('strong')?.textContent.trim() || ''),
    optionDetails: [...document.querySelectorAll('#conversationChoiceOptions button')].map((item) => item.querySelector('small:not(.conversation-choice-option-status)')?.textContent.trim() || ''),
    panelBeforeInput: document.querySelector('#conversationChoicePanel')?.getBoundingClientRect().bottom <= document.querySelector('#chatInput')?.getBoundingClientRect().top,
    panelInComposer: document.querySelector('#conversationChoicePanel')?.closest('.chat-composer-stack') != null,
    firstOptionHeight: document.querySelector('#conversationChoiceOptions button')?.getBoundingClientRect().height,
    firstOptionTitle: document.querySelector('#conversationChoiceOptions button')?.getAttribute('title'),
    questionInConversation: document.querySelector('#chatFeed')?.innerText.includes('先选择主笔数量') === true,
    userInstructionInConversation: document.querySelector('#chatFeed')?.innerText.includes('为当前文档生成3份候选稿') === true,
    closeButtonCount: document.querySelectorAll('#conversationChoicePanel [data-close], #conversationChoicePanel .close-button').length,
  }))()`);
  assert.equal(state.question, "先选择主笔数量");
  assert.equal(state.questionHidden, true, "问题已经写入聊天记录，选项栏不得重复显示问题");
  assert.equal(state.hint, "其他要求可以直接在下方对话框中输入。", "选项栏只能保留统一的手动输入提示");
  assert.deepEqual(state.options, ["单主笔生成多稿", "多主笔生成候选"]);
  assert.deepEqual(state.optionDetails, ["沿用当前主笔，比较不同差异方向", "从当前可用主笔中选择并分别生成"]);
  assert.equal(state.panelBeforeInput, true, "选框必须位于对话输入口上方");
  assert.equal(state.panelInComposer, true, "选框必须属于输入区容器，不能占据聊天框顶部");
  assert.ok(state.firstOptionHeight <= 32, `选项必须使用紧凑按钮，不得显示为大方格：${state.firstOptionHeight}`);
  assert.equal(state.firstOptionTitle, null, "选项不得通过悬停文案暴露底层流程说明");
  assert.equal(state.questionInConversation, true, "神思提出的问题必须进入对话记录");
  assert.equal(state.userInstructionInConversation, true, "用户原始候选请求必须进入对话记录");
  assert.equal(state.closeButtonCount, 0, "对话内选框不得额外提供关闭按钮");
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(result.data, "base64"));
  console.log(JSON.stringify({ ok: true, state, screenshotPath }, null, 2));
} finally {
  socket.close();
  child.kill();
  await delay(500);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
