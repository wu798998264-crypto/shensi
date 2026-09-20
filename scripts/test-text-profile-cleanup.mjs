import assert from "node:assert/strict";

import {
  cleanupLegacyTextProfiles,
  createGenerationProfile,
  normalizeGenerationProfiles,
  pruneRetiredTextProfileSecrets,
  TEXT_PROFILE_CLEANUP_VERSION,
  upsertGenerationProfile,
} from "../src/generation-profiles.js";

const profiles = [
  { id: "text-1787923302281-8ygl7", name: "聚合api", provider: "自定义兼容接口", adapter: "api", agentEngine: "codex_api", baseUrl: "http://127.0.0.1:5317/v1", model: "gpt-5.6-sol", apiKey: "aggregate-test-secret" },
  { id: "text-public-kilo", name: "免费模型", provider: "免费模型", adapter: "api", agentEngine: "codex_api" },
  { id: "text-default", name: "GPT Agent · Codex CLI", provider: "OpenAI", adapter: "cli", agentEngine: "codex", cliPath: "codex", model: "gpt-5.6-sol" },
  { id: "text-1785037658236-3q8e8", name: "DeepSeek · 神思运行器", provider: "DeepSeek", adapter: "api", agentEngine: "codex_api", apiKey: "legacy-api-secret" },
  { id: "text-claude-code-deepseek", name: "DeepSeek Agent · 可用", provider: "DeepSeek", adapter: "cli", agentEngine: "opencode", cliPath: "opencode", credentialSource: "shensi", model: "deepseek/deepseek-v4-pro", agentModelId: "deepseek/deepseek-v4-pro", apiKey: "deepseek-test-secret" },
  { id: "text-public-agent", name: "免费agent", provider: "免费模型", adapter: "api", agentEngine: "codex_api" },
  { id: "text-1785566796473-sznmo", name: "DeepSeek Agent · OpenCode", provider: "DeepSeek", adapter: "cli", agentEngine: "opencode", cliPath: "opencode", credentialSource: "opencode", model: "deepseek/deepseek-v4-pro", agentModelId: "deepseek/deepseek-v4-pro" },
];

const directCleanup = cleanupLegacyTextProfiles(profiles, {
  activeTextConnectionId: "text-1785566796473-sznmo",
  activeTextAgentConnectionId: "text-1785566796473-sznmo",
});
assert.deepEqual(directCleanup.profiles.map((profile) => profile.id), [
  "text-1787923302281-8ygl7",
  "text-default",
  "text-claude-code-deepseek",
  "text-public-agent",
]);
assert.equal(directCleanup.aliases.get("text-1785566796473-sznmo"), "text-claude-code-deepseek");
assert.equal(directCleanup.aliases.get("text-1785037658236-3q8e8"), "text-claude-code-deepseek");
const retainedDeepSeek = directCleanup.profiles.find((profile) => profile.id === "text-claude-code-deepseek");
assert.equal(retainedDeepSeek.name, "DeepSeek Agent");
assert.equal(retainedDeepSeek.remarkName, "DeepSeek Agent");
assert.equal(retainedDeepSeek.apiKey, "deepseek-test-secret", "去重不得丢失保留项凭据");

const imageSentinel = { id: "image-user-sentinel", name: "图片配置哨兵", provider: "测试媒体", adapter: "api", protocol: "images", baseUrl: "https://media.invalid/v1", model: "image-model", apiKey: "image-test-secret" };
const normalized = normalizeGenerationProfiles({
  textConnections: profiles.map(({ apiKey, ...profile }) => profile),
  imageConnections: [imageSentinel],
  activeTextConnectionId: "text-1785566796473-sznmo",
  activeTextChatConnectionId: "text-1785566796473-sznmo",
  activeTextAgentConnectionId: "text-1785566796473-sznmo",
  activeImageConnectionId: imageSentinel.id,
}, {
  text: {
    "text-1787923302281-8ygl7": "aggregate-test-secret",
    "text-1785037658236-3q8e8": "legacy-api-secret",
    "text-claude-code-deepseek": "deepseek-test-secret",
  },
  image: { [imageSentinel.id]: imageSentinel.apiKey },
});
assert.deepEqual(normalized.textConnections.map((profile) => profile.id), [
  "text-1787923302281-8ygl7",
  "text-default",
  "text-claude-code-deepseek",
  "text-public-agent",
  "text-workbuddy-cli",
]);
assert.equal(normalized.activeTextConnectionId, "text-claude-code-deepseek");
assert.equal(normalized.activeTextChatConnectionId, "text-claude-code-deepseek");
assert.equal(normalized.activeTextAgentConnectionId, "text-claude-code-deepseek");
assert.equal(normalized.textProfileCleanupVersion, TEXT_PROFILE_CLEANUP_VERSION);
const normalizedDeepSeek = normalized.textConnections.find((profile) => profile.id === "text-claude-code-deepseek");
assert.equal(normalizedDeepSeek.name, "DeepSeek Agent");
assert.equal(normalizedDeepSeek.remarkName, "DeepSeek Agent");
assert.equal(normalizedDeepSeek.apiKey, "deepseek-test-secret");
assert.equal(normalizedDeepSeek.model, "deepseek/deepseek-v4-pro", "DeepSeek 服务商不得保留 GPT 模型 ID");
assert.equal(normalizedDeepSeek.agentModelId, "deepseek/deepseek-v4-pro", "DeepSeek Agent 模型必须与服务商匹配");
const workBuddy = normalized.textConnections.find((profile) => profile.id === "text-workbuddy-cli");
assert.equal(workBuddy?.agentEngine, "workbuddy");
assert.equal(workBuddy?.systemManaged, false, "WorkBuddy 自动补入项不得被标记为灰色系统保护配置");
assert.equal(workBuddy?.model, "", "WorkBuddy 模型由实时 CLI 目录选择，默认不得写死模型");
assert.equal(workBuddy?.agentModelId, "", "WorkBuddy 默认模型不得伪造成其他运行器的模型");

const editableWorkBuddy = normalizeGenerationProfiles({
  textConnections: [{
    id: "text-workbuddy-cli",
    name: "我的 WorkBuddy",
    remarkName: "我的运行器",
    adapter: "cli",
    provider: "DeepSeek",
    protocol: "chat_completions",
    baseUrl: "https://example.invalid/v1",
    model: "deepseek/deepseek-v4-pro",
    agentModelId: "deepseek/deepseek-v4-pro",
    agentEngine: "opencode",
    credentialSource: "opencode",
    cliPath: "my-opencode",
    cliArgs: "run {prompt} --model {model}",
  }],
});
const preservedWorkBuddy = editableWorkBuddy.textConnections.find((profile) => profile.id === "text-workbuddy-cli");
assert.equal(preservedWorkBuddy?.name, "我的 WorkBuddy");
assert.equal(preservedWorkBuddy?.remarkName, "我的运行器");
assert.equal(preservedWorkBuddy?.agentEngine, "opencode", "手动切换运行器后不得被归一化回 WorkBuddy");
assert.equal(preservedWorkBuddy?.provider, "DeepSeek");
assert.equal(preservedWorkBuddy?.model, "deepseek/deepseek-v4-pro");
assert.equal(preservedWorkBuddy?.cliPath, "my-opencode");
assert.equal(preservedWorkBuddy?.systemManaged, false);
const savedEditableWorkBuddy = upsertGenerationProfile(editableWorkBuddy, "text", preservedWorkBuddy, { activate: true });
const savedWorkBuddy = savedEditableWorkBuddy.textConnections.find((profile) => profile.id === "text-workbuddy-cli");
assert.equal(savedWorkBuddy?.agentEngine, "opencode", "保存 WorkBuddy 条目时不得重新写回 WorkBuddy 运行器");
assert.equal(savedWorkBuddy?.cliPath, "my-opencode", "保存 WorkBuddy 条目时必须保留用户的 CLI 路径");

const textDraft = createGenerationProfile("text", { draft: true });
assert.equal(textDraft.temperature, "0.7", "新建文字配置应提供安全温度默认值");
assert.equal(textDraft.maxOutputTokens, "4000", "新建文字配置应提供安全输出上限默认值");
assert.equal(textDraft.timeoutMs, "120000", "新建文字配置应提供安全超时默认值");
assert.equal(textDraft.provider, "", "新建文字配置仍应由用户选择服务商");
assert.equal(textDraft.model, "", "新建文字配置仍不应伪造模型");
const preservedImage = normalized.imageConnections.find((profile) => profile.id === imageSentinel.id);
assert.equal(preservedImage?.name, imageSentinel.name);
assert.equal(preservedImage?.baseUrl, imageSentinel.baseUrl);
assert.equal(preservedImage?.model, imageSentinel.model);
assert.equal(preservedImage?.apiKey, imageSentinel.apiKey, "文字配置迁移不得改动媒体凭据");

const prunedSecrets = pruneRetiredTextProfileSecrets({
  text: {
    "text-1787923302281-8ygl7": "aggregate-test-secret",
    "text-1785037658236-3q8e8": "legacy-api-secret",
    "text-claude-code-deepseek": "deepseek-test-secret",
    "text-1785566796473-sznmo": "duplicate-secret",
    "text-public-kilo": "unexpected-public-secret",
  },
  image: { "image-protected": "protected-image-secret" },
  video: { "video-protected": "protected-video-secret" },
}, normalized);
assert.deepEqual(Object.keys(prunedSecrets.text).sort(), ["text-1785037658236-3q8e8", "text-1785566796473-sznmo", "text-1787923302281-8ygl7", "text-claude-code-deepseek", "text-public-kilo"]);
assert.equal(prunedSecrets.image["image-protected"], "protected-image-secret");
assert.equal(prunedSecrets.video["video-protected"], "protected-video-secret");

const fresh = normalizeGenerationProfiles({});
assert.equal(fresh.textConnections.some((profile) => profile.id === "text-public-agent"), true);
assert.equal(fresh.activeTextConnectionId, "text-public-agent");

console.log("Text profile cleanup contracts passed");
