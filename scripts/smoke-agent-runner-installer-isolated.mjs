import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installAgentRunnerFromOfficialSource, locateWindowsInstallTools } from "../src/server/agent-runner-installer.mjs";
import { resolveLocalClaudeCodeLaunch } from "../src/cli/claude-code-launch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolatedRoot = await mkdtemp(join(tmpdir(), "shensi-runner-real-install-"));
const productionTools = await locateWindowsInstallTools();
assert.ok(productionTools.npmCli, "隔离真实安装需要本机 npm CLI");
const isolatedEnvironment = {
  ...process.env,
  APPDATA: isolatedRoot,
  HOME: isolatedRoot,
  USERPROFILE: isolatedRoot,
  NPM_CONFIG_CACHE: join(isolatedRoot, "npm-cache"),
  NPM_CONFIG_USERCONFIG: join(isolatedRoot, "npmrc"),
};
const stages = [];

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
  const installed = await installAgentRunnerFromOfficialSource({
    runnerId: "claude_code",
    cwd: root,
    environment: isolatedEnvironment,
    nodeExecutable: process.execPath,
    locateTools: async () => ({
      ...productionTools,
      npmPrefix: join(isolatedRoot, "npm"),
    }),
    report: (event) => stages.push({ stage: event.stage, progress: event.progress, method: event.method }),
  });
  const launch = await resolveLocalClaudeCodeLaunch({
    environment: { ...isolatedEnvironment, PATH: "" },
    homeDirectory: isolatedRoot,
  });
  const version = await runVersion(launch.executable, [...launch.prefixArgs, "--version"]);
  assert.match(version, /Claude Code|\d+\.\d+\.\d+/iu);
  console.log(JSON.stringify({ ok: true, method: installed.method, stages, version }, null, 2));
} finally {
  await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
}
