import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expandCliArgs } from "../src/server/external-cli-agent-runner.mjs";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { runtimeContractForProfile } from "../src/effective-runtime-contract.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const profile = normalizeGenerationProfiles({
  textConnections: [{
    id: "workbuddy-default",
    name: "WorkBuddy",
    adapter: "cli",
    agentEngine: "workbuddy",
    cliPath: "codebuddy",
    cliArgs: "-p {prompt} --output-format stream-json --model {model}",
    model: "",
    agentModelId: "",
    executionModes: ["agent"],
  }],
  activeTextConnectionId: "workbuddy-default",
  activeTextAgentConnectionId: "workbuddy-default",
}).textConnections[0];

assert.equal(profile.agentEngine, "workbuddy");
assert.equal(profile.model, "", "WorkBuddy 未指定模型时应保留为空，交给 CLI 默认模型");
assert.equal(profile.agentModelId, "", "WorkBuddy 未指定模型时 Agent 模型也应保持为空");

const contract = runtimeContractForProfile({ profile });
assert.equal(contract.ok, true, "外置 WorkBuddy CLI 不应被神思模型必填校验拦截");
assert.equal(contract.model, "");
assert.equal(contract.runnerId, "workbuddy");
assert.equal(contract.providerId, "runner_managed");
assert.equal(contract.credentialSource, "runner_login");
assert.equal(contract.modelPolicy, "runner_default");

const args = expandCliArgs(profile.cliArgs, { prompt: "只回复 OK", model: "" });
assert.equal(args.includes("--model"), false, "模型为空时不得向 WorkBuddy 传递空 --model 参数");
assert.equal(args.includes("只回复 OK"), true);

assert.match(app, /跟随 \$\{externalRunnerLabel\} 默认模型（留空）/u);
assert.match(app, /跟随 \$\{escapeHtml\(runnerLabel\)\} CLI 默认模型/u);
assert.match(app, /\$\{escapeHtml\(runnerLabel\)\} CLI 当前账号/u);
assert.match(app, /请先登录 \$\{escapeHtml\(runnerLabel\)\}，登录后自动读取模型/u);
assert.match(app, /正在读取 \$\{runnerLabel\} CLI 当前支持的模型/u);
assert.match(app, /读取 \$\{capability\.models\.length\} 个真实支持模型/u);

console.log("WorkBuddy default model contract passed");
