import assert from "node:assert/strict";

import {
  cleanupLegacyTextProfiles,
  normalizeGenerationProfiles,
  pruneRetiredTextProfileSecrets,
  TEXT_PROFILE_CLEANUP_VERSION,
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
]);
assert.equal(normalized.activeTextConnectionId, "text-claude-code-deepseek");
assert.equal(normalized.activeTextChatConnectionId, "text-claude-code-deepseek");
assert.equal(normalized.activeTextAgentConnectionId, "text-claude-code-deepseek");
assert.equal(normalized.textProfileCleanupVersion, TEXT_PROFILE_CLEANUP_VERSION);
const normalizedDeepSeek = normalized.textConnections.find((profile) => profile.id === "text-claude-code-deepseek");
assert.equal(normalizedDeepSeek.name, "DeepSeek Agent");
assert.equal(normalizedDeepSeek.remarkName, "DeepSeek Agent");
assert.equal(normalizedDeepSeek.apiKey, "deepseek-test-secret");
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
