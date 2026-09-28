import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installAgentRunnerFromOfficialSource, locateWindowsInstallTools, runAgentRunnerInstallerProcess } from "../src/server/agent-runner-installer.mjs";
import { resolveLocalClaudeCodeLaunch } from "../src/cli/claude-code-launch.mjs";
import { resolveLocalCodexLaunch } from "../src/cli/codex-launch.mjs";
import { resolveLocalOpenCodeLaunch } from "../src/cli/opencode-launch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolatedRoot = await mkdtemp(join(tmpdir(), "shensi-runner-real-install-"));
const productionTools = await locateWindowsInstallTools();
assert.ok(productionTools.npmCli, "隔离真实安装需要本机 npm CLI");
const isolatedEnvironment = {
  ...process.env,
  APPDATA: isolatedRoot,
  HOME: isolatedRoot,
  USERPROFILE: isolatedRoot,
  LOCALAPPDATA: join(isolatedRoot, "local"),
  SHENSI_MACHINE_DATA_ROOT: join(isolatedRoot, "machine"),
  NPM_CONFIG_CACHE: join(isolatedRoot, "npm-cache"),
  NPM_CONFIG_USERCONFIG: join(isolatedRoot, "npmrc"),
};
const stages = [];
console.log(JSON.stringify({ isolatedRoot }));

const runVersion = (executable, args = []) => new Promise((resolveVersion, rejectVersion) => {
  const child = spawn(executable, args, { cwd: root, env: isolatedEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", rejectVersion);
  child.once("close", (code) => code === 0
    ? resolveVersion(`${stdout}\n${stderr}`.trim())
    : rejectVersion(new Error(stderr || stdout || `版本复检退出代码 ${code}`)));
});

try {
  const results = [];
  for (const runnerId of (process.argv[2] && !process.argv[2].startsWith("--") ? [process.argv[2]] : ["codex", "opencode", "claude_code"])) {
  const installed = await installAgentRunnerFromOfficialSource({
    runnerId,
    cwd: root,
    environment: isolatedEnvironment,
    nodeExecutable: process.execPath,
    runProcess: (request) => runAgentRunnerInstallerProcess({ ...request, timeoutMs: 180_000 }),
    locateTools: async () => ({
      ...productionTools,
      winget: "",
      npmPrefix: join(isolatedRoot, "npm"),
    }),
    report: (event) => stages.push({ stage: event.stage, progress: event.progress, method: event.method }),
  });
  const resolveLaunch = { codex: resolveLocalCodexLaunch, opencode: resolveLocalOpenCodeLaunch, claude_code: resolveLocalClaudeCodeLaunch }[runnerId];
  const launch = await resolveLaunch({
    environment: { ...isolatedEnvironment, PATH: "", Path: "", SHENSI_CODEX_EXECUTABLE: "", SHENSI_CLAUDE_CODE_EXECUTABLE: "", SHENSI_OPENCODE_EXECUTABLE: "" },
    homeDirectory: isolatedRoot,
    machineRoot: isolatedEnvironment.SHENSI_MACHINE_DATA_ROOT,
    registry: {},
  });
  assert.ok([launch.executable, ...launch.prefixArgs].some((path) => String(path).startsWith(isolatedRoot)), "不得借用开发机现有运行器");
  const version = await runVersion(launch.executable, [...launch.prefixArgs, "--version"]);
  assert.match(version, /\d+\.\d+\.\d+/iu);
  results.push({ runnerId, method: installed.method, version });
  console.log(JSON.stringify({ runnerId, method: installed.method, version, isolated: true }));
  }
  console.log(JSON.stringify({ ok: true, results, authenticatedGeneration: "not-tested; fresh environment has no account credentials" }));
} finally {
  if (!process.argv.includes("--keep")) await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
}
