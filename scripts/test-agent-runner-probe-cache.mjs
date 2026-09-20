import assert from "node:assert/strict";
import { detectKnownAgentRunnerInstallation } from "../src/server/agent-runner-installer.mjs";

let calls = 0;
const resolveLaunch = async () => ({ executable: "C:\\WorkBuddy\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy"] });
const runProcess = async ({ args }) => {
  calls += 1;
  if (args.includes("--version")) return { stdout: "WorkBuddy 2.137.1", stderr: "", exitCode: 0 };
  return { stdout: JSON.stringify({ models: ["hy3", "glm-5.2", "deepseek-v4-pro"] }), stderr: "", exitCode: 0 };
};

const first = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  machineRoot: "C:\\probe-cache-test",
  resolveLaunch,
  runProcess,
  cache: true,
});
assert.equal(first.ready, true);
assert.deepEqual(first.models, ["hy3", "glm-5.2", "deepseek-v4-pro"]);
assert.equal(calls, 2, "首次探测仍须真实执行版本和模型目录检查");

const second = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  machineRoot: "C:\\probe-cache-test",
  resolveLaunch,
  runProcess,
  cache: true,
});
assert.deepEqual(second.models, first.models);
assert.equal(calls, 2, "设置刷新后紧接着首次对话不得重复启动 WorkBuddy CLI");

await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  machineRoot: "C:\\probe-cache-test",
  resolveLaunch,
  runProcess,
  cache: true,
  force: true,
});
assert.equal(calls, 4, "显式刷新必须绕过短时缓存重新核验");
console.log("WorkBuddy runner probe cache contract passed");

