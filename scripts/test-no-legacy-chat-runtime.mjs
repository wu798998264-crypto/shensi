import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { executionModeCapabilities } from "../src/model-execution-capabilities.js";

const [app, server, runtime, profiles, skillRoute] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-runtime-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/generation-profiles.js", import.meta.url), "utf8"),
  readFile(new URL("../src/skill-routing.js", import.meta.url), "utf8"),
]);

for (const [name, source] of [["app", app], ["server", server], ["runtime", runtime], ["profiles", profiles], ["skill route", skillRoute]]) {
  assert.doesNotMatch(source, /api\/chat|activeChatRuns|GENERAL_CHAT_SYSTEM|chatSkillFallbackPolicy|withChatModelCapabilityFallback|activateTextExecutionModeProfile|CODEX_CHAT_MODE_LABEL|SETTINGS_BOTH_MODE_LABEL/u, `${name} 仍包含旧 Chat 执行入口`);
}
assert.match(server, /pathname === "\/api\/agent\/execute"/u);
assert.doesNotMatch(server, /pathname === "\/api\/chat"/u);
assert.deepEqual(executionModeCapabilities().modes, ["agent"]);
const migrated = normalizeGenerationProfiles({
  activeTextChatConnectionId: "old-selected",
  textConnections: [{ id: "old-selected", provider: "自定义兼容接口", adapter: "api", protocol: "responses", baseUrl: "https://example.invalid/v1", model: "model-x", executionModes: ["chat"] }],
});
assert.equal(migrated.activeTextAgentConnectionId, "old-selected", "旧配置只允许作为一次性数据迁移输入");
assert.equal(Object.hasOwn(migrated, "activeTextChatConnectionId"), false, "旧 Chat 指针不得继续写入运行配置");
assert.deepEqual(migrated.textConnections[0].executionModes, ["agent"]);
console.log("Legacy Chat runtime cleanup contracts passed");
