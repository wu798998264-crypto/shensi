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
assert.match(
  app,
  /const activeProfile = activeGenerationProfile\(generationWorkingSettings\(\), "text"\);[\s\S]{0,500}agentEngineForProfile\(activeProfile \|\| \{\}\) === selectedEngine \? activeProfile : null/u,
  "WorkBuddy 模型选择器不得借用其他文字运行器的当前模型",
);
assert.match(app, /if \(ui\.agentRunnerStatusPromise\) return ui\.agentRunnerStatusPromise;/u, "并发的运行器刷新必须复用同一次真实 CLI 探测");
assert.match(app, /const runnerInstalled = externalRunnerCapability\?\.installed \?\? status\.installed;/u, "外置运行器状态必须采用实时探测结果，不能残留旧 Agent 状态误报未安装");
assert.match(
  app,
  /if \(engine === "workbuddy"\)[\s\S]{0,900}hydrateAgentRunnerStatuses\(\{ force: force \|\| !catalogReady \}\)[\s\S]{0,500}capability\?\.models/u,
  "快捷切换到 WorkBuddy 时必须真实刷新运行器模型目录，不能只留下空模型占位",
);
assert.match(app, /hydrateAgentProfileModelCatalog\(profile\)[\s\S]{0,300}renderQuickModelSelector\(\);[\s\S]{0,120}renderCodexAgentPanel\(\);/u, "外置运行器探测完成后必须同步刷新状态提示，不能保留未安装误报");
assert.match(
  app,
  /const profileModel = agentEngineForProfile\(profile \|\| \{\}\) === selectedRunnerId[\s\S]{0,350}preferredModel: profileModel/u,
  "WorkBuddy 刷新完成后不得重新注入其他运行器的模型",
);
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
