import assert from "node:assert/strict";
import {
  activateGenerationProfile,
  mergeGenerationProfileDraftsById,
  normalizeGenerationProfiles,
  upsertGenerationProfile,
} from "../src/generation-profiles.js";

const original = {
  activeTextConnectionId: "text-default",
  textConnections: [
    { id: "text-default", provider: "OpenAI", adapter: "cli", model: "gpt-5.6-sol", executionModes: ["chat", "agent"], agentEngine: "codex", customExtension: { keep: true } },
    { id: "deepseek-api", provider: "DeepSeek", adapter: "api", model: "deepseek-v4-pro", executionMode: "chat", customExtension: { keep: "untouched" } },
  ],
};
const draft = normalizeGenerationProfiles({ ...original, textConnections: original.textConnections.map((item) => ({ ...item })) });
const merged = mergeGenerationProfileDraftsById(original, draft);
assert.equal(merged.textConnections[0], original.textConnections[0], "untouched profile must retain its exact stored object");
assert.equal(merged.textConnections[1], original.textConnections[1], "unknown fields must not require whole-file normalization");
assert.equal(merged.textConnections.find((item) => item.id === "text-default").customExtension.keep, true);
assert.equal(merged.textConnections.find((item) => item.id === "deepseek-api").customExtension.keep, "untouched");
assert.equal(merged.activeTextConnectionId, "text-default");

const aggregateProfile = {
  id: "aggregate-api",
  provider: "自定义兼容接口",
  adapter: "api",
  protocol: "responses",
  baseUrl: "http://127.0.0.1:5317/v1",
  model: "gpt-5.6-sol",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "codex_api",
};
const activationBaseline = normalizeGenerationProfiles({
  ...original,
  activeTextConnectionId: "text-default",
  activeTextChatConnectionId: "text-default",
  activeTextAgentConnectionId: "text-default",
  textConnections: [...original.textConnections, aggregateProfile],
});
const activated = activateGenerationProfile(activationBaseline, "text", aggregateProfile.id);
assert.equal(activated.activeTextConnectionId, aggregateProfile.id);
assert.equal(activated.activeTextAgentConnectionId, aggregateProfile.id);
assert.equal(activated.provider, aggregateProfile.provider);
assert.equal(activated.model, aggregateProfile.model);
assert.equal(normalizeGenerationProfiles(activated).activeTextAgentConnectionId, aggregateProfile.id,
  "normalization must not restore the previously active Agent profile after a settings selection");

const createdAndActivated = upsertGenerationProfile(activationBaseline, "text", {
  ...aggregateProfile,
  id: "new-aggregate-api",
}, { activate: true });
assert.equal(createdAndActivated.activeTextConnectionId, "new-aggregate-api");
assert.equal(createdAndActivated.activeTextAgentConnectionId, "new-aggregate-api");
console.log("Generation config no-rewrite preservation tests passed");
