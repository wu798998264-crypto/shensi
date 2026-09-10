import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, server, runtimeStore, profiles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-runtime-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/generation-profiles.js", import.meta.url), "utf8"),
]);

for (const option of [
  '<option value="trae_work">Trae Work</option>',
  '<option value="workbuddy">WorkBuddy</option>',
  '<option value="custom">自定义运行器</option>',
]) assert.match(app, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
assert.match(app, /EXTERNAL_AGENT_RUNNER_IDS[\s\S]{0,300}trae_work/u);
assert.match(app, /runnerId === "custom"[\s\S]{0,220}手动配置/u);
assert.match(server, /runExternalCliAgent/u);
assert.match(server, /resolveExternalCliAgentSettings/u);
assert.match(runtimeStore, /EXTERNAL_CLI_AGENT_ENGINES/u);
assert.match(runtimeStore, /外置 Agent 缺少 CLI 程序路径/u);
assert.match(profiles, /agentEngine: String\(profile\.agentEngine/u);
assert.match(profiles, /externalCliAgent/u);

console.log(JSON.stringify({ ok: true, runners: ["trae_work", "workbuddy", "custom"], mode: "agent-only" }, null, 2));
