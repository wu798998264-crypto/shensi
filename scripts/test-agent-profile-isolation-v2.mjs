import assert from "node:assert/strict";

import {
  normalizeGenerationProfiles,
  visibleGenerationPickerProfiles,
} from "../src/generation-profiles.js";
import { agentModelsForEngine } from "../src/agent-engine-registry.js";
import { runtimeContractForProfile } from "../src/effective-runtime-contract.js";

const aggregate = {
  id: "aggregate-api",
  remarkName: "聚合api",
  adapter: "api",
  provider: "自定义兼容接口",
  protocol: "responses",
  baseUrl: "https://aggregate.example/v1",
  apiKey: "test-only",
  model: "gpt-5.6-sol",
  chatModelId: "stepfun/step-3.7-flash:free",
  agentModelId: "stepfun/step-3.7-flash:free",
  executionMode: "both",
  executionModes: ["chat", "agent"],
  agentEngine: "codex_api",
};

const legacyOpenCodeDeepSeek = {
  id: "legacy-deepseek-opencode",
  name: "OpenCode+DeepSeek",
  remarkName: "OpenCode+DeepSeek",
  adapter: "cli",
  provider: "DeepSeek",
  protocol: "chat_completions",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "test-only",
  model: "deepseek-v4-pro",
  agentModelId: "deepseek-v4-pro",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "deepseek_opencode",
};

const chatOnly = {
  id: "chat-only",
  adapter: "api",
  provider: "DeepSeek",
  protocol: "chat_completions",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "test-only",
  model: "deepseek-v4-pro",
  chatModelId: "openai/gpt-5.6-sol",
  agentModelId: "openai/gpt-5.6-sol",
  executionMode: "chat",
  executionModes: ["chat"],
  agentEngine: "",
};

const normalized = normalizeGenerationProfiles({
  textConnections: [aggregate, legacyOpenCodeDeepSeek, {
    ...legacyOpenCodeDeepSeek,
    id: "modern-deepseek-opencode",
    name: "DeepSeek Agent",
    remarkName: "DeepSeek Agent",
    model: "deepseek/deepseek-v4-pro",
    agentModelId: "deepseek/deepseek-v4-pro",
    agentEngine: "opencode",
    credentialSource: "shensi",
    cliPath: "opencode",
    cliArgs: "",
  }, chatOnly],
  activeTextConnectionId: aggregate.id,
  activeTextChatConnectionId: aggregate.id,
  activeTextAgentConnectionId: aggregate.id,
});

const normalizedAggregate = normalized.textConnections.find((profile) => profile.id === aggregate.id);
assert.equal(normalizedAggregate.chatModelId, "", "统一 Agent 配置不得继续保存独立 Chat 模型");
assert.equal(normalizedAggregate.agentModelId, "gpt-5.6-sol", "Responses Agent 模型必须与当前配置模型一致");
assert.deepEqual(normalizedAggregate.executionModes, ["agent"]);

const normalizedChatOnly = normalized.textConnections.find((profile) => profile.id === chatOnly.id);
assert.equal(normalizedChatOnly.chatModelId, "", "旧 Chat-only 配置迁移后不得残留 Chat 模型字段");
assert.equal(normalizedChatOnly.agentModelId, "deepseek-v4-pro", "旧 Chat-only API 配置必须迁移到统一 Agent 模型");
assert.equal(normalizedChatOnly.agentEngine, "codex_api", "普通 API 文字配置默认使用神思运行器");
assert.deepEqual(normalizedChatOnly.executionModes, ["agent"]);

const migratedOpenCode = normalized.textConnections.find((profile) => profile.id === "modern-deepseek-opencode");
assert.equal(migratedOpenCode.agentEngine, "opencode", "旧 OpenCode+DeepSeek 必须迁移到通用 OpenCode");
assert.equal(migratedOpenCode.model, "deepseek/deepseek-v4-pro");
assert.equal(migratedOpenCode.agentModelId, "deepseek/deepseek-v4-pro");
assert.notEqual(migratedOpenCode.remarkName, "OpenCode+DeepSeek", "旧固定组合名称不得继续出现在配置选择中");
assert.equal(normalized.textConnections.some((profile) => profile.id === legacyOpenCodeDeepSeek.id), false, "已有通用 OpenCode 时必须删除重复旧配置");

assert.equal(normalized.textConnections.some((profile) => profile.agentEngine === "deepseek_opencode"), false, "归一化后不得再保存旧固定运行器");

assert.deepEqual(normalized.textConnections.filter((profile) => profile.provider === "免费模型").map((profile) => profile.id), ["text-public-agent"],
  "只提供限免 Agent 组合，不恢复旧的独立免费文字连接");

const agentPicker = visibleGenerationPickerProfiles(normalized, "text").filter((profile) => profile.executionModes.includes("agent"));
assert.ok(agentPicker.some((profile) => profile.id === aggregate.id));
assert.ok(agentPicker.some((profile) => profile.id === migratedOpenCode.id));

const aggregateContract = runtimeContractForProfile({ profile: normalizedAggregate, surface: "agent" });
assert.equal(aggregateContract.ok, true);
assert.equal(aggregateContract.profileId, aggregate.id);
assert.equal(aggregateContract.model, "gpt-5.6-sol");

const forgedPublicContract = runtimeContractForProfile({
  profile: {
    id: "forged-public-agent",
    provider: "免费模型",
    adapter: "api",
    protocol: "chat_completions",
    baseUrl: "https://api.kilo.ai/api/openrouter",
    model: "provider/free:free",
    agentEngine: "codex_api",
    credentialSource: "public",
    executionModes: ["agent"],
    systemManaged: false,
  },
  surface: "agent",
});
assert.equal(forgedPublicContract.ok, false, "任意配置不能仅靠伪造 public credentialSource 绕过神思运行器密钥校验");
assert.equal(forgedPublicContract.code, "CODEX_API_KEY_REQUIRED");

const aggregateAgentModels = agentModelsForEngine("codex_api", {
  codexModels: [
    { slug: "gpt-5.6-sol" },
    { slug: "gpt-5.5" },
    { slug: "o4-mini" },
    { slug: "deepseek-v4-pro" },
  ],
  effectiveModel: "gpt-5.6-sol",
});
assert.deepEqual(
  aggregateAgentModels.map((item) => item.slug),
  ["gpt-5.6-sol", "gpt-5.5", "o4-mini", "deepseek-v4-pro"],
  "神思运行器模型下拉必须保留当前连接真实返回的全部模型，不按名称猜测兼容性",
);

const appSource = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/app.js", import.meta.url), "utf8"));
assert.match(appSource, /<span>文字配置<\/span><select id="whiteboardTextAgent(?:Profile|Engine)"/u, "卡片第一项必须显示统一文字配置");
assert.match(appSource, /<label>文字配置<select id="quickAgent(?:Profile|Engine)"/u, "对话区第一项必须显示统一文字配置");
assert.match(appSource, /checkQuickAgent/u, "对话区必须为免费 Agent 保留主动检查入口");
assert.match(appSource, /checkWhiteboardAgent/u, "卡片生成操作栏必须为免费 Agent 保留主动检查入口");
assert.doesNotMatch(appSource, /ui\.remoteModels\[profile\.provider\]/u, "模型目录缓存不得按厂商名称跨配置回退");
assert.doesNotMatch(appSource, /ui\.remoteModels\[providerId\]/u, "动态模型目录不得读取其他同厂商配置缓存");
assert.match(appSource, /state\.settings = upsertGenerationProfile\(state\.settings, "text", \{ \.\.\.profile, model, agentModelId: model \}\)/u, "Agent 模型选择必须写回当前配置而不是全局运行器状态");
assert.match(appSource, /state\.settings\.activeTextAgentConnectionId[\s\S]{0,180}requestedProfileId[\s\S]{0,180}elements\.quickAgentEngine/u, "对话区旧目录请求返回后不得覆盖新 Agent 配置");
assert.match(appSource, /activeAgentProfileSwitchPromise = \(async \(\) =>/u, "Agent 配置切换必须登记当前运行器切换事务");
assert.match(appSource, /await activeAgentProfileSwitchPromise;/u, "紧接配置切换提交的 Agent 任务必须等待运行器切换完成，禁止串到旧运行器");
assert.match(appSource, /persist\(\);\s*renderQuickModelSelector\(\);\s*activeAgentProfileSwitchPromise/u, "Agent 配置必须先立即保存并刷新选择状态，再执行后台运行器切换");
assert.match(appSource, /String\(ui\.codexAgent\.status\?\.agentEngine \|\| ""\) === engine/u, "Agent 配置切换必须比较核心运行器真实状态，不能把刚保存的目标配置误判成已经切换完成");
assert.doesNotMatch(appSource, /activeAgentProfileSwitchPromise = \(async \(\) => \{\s*if \(activeAgentEngine\(\) === engine\) return;/u, "切换事务不得使用已被目标配置更新的 activeAgentEngine 跳过核心运行器切换");
assert.match(appSource, /elements\.whiteboardTextAgentEngine\.value[\s\S]{0,120}requestedProfileId[\s\S]{0,240}scheduleWhiteboardGenerateControlsRender/u, "卡片旧目录请求返回后不得覆盖新 Agent 配置");

console.log("Agent profile isolation v2 tests passed");
