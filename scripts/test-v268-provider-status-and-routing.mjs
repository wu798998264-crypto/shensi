import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args, env) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", rejectRun);
  child.on("close", (code) => code === 0 ? resolveRun(JSON.parse(stdout.trim())) : rejectRun(new Error(stderr || stdout || `exit ${code}`)));
});

const settings = normalizeGenerationProfiles({
  textConnections: [
    { id: "chat-openai-a", provider: "OpenAI", adapter: "api", model: "gpt-5.6-sol", executionMode: "chat", remarkName: "账号 A" },
    { id: "chat-openai-b", provider: "OpenAI", adapter: "api", model: "gpt-5.6-terra", executionMode: "chat", remarkName: "账号 B" },
    { id: "agent-codex-a", provider: "OpenAI", adapter: "cli", model: "gpt-5.6-sol", executionModes: ["agent"], agentEngine: "codex", runtimeProfileId: "codex-a" },
    { id: "agent-deepseek-a", provider: "DeepSeek", adapter: "cli", model: "deepseek-v4-pro", executionMode: "agent", agentEngine: "deepseek_opencode" },
    { id: "agent-opencode-a", provider: "自定义兼容接口", adapter: "cli", model: "anthropic/claude-sonnet", agentModelId: "anthropic/claude-sonnet", executionMode: "agent", agentEngine: "opencode" },
  ],
  imageConnections: [{ id: "dreamina-image", provider: "即梦", adapter: "cli", model: "gpt-image-2" }],
  videoConnections: [{ id: "dreamina-video", provider: "即梦", adapter: "cli", model: "sora-2" }],
});
assert.equal(settings.textConnections.filter((item) => item.remarkName === "账号 A" || item.remarkName === "账号 B").length, 2, "同厂商多个文字 Agent 配置必须并存");
assert.equal(settings.textConnections.find((item) => item.id === "agent-codex-a")?.runtimeProfileId, "codex-a", "Agent 账号隔离标识必须保留");
const migratedDeepSeekAgent = settings.textConnections.find((item) => item.id === "agent-deepseek-a");
assert.deepEqual(migratedDeepSeekAgent?.executionModes, ["agent"]);
assert.equal(migratedDeepSeekAgent?.agentEngine, "opencode");
assert.equal(migratedDeepSeekAgent?.model, "deepseek/deepseek-v4-pro");
assert.deepEqual(settings.textConnections.find((item) => item.id === "agent-opencode-a")?.executionModes, ["agent"]);
assert.equal(settings.textConnections.find((item) => item.id === "agent-opencode-a")?.agentModelId, "anthropic/claude-sonnet");
assert.notEqual(settings.imageConnections.find((item) => item.id === "dreamina-image")?.model, "gpt-image-2", "GPT 图片模型不得泄漏到即梦配置");
assert.notEqual(settings.videoConnections.find((item) => item.id === "dreamina-video")?.model, "sora-2", "Sora 模型不得泄漏到即梦配置");

const temporary = await mkdtemp(join(tmpdir(), "shensi-v268-status-"));
try {
  const promptPath = join(temporary, "prompt.txt");
  await writeFile(promptPath, "状态恢复测试", "utf8");
  for (const [script, taskType, progressField, progressValue, expectedProgress] of [
    [join(root, "src", "cli", "dreamina-image-cli.mjs"), "text2image", "progress_percent", "37.5", 37.5],
    [join(root, "src", "cli", "dreamina-video-cli.mjs"), "seedance2.0", "progress", "0.42", 42],
  ]) {
    const payload = await run(script, ["reconcile", "--prompt-file", promptPath, "--task-type", taskType], {
      ...process.env,
      SHENSI_DREAMINA_PROFILE_ID: "default",
      SHENSI_DREAMINA_EXECUTABLE: process.execPath,
      SHENSI_DREAMINA_PREFIX_ARGS: JSON.stringify([join(root, "scripts", "fixtures", "fake-dreamina-submit-status.mjs")]),
      SHENSI_MEDIA_PROVIDER_STATE_ROOT: join(temporary, taskType),
      SHENSI_TEST_DREAMINA_PROMPT: "状态恢复测试",
      SHENSI_TEST_DREAMINA_TASK_TYPE: taskType,
      SHENSI_TEST_DREAMINA_PROGRESS_FIELD: progressField,
      SHENSI_TEST_DREAMINA_PROGRESS_VALUE: progressValue,
    });
    assert.equal(payload.providerStatus, "running", `${taskType} 的 submit 外层状态不能误判失败`);
    assert.equal(payload.providerTaskId, "fixture-task-1");
    assert.equal(payload.progressPercent, expectedProgress, `${taskType} 必须透传即梦返回的真实进度百分比`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const appSource = await readFile(join(root, "src", "app.js"), "utf8");
const dreaminaFailureSource = await readFile(join(root, "src", "dreamina-failure.js"), "utf8");
assert.doesNotMatch(appSource, /durableJob\.status === "complete" \? "failed"/u, "厂商已完成任务不能因本地应用失败改写成失败");
assert.match(appSource, /completedWhiteboardApplyPendingJob/u, "厂商完成与本地应用状态必须分层");
assert.doesNotMatch(appSource, /requestMediaProviderTaskId/u, "找回不应要求用户填写无法获知的厂商任务 ID");
assert.match(appSource, /autoReconcileProviderTask/u, "找回应使用保存的幂等键和任务元数据自动核对");
assert.doesNotMatch(appSource, /window\.prompt\([^\n]*即梦后台/u, "Electron 找回流程不得调用不受支持的 window.prompt");
assert.doesNotMatch(appSource, /textGenerationProfilesForMode\("chat"\)/u, "取消用户可见 Chat 后不得重新建立独立 Chat 配置线路");
assert.match(appSource, /textGenerationProfilesForAgent\(\)/u, "统一 Agent 必须使用可扩展的文字配置选择线路");
assert.match(appSource, /patch\.agentEngine === "opencode"/u, "通用 OpenCode 必须只按显式 agentEngine 路由");
assert.match(appSource, /protectUnconfirmedOpenCodeActivation/u, "未确认的新 OpenCode 配置不得替换当前配置");
assert.match(appSource, /WHITEBOARD_PROMPT_CLIPBOARD_TYPE/u, "四类生成栏必须共享富提示词剪贴板协议");
assert.match(appSource, /\[elements\.whiteboardGenerateForm, elements\.whiteboardImageForm, elements\.whiteboardVideoForm, elements\.whiteboardAudioForm\]/u, "文字、图片、视频和音频生成栏必须接入同一复制粘贴链路");
assert.match(appSource, /addCanvasEdge\(documentState\.canvas, \{ fromNode: node\.id, toNode: target\.id \}\)/u, "跨生成栏粘贴图片引用时必须连接到新目标，不能只留下失效文字 token");
assert.match(appSource, /粘贴生成提示词与图片参考/u, "提示词图片引用接入应产生可撤销白板历史");

assert.match(appSource, /probeHasAuthoritativeCatalogue/u, "A failed credential probe must not erase the provider video model catalogue");
assert.match(appSource, /if \(probe\.connected !== true && probe\.available !== true\) return null;/u, "Login, credit and transient probe failures must leave media model selectors populated");
assert.match(dreaminaFailureSource, /CREDITPREDEDUCTNOTENOUGH/u, "Dreamina credit failures must remain classified as insufficient credit instead of login failures");
assert.match(appSource, /dreaminaFailureDisplayText/u, "Dreamina named-profile errors must use the shared structured failure display");
assert.match(appSource, /candidate\.providerProgressPercent/u, "白板卡片必须绑定厂商返回的真实进度百分比");
assert.match(appSource, /hasProviderProgress[\s\S]*?progressPercent: nextProgress/u, "对话媒体卡片必须优先使用厂商进度百分比");
assert.match(appSource, /whiteboardGenerationProgressTarget/u, "白板媒体进度必须使用可测试的统一目标计算规则");
assert.match(appSource, /visibleGenerationProgress = Boolean\(candidate && whiteboardGenerationProgressActive\(candidate\) && whiteboardProgressTarget\(candidate\) !== null\)/u, "只有真正生成阶段才显示进度；连接与厂商排队阶段只显示状态和总耗时");
assert.match(appSource, /displayProviderProgressPercent/u, "白板媒体显示进度应与厂商事实值分层，允许平滑追赶但不能改写事实值");

console.log("v2.6.8 provider isolation, media status, recovery dialog and text routing tests passed");
