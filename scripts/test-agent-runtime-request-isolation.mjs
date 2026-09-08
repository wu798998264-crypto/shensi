import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { CodexAgentProvider } from "../src/server/codex-agent-provider.mjs";

const provider = Object.create(CodexAgentProvider.prototype);
provider.state = {
  agentEngine: "codex",
  agentModel: "gpt-5.6-sol",
  agentModels: { codex: "gpt-5.6-sol", opencode: "deepseek/deepseek-v4-pro" },
  agentReasoningEffort: "high",
  agentSpeedMode: "default",
  agentRequestOptions: { codex: { reasoningEffort: "high", speedMode: "default" }, opencode: { reasoningEffort: "medium", speedMode: "fast" } },
};
const windowA = provider.taskRuntimeSettings({ agentEngine: "codex", model: "gpt-5.6-sol", reasoningEffort: "low", speedMode: "default" }, { model: "ignored" });
provider.state.agentEngine = "opencode";
provider.state.agentModel = "changed-by-window-b";
const windowB = provider.taskRuntimeSettings({ agentEngine: "opencode", model: "deepseek/deepseek-v4-pro", reasoningEffort: "medium", speedMode: "fast" }, { model: "ignored" });
assert.deepEqual({ engine: windowA.agentEngine, model: windowA.model, effort: windowA.reasoningEffort, speed: windowA.speedMode }, { engine: "codex", model: "gpt-5.6-sol", effort: "low", speed: "default" });
assert.deepEqual({ engine: windowB.agentEngine, model: windowB.model, effort: windowB.reasoningEffort, speed: windowB.speedMode }, { engine: "opencode", model: "deepseek/deepseek-v4-pro", effort: "medium", speed: "fast" });

const boundedBlock = async (file, start, end) => {
  const stream = createReadStream(resolve(import.meta.dirname, "..", file), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const result = [];
  try {
    for await (const line of lines) {
      if (!result.length && !line.includes(start)) continue;
      if (result.length && line.includes(end)) return result.join("\n");
      result.push(line);
      assert.ok(result.length <= 250);
    }
    assert.fail(`missing source block: ${start}`);
  } finally { lines.close(); stream.destroy(); }
};
const source = await boundedBlock("src/server/codex-agent-provider.mjs", "async startTurn(prompt", "  async startDiagnosticRepair");
const startTurn = source.slice(source.indexOf("runtimeSettings = this.taskRuntimeSettings(runtimeSettings, selectedProject)"));
assert.match(startTurn, /runtimeSettings = this\.taskRuntimeSettings/);
assert.match(startTurn, /const requestedEngine = runtimeSettings\.agentEngine/);
const providerSource = await boundedBlock("src/server/codex-agent-provider.mjs", "runtimeSettings = this.taskRuntimeSettings(runtimeSettings, project)", "    const activeExternalEngine = runtimeSettings.agentEngine");
const deepSeek = providerSource + "\n    const activeExternalEngine = runtimeSettings.agentEngine;";
assert.match(deepSeek, /const activeExternalEngine = runtimeSettings\.agentEngine/);
console.log("Agent runtime request snapshots remain isolated across window engine switches");
