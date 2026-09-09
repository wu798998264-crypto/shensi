import assert from "node:assert/strict";
import { normalizeGenerationProfiles, cleanupLegacyTextProfiles, pruneRetiredTextProfileSecrets, generationProfileLabel, activeGenerationProfile } from "../src/generation-profiles.js";
import { getProviderPreset } from "../src/model-presets.js";

const defaults = normalizeGenerationProfiles({});
assert.equal(defaults.activeTextConnectionId, "text-public-agent");
const limited = defaults.textConnections.find((profile) => profile.id === "text-public-agent");
assert.equal(generationProfileLabel(limited), "免费模型");
assert.equal(limited.agentEngine, "codex_api");
assert.equal(limited.model, getProviderPreset("免费模型").api.model);
assert.equal(getProviderPreset("免费模型").label, "限免模型");

const deepseek = (id, engine) => ({ id, name: "DeepSeek Agent · CLI · duplicate", remarkName: "DeepSeek Agent · CLI · duplicate", adapter: "cli", provider: "DeepSeek", agentEngine: engine, model: engine === "opencode" ? "deepseek/deepseek-v4-pro" : "deepseek-v4-pro", cliPath: engine === "opencode" ? "opencode" : "claude", credentialSource: "shensi", apiKey: `mock-${id}`, baseUrl: "https://deepseek.invalid/v1", executionModes: ["agent"] });
const active = deepseek("active-deepseek", "claude_code");
const duplicate = deepseek("duplicate-deepseek", "opencode");
const standalone = { id: "standalone-shensi", name: "神思运行器", remarkName: "神思运行器", adapter: "api", agentEngine: "codex_api", provider: "自定义兼容接口", model: "keep-real-model", baseUrl: "https://example.invalid/v1", protocol: "responses", apiKey: "mock-key" };
const profiles = [duplicate, active, standalone, limited];
const cleanup = cleanupLegacyTextProfiles(profiles, { activeTextAgentConnectionId: active.id });
assert.deepEqual(cleanup.profiles.map((profile) => profile.id), [active.id, limited.id]);
assert.equal(cleanup.profiles[0].remarkName, "DeepSeek Agent");
for (const key of ["apiKey", "baseUrl", "model", "agentEngine", "cliPath"]) assert.equal(cleanup.profiles[0][key], active[key]);
assert.equal(cleanup.aliases.get(duplicate.id), active.id);
assert.equal(cleanup.aliases.get(standalone.id), limited.id);

const before = { ...defaults, textConnections: profiles, activeTextConnectionId: active.id, activeTextAgentConnectionId: active.id };
const after = normalizeGenerationProfiles(before);
assert.equal(after.activeTextAgentConnectionId, active.id);
for (const channel of ["image", "video", "audio"]) {
  assert.deepEqual(after[`${channel}Connections`], before[`${channel}Connections`]);
  assert.equal(after[`active${channel[0].toUpperCase()}${channel.slice(1)}ConnectionId`], before[`active${channel[0].toUpperCase()}${channel.slice(1)}ConnectionId`]);
}
assert.deepEqual(after.retiredTextProfileBackup.map((profile) => profile.id), [duplicate.id, standalone.id]);
assert.ok(after.retiredTextProfileBackup.every((profile) => !("apiKey" in profile)));
assert.deepEqual(normalizeGenerationProfiles(after), after, "normalization must be idempotent");
assert.equal(activeGenerationProfile(after, "text", duplicate.id).id, active.id);
assert.equal(activeGenerationProfile(after, "text", standalone.id).id, limited.id);
assert.equal(activeGenerationProfile(after, "text", "unknown-id"), null);
const secrets = { text: { "text-public-kilo": "mock-legacy-secret" }, image: { account: "mock-protected-secret" } };
assert.deepEqual(pruneRetiredTextProfileSecrets(secrets, after), secrets);
const customPublic = { ...limited, baseUrl: "https://public.invalid/v1", model: "existing-model", apiKey: "mock-existing" };
const preserved = normalizeGenerationProfiles({ ...defaults, textConnections: [customPublic] }).textConnections.find((profile) => profile.id === limited.id);
assert.equal(preserved.baseUrl, customPublic.baseUrl);
assert.equal(preserved.model, customPublic.model);
assert.equal(preserved.apiKey, customPublic.apiKey);
console.log("Agent upgrade profiles: default, labels, deduplication, recovery, media isolation and credentials passed");
