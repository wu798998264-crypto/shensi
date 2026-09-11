import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNNER_INSTALL_SPECS,
  createAgentRunnerInstallManager,
  installAgentRunnerFromOfficialSource,
} from "../src/server/agent-runner-installer.mjs";
import { detectLocalClaudeCode, detectLocalCodex, detectLocalOpenCode } from "../src/server/adapters.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const calls = [];
for (const runnerId of ["codex", "opencode", "claude_code", "workbuddy"]) {
  calls.length = 0;
  await installAgentRunnerFromOfficialSource({
    runnerId,
    nodeExecutable: "C:\\runtime\\node.exe",
    locateTools: async () => ({
      winget: "C:\\Windows\\winget.exe",
      npmCli: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      npmPrefix: "C:\\Users\\Test\\AppData\\Roaming\\npm",
    }),
    runProcess: async (request) => { calls.push(request); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  });
  assert.equal(calls.length, 1, `${runnerId} 必须只有一个白名单安装动作`);
  assert.equal(calls[0].executable, "C:\\runtime\\node.exe");
  assert.ok(calls[0].args.includes(AGENT_RUNNER_INSTALL_SPECS[runnerId].npmPackage));
  assert.equal(calls[0].shell, undefined, "安装器不得启用 shell 或拼接用户命令");
}

calls.length = 0;
await installAgentRunnerFromOfficialSource({
  runnerId: "trae_work",
  locateTools: async () => ({ powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }),
  runProcess: async (request) => { calls.push(request); return { exitCode: 0, stdout: "ok", stderr: "" }; },
});
assert.equal(calls.length, 1, "Trae Work 必须只有一个官方安装动作");
assert.equal(calls[0].executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
assert.deepEqual(calls[0].args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", AGENT_RUNNER_INSTALL_SPECS.trae_work.installScript]);
assert.equal(calls[0].shell, undefined, "Trae Work 安装器不得启用 shell 或拼接用户命令");

await assert.rejects(
  installAgentRunnerFromOfficialSource({ runnerId: "custom" }),
  (error) => error.code === "AGENT_RUNNER_MANUAL_SETUP_REQUIRED",
);

await assert.rejects(
  installAgentRunnerFromOfficialSource({ runnerId: "unknown" }),
  (error) => error.code === "AGENT_RUNNER_NOT_ALLOWED",
);

let installed = false;
let installCount = 0;
const manager = createAgentRunnerInstallManager({
  cwd: root,
  detectRunner: async () => installed
    ? { available: true, installed: true, version: "Test Runner 1.0.0" }
    : { available: false, installed: false },
  installRunner: async ({ report }) => {
    installCount += 1;
    report({ stage: "installing", progress: 52, message: "模拟下载与装配" });
    installed = true;
    return { method: "simulated-official", officialUrl: "https://example.invalid/official" };
  },
});

const started = await manager.start("claude_code");
assert.equal(started.status, "running");
let completed = null;
for (let deadline = Date.now() + 2_000; Date.now() < deadline;) {
  completed = manager.status(started.id);
  if (completed?.status !== "running") break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}
assert.equal(completed?.status, "completed");
assert.equal(completed?.capability?.version, "Test Runner 1.0.0");
assert.equal(installCount, 1);

const alreadyInstalled = await manager.start("claude_code");
for (let deadline = Date.now() + 2_000; Date.now() < deadline;) {
  const status = manager.status(alreadyInstalled.id);
  if (status?.status !== "running") break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}
assert.equal(installCount, 1, "已经安装的运行器不得重复安装");

const [codex, opencode, claudeCode] = await Promise.all([
  detectLocalCodex({ cwd: root }),
  detectLocalOpenCode({ cwd: root }),
  detectLocalClaudeCode({ cwd: root }),
]);
assert.equal(codex.available, true, `Codex 本机复检失败：${codex.message || ""}`);
assert.equal(opencode.available, true, `OpenCode 本机复检失败：${opencode.message || ""}`);
assert.equal(claudeCode.available, true, `Claude Code 本机复检失败：${claudeCode.message || ""}`);

const [appSource, serverSource, styleSource] = await Promise.all([
  readFile(join(root, "src", "app.js"), "utf8"),
  readFile(join(root, "server.mjs"), "utf8"),
  readFile(join(root, "src", "styles.css"), "utf8"),
]);
assert.match(appSource, /id="agentRunnerInstallDialog"/u);
assert.match(appSource, /未安装（点击装配）/u);
assert.match(appSource, /\/api\/agent-runners\/install/u);
assert.match(serverSource, /pathname === "\/api\/agent-runners\/status"/u);
assert.match(serverSource, /pathname === "\/api\/agent-runners\/install"/u);
assert.match(styleSource, /data-runner-state="missing"/u);

console.log(JSON.stringify({
  ok: true,
  simulatedLifecycle: ["missing", "installing", "validating", "completed"],
  realRunners: {
    codex: { available: codex.available, version: codex.version },
    opencode: { available: opencode.available, version: opencode.version },
    claudeCode: { available: claudeCode.available, version: claudeCode.version, authenticated: claudeCode.authenticated },
  },
}, null, 2));
