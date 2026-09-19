import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const [app, server, runtimeStore, profiles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-runtime-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/generation-profiles.js", import.meta.url), "utf8"),
]);

for (const option of [
  '<option value="workbuddy">WorkBuddy</option>',
  '<option value="custom">自定义运行器</option>',
]) assert.match(app, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
assert.doesNotMatch(app, /<option value="trae_work">/u);
assert.doesNotMatch(app, /Trae Work/u);
assert.match(app, /runnerId === "custom"[\s\S]{0,220}手动配置/u);
assert.match(server, /runExternalCliAgent/u);
assert.match(server, /resolveExternalCliAgentSettings/u);
assert.match(runtimeStore, /EXTERNAL_CLI_AGENT_ENGINES/u);
assert.match(runtimeStore, /外置 Agent 缺少 CLI 程序路径/u);
assert.match(profiles, /agentEngine: String\(profile\.agentEngine/u);
assert.match(profiles, /externalCliAgent/u);

const migrated = normalizeGenerationProfiles({
  activeTextConnectionId: "legacy-trae",
  activeTextAgentConnectionId: "legacy-trae",
  textConnections: [{
    id: "legacy-trae",
    name: "Trae Work",
    provider: "",
    adapter: "cli",
    agentEngine: "trae_work",
  }],
  retiredTextProfileBackup: [{ id: "legacy-trae-backup", agentEngine: "trae_work" }],
});
assert.equal(migrated.textConnections.some((profile) => profile.agentEngine === "trae_work"), false);
assert.equal(migrated.retiredTextProfileBackup.some((profile) => profile.agentEngine === "trae_work"), false);
assert.notEqual(migrated.activeTextAgentConnectionId, "legacy-trae");

console.log(JSON.stringify({ ok: true, runners: ["workbuddy", "custom"], retiredRunners: ["trae_work"], mode: "agent-only" }, null, 2));
