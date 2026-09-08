import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCanvas, replaceCanvasNodeContent } from "../src/whiteboard.js";
import { publicGenerationJob } from "../src/server/generation-job-store.mjs";

const canvas = normalizeCanvas({
  nodes: [{ id: "card-1", kind: "text", type: "text", text: "", x: 0, y: 0, width: 260, height: 160 }],
  edges: [],
});

const generated = replaceCanvasNodeContent(canvas, "card-1", {
  kind: "generated",
  text: "正文",
  prompt: "续写",
  generationProfile: {
    executionSurface: "agent",
    agentConnectionId: "text-free-agent",
    agentModel: "free/model-a",
    apiKey: "must-not-persist",
  },
});
assert.deepEqual(generated.nodes[0].generation.profile, {
  executionSurface: "agent",
  agentConnectionId: "text-free-agent",
  agentModel: "free/model-a",
}, "卡片只应持久化最近生成配置的非敏感字段");

const publicJob = publicGenerationJob({
  id: "generation-profile-scrub",
  mode: "server",
  channel: "image",
  status: "queued",
  request: {
    generationProfile: {
      connectionId: "aggregate",
      model: "model-x",
      apiKey: "must-not-persist",
      profileHome: "C:/private",
    },
  },
});
assert.deepEqual(publicJob.request.generationProfile, {
  connectionId: "aggregate",
  model: "model-x",
  speedMode: "default",
  agentSpeedMode: "default",
}, "任务公开回读也只能保留配置/模型元数据");
const legacyJob = publicGenerationJob({
  id: "generation-legacy-profile",
  mode: "server",
  channel: "image",
  status: "queued",
  request: { settings: { connectionId: "legacy-connection", model: "legacy-model" } },
});
assert.deepEqual(legacyJob.request.generationProfile, {}, "旧任务没有配置元数据时必须保留为空，允许沿用连接/模型回退");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const oauth = await readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8");

assert.match(app, /whiteboardGenerationProfileForNode\(node, "text"\)/u, "文字卡片应恢复最近成功配置");
assert.match(app, /const whiteboardProgressTarget = \(candidate = \{\}\) => whiteboardGenerationProgressTarget\(candidate\)/u, "图片/视频卡片进度显示必须调用公共目标计算函数");
assert.match(app, /syncWhiteboardImageModelOptions\(String\(draftValues\?\.model \|\| cardValues\.model \|\| rememberedValues\.model/u, "图片卡片应用草稿后必须重新建立模型列表");
assert.match(app, /syncWhiteboardVideoModelOptions\([\s\S]{0,220}draftValues\?\.model \|\| cardValues\.model \|\| rememberedValues\.model/u, "视频卡片应用草稿后必须重新建立模型列表");
assert.match(app, /generationProfile: whiteboardGenerationProfileFromSettings\(imageSettings, "chat"\)/u, "图片任务必须携带当前卡片的脱敏配置元数据");
assert.match(app, /generationProfile: whiteboardGenerationProfileFromSettings\(videoSettings, "chat"\)/u, "视频任务必须携带当前卡片的脱敏配置元数据");
assert.match(await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8"), /generationProfile: publicGenerationProfile\(request\.generationProfile\)/u, "服务端任务记录必须保留脱敏配置元数据");
assert.match(app, /refreshDreaminaAccountStatus\(\{ verifyLive: false, profileId, channel \}\)/u, "已核验账号提交前只应读取持久身份与凭据指纹");
assert.match(app, /if \(account\?\.state !== "verified" && !hadReusableEvidence\)/u, "只有账号身份未核验且没有持久核验证据时才在线核验");
assert.match(app, /credentialChanged: false/u, "OAuth 完成必须立即清除旧的凭据变化标记");
assert.match(oauth, /A changed file hash is therefore not proof/u, "CLI 刷新 auth.reg 不得直接判定账号失效");
assert.match(app, /filter\(mediaRecoveryJobIsActionable\)/u, "待处理列表必须隐藏不可操作历史任务");
assert.match(app, /previousScrollTop[\s\S]{0,2600}scrollTop = Math\.min\(previousScrollTop/u, "待处理任务刷新后必须保持滚动位置");
assert.match(app, /data-media-recovery-action="verify"/u, "需要重新核验的待处理任务必须提供明确操作按钮");

console.log("whiteboard profile, Dreamina verification reuse, and recovery queue regressions passed");
