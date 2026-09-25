import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgentRunnerOutput, createAgentRunnerInstallManager, detectKnownAgentRunnerInstallation, installAgentRunnerFromOfficialSource, parseWorkBuddyModelCatalog, runAgentRunnerInstallerProcess, startKnownAgentRunnerLogin } from "../src/server/agent-runner-installer.mjs";
import { agentRunnerRegistryPath, forgetAgentRunnerLaunch, rememberAgentRunnerLaunch, readAgentRunnerRegistry } from "../src/server/agent-runner-registry.mjs";
import { runExternalCliAgent } from "../src/server/external-cli-agent-runner.mjs";
import { resolveRunnerLaunch, workBuddyInstallRootsFromRegistryOutput } from "../src/server/agent-runner-launch.mjs";

assert.equal(decodeAgentRunnerOutput(Buffer.from("安装失败：缺少运行条件", "utf8"), "powershell"), "安装失败：缺少运行条件");

let workBuddyInstallUrl = "";
const workBuddyInstall = await installAgentRunnerFromOfficialSource({
  runnerId: "workbuddy",
  locateTools: async () => ({ powershell: "powershell.exe", winget: "", npmCli: "", npmPrefix: "" }),
  fetchImpl: async (url) => {
    workBuddyInstallUrl = String(url);
    return new Response("Write-Output 'ok'", { status: 200, headers: { "content-type": "text/plain" } });
  },
  runProcess: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
});
assert.equal(workBuddyInstallUrl, "https://www.codebuddy.cn/cli/install.ps1");
assert.equal(workBuddyInstall.method, "powershell");
assert.match(workBuddyInstall.scriptSha256, /^[a-f0-9]{64}$/u);

const workBuddyResolverRoot = await mkdtemp(join(tmpdir(), "shensi-workbuddy-resolver-"));
const workBuddyInstallRoot = join(workBuddyResolverRoot, "custom", "WorkBuddy");
const workBuddyDesktopScript = join(workBuddyInstallRoot, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
const workBuddyNode = join(workBuddyResolverRoot, "node.exe");
const staleNpmScript = join(workBuddyResolverRoot, "npm", "codebuddy");
await mkdir(join(workBuddyInstallRoot, "resources", "app.asar.unpacked", "cli", "bin"), { recursive: true });
await mkdir(join(workBuddyResolverRoot, "npm"), { recursive: true });
await Promise.all([
  writeFile(workBuddyDesktopScript, "desktop cli"),
  writeFile(workBuddyNode, "node"),
  writeFile(staleNpmScript, "stale npm cli"),
]);
const registryOutput = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WORKBUDDY
    DisplayName    REG_SZ    WorkBuddy 5.5.6
    UninstallString    REG_SZ    "${join(workBuddyInstallRoot, "Uninstall WorkBuddy.exe")}" /currentuser
    DisplayIcon    REG_SZ    ${join(workBuddyInstallRoot, "WorkBuddy.exe")},0
`;
assert.deepEqual(workBuddyInstallRootsFromRegistryOutput(registryOutput), [workBuddyInstallRoot]);
const resolvedWorkBuddyDesktop = await resolveRunnerLaunch({
  runnerId: "workbuddy",
  environment: { LOCALAPPDATA: join(workBuddyResolverRoot, "local"), PATH: "" },
  homeDirectory: workBuddyResolverRoot,
  machineRoot: join(workBuddyResolverRoot, "machine"),
  registry: { workbuddy: { executable: workBuddyNode, prefixArgs: [staleNpmScript] } },
  registryQuery: async () => ({ stdout: registryOutput, stderr: "" }),
  platform: "win32",
  nodeExecutable: workBuddyNode,
});
assert.equal(resolvedWorkBuddyDesktop.executable, workBuddyNode);
assert.deepEqual(resolvedWorkBuddyDesktop.prefixArgs, [workBuddyDesktopScript], "已登录的 WorkBuddy 桌面 CLI 必须优先于陈旧 npm CLI");
assert.equal(resolvedWorkBuddyDesktop.installSource, "workbuddy_desktop");

const configuredWorkBuddyRoot = join(workBuddyResolverRoot, "configured", "WorkBuddy");
const configuredWorkBuddyScript = join(configuredWorkBuddyRoot, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
await mkdir(join(configuredWorkBuddyRoot, "resources", "app.asar.unpacked", "cli", "bin"), { recursive: true });
await writeFile(configuredWorkBuddyScript, "configured desktop cli");
const resolvedConfiguredWorkBuddy = await resolveRunnerLaunch({
  runnerId: "workbuddy",
  environment: { SHENSI_WORKBUDDY_ROOT: configuredWorkBuddyRoot, LOCALAPPDATA: join(workBuddyResolverRoot, "missing-local"), PATH: "" },
  homeDirectory: join(workBuddyResolverRoot, "missing-home"),
  machineRoot: join(workBuddyResolverRoot, "missing-machine"),
  registry: {},
  registryQuery: async () => ({ stdout: "", stderr: "" }),
  platform: "win32",
  nodeExecutable: workBuddyNode,
});
assert.equal(resolvedConfiguredWorkBuddy.executable, workBuddyNode, "用户配置的 WorkBuddy 根目录必须可直接发现");
assert.deepEqual(resolvedConfiguredWorkBuddy.prefixArgs, [configuredWorkBuddyScript], "WorkBuddy 非标准安装目录必须解析到桌面 CLI 脚本");
await rm(workBuddyResolverRoot, { recursive: true, force: true });

const workBuddyHelp = "--model <model>  Currently supported: (hy3, glm-5.2, deepseek-v4-pro, deepseek-v4-flash)";
assert.deepEqual(parseWorkBuddyModelCatalog(workBuddyHelp), ["hy3", "glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash"]);
assert.deepEqual(parseWorkBuddyModelCatalog(JSON.stringify({ content: "- hy3\n- glm-5.2\n- deepseek-v4-pro" })), ["hy3", "glm-5.2", "deepseek-v4-pro"]);
let workBuddyProbeCalls = 0;
const workBuddyCapability = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  resolveLaunch: async () => ({ executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }),
  runProcess: async ({ args }) => {
    workBuddyProbeCalls += 1;
    return args.includes("--help")
      ? { exitCode: 0, stdout: "--model <model> Currently supported: (hy3, glm-5.2, deepseek-v4-pro, deepseek-v4-flash)", stderr: "" }
      : { exitCode: 0, stdout: "2.151.0", stderr: "" };
  },
});
assert.equal(workBuddyProbeCalls, 2, "WorkBuddy 应分别探测版本和真实模型目录");
assert.equal(workBuddyCapability.authState, "generation_check_required");
assert.equal(workBuddyCapability.modelCatalogChecked, true);
assert.deepEqual(workBuddyCapability.models, ["hy3", "glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash"]);
assert.match(workBuddyCapability.message, /登录与额度将在真实生成时核验/u);

const loggedOutWorkBuddy = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  resolveLaunch: async () => ({ executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }),
  runProcess: async ({ args }) => args.includes("--help")
    ? { exitCode: 0, stdout: "--model <model> Currently supported: (hy3)", stderr: "" }
    : { exitCode: 0, stdout: "2.151.0", stderr: "" },
});
assert.equal(loggedOutWorkBuddy.state, "ready");
assert.equal(loggedOutWorkBuddy.authenticated, null, "本地模型目录不得冒充在线登录验收");
assert.equal(loggedOutWorkBuddy.authState, "generation_check_required");

const defaultWorkBuddy = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  resolveLaunch: async () => ({ executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }),
  runProcess: async ({ args }) => args.includes("--help")
    ? { exitCode: 0, stdout: "--model <model>", stderr: "" }
    : { exitCode: 0, stdout: "2.151.0", stderr: "" },
});
assert.equal(defaultWorkBuddy.state, "failed");
assert.equal(defaultWorkBuddy.modelState, "blocked_by_auth");

let probeInput = "";
let probeStdio = null;
const probeChild = new EventEmitter();
probeChild.stdout = new PassThrough();
probeChild.stderr = new PassThrough();
probeChild.stdin = new Writable({
  write(chunk, _encoding, callback) { probeInput += String(chunk); callback(); },
  final(callback) {
    callback();
    process.nextTick(() => {
      probeChild.stdout.write("probe complete");
      probeChild.stdout.end();
      probeChild.stderr.end();
      probeChild.emit("close", 0);
    });
  },
});
probeChild.kill = () => probeChild.emit("close", 1);
const probeResult = await runAgentRunnerInstallerProcess({
  executable: "C:\\Node\\node.exe",
  args: ["C:\\WorkBuddy\\codebuddy.js", "-p"],
  stdinText: "/model list",
  operation: "probe",
  spawnProcess: (_executable, _args, options) => {
    probeStdio = options.stdio;
    return probeChild;
  },
});
assert.equal(probeInput, "/model list", "运行器探测指令必须真实写入 stdin");
assert.deepEqual(probeStdio, ["pipe", "pipe", "pipe"]);
assert.equal(probeResult.stdout, "probe complete");

const timeoutOutputChild = new EventEmitter();
timeoutOutputChild.stdout = new PassThrough();
timeoutOutputChild.stderr = new PassThrough();
timeoutOutputChild.kill = () => timeoutOutputChild.emit("close", 1);
const timeoutOutputKeepAlive = setTimeout(() => {}, 80);
const timeoutOutputResult = await runAgentRunnerInstallerProcess({
  executable: "C:\\Node\\node.exe",
  args: ["C:\\WorkBuddy\\codebuddy.js", "--help"],
  timeoutMs: 20,
  maxOutputBytes: 64_000,
  acceptOutputOnTimeout: true,
  operation: "probe",
  spawnProcess: () => {
    process.nextTick(() => timeoutOutputChild.stdout.write("Currently supported: (hy3, glm-5.2)"));
    return timeoutOutputChild;
  },
});
clearTimeout(timeoutOutputKeepAlive);
assert.match(timeoutOutputResult.stdout, /Currently supported/u, "帮助命令已输出目录但进程未退出时应保留真实目录");

const registryRoot = await mkdtemp(join(tmpdir(), "shensi-runner-registry-"));
await rememberAgentRunnerLaunch({ machineRoot: registryRoot, runnerId: "workbuddy", launch: { executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }, version: "2.0.0", installSource: "npm" });
const registry = await readAgentRunnerRegistry({ machineRoot: registryRoot });
assert.deepEqual(registry.workbuddy.prefixArgs, ["C:\\WorkBuddy\\codebuddy.js"]);
assert.equal(JSON.stringify(JSON.parse(await readFile(agentRunnerRegistryPath({ machineRoot: registryRoot }), "utf8"))).includes("apiKey"), false);
await rememberAgentRunnerLaunch({ machineRoot: registryRoot, runnerId: "workbuddy", launch: { executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddyDesktop\\codebuddy.js"], installSource: "workbuddy_desktop" }, version: "2.1.0" });
const desktopRegistry = await readAgentRunnerRegistry({ machineRoot: registryRoot });
assert.equal(desktopRegistry.workbuddy.installSource, "workbuddy_desktop", "桌面 CLI 来源必须随解析结果持久化，避免每次任务重复扫描注册表");
await rememberAgentRunnerLaunch({ machineRoot: registryRoot, runnerId: "retired_runner", launch: { executable: "C:\\Retired\\runner.exe" }, version: "1.0.0" });
await forgetAgentRunnerLaunch({ machineRoot: registryRoot, runnerId: "retired_runner" });
assert.equal(Object.hasOwn(await readAgentRunnerRegistry({ machineRoot: registryRoot }), "retired_runner"), false, "已移除的运行器登记必须可清除且不影响其他运行器");
await rm(registryRoot, { recursive: true, force: true });

for (const runnerId of ["workbuddy"]) {
  let loginLaunch = null;
  const loginChild = new EventEmitter();
  loginChild.pid = 42;
  loginChild.unref = () => {};
  process.nextTick(() => loginChild.emit("spawn"));
  const login = await startKnownAgentRunnerLogin({
    runnerId,
    resolveLaunch: async () => ({ executable: `C:\\${runnerId}\\runner.exe`, prefixArgs: ["--prefix"] }),
    spawnProcess: (executable, args, options) => {
      loginLaunch = { executable, args, options };
      return loginChild;
    },
  });
  assert.equal(login.ok, true);
  assert.equal(loginLaunch.options.shell, false);
  assert.deepEqual(loginLaunch.args, ["--prefix"]);
}

let cancelled = false;
const manager = createAgentRunnerInstallManager({
  detectRunner: async () => ({ available: false, installed: false }),
  installRunner: async ({ signal }) => await new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(Object.assign(new Error("已终止"), { name: "AbortError", code: "ABORT_ERR" })); }, { once: true });
  }),
});
const started = await manager.start("workbuddy");
await new Promise((resolve) => setTimeout(resolve, 20));
const stopped = await manager.cancel(started.id);
assert.equal(stopped.status, "cancelled");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(cancelled, true);

const child = new EventEmitter();
child.stdout = new PassThrough();
child.stderr = new PassThrough();
let workBuddyStdin = "";
child.stdin = new Writable({ write(chunk, _encoding, callback) { workBuddyStdin += String(chunk); callback(); } });
child.kill = () => child.emit("close", 0);
let launchRequest = null;
const run = runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试 WorkBuddy 默认模型",
  model: "",
  cliPath: "codebuddy",
  cliArgs: "-p {prompt} --model {model}",
  prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"],
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: ["interaction_delivery", "documents_write"] },
  agentPermissionMode: "shensi_only",
  permissionContract: { mode: "approval_required", confirmation: { required: true } },
  resolveLaunch: async () => ({ executable: "C:\\WorkBuddy\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }),
  spawnProcess: (executable, args) => {
    launchRequest = { executable, args };
    process.nextTick(() => {
      child.stdout.write(`${JSON.stringify({ type: "message", text: "SHENSI_WORKBUDDY_OK" })}\n`);
      child.emit("close", 0);
    });
    return child;
  },
});
await run;
assert.equal(launchRequest.executable, "C:\\WorkBuddy\\node.exe");
assert.deepEqual(launchRequest.args.slice(0, 1), ["C:\\WorkBuddy\\codebuddy.js"]);
assert.equal(launchRequest.args.includes("测试 WorkBuddy 默认模型"), false, "WorkBuddy 不得把完整提示词拼进 Windows 命令行");
assert.equal(workBuddyStdin.includes("测试 WorkBuddy 默认模型"), true, "WorkBuddy 任务必须通过 stdin 传递完整提示词");
assert.equal(launchRequest.args.includes("--model"), false, "WorkBuddy 空模型不得传递 --model");
const toolsFlagIndex = launchRequest.args.indexOf("--tools");
assert.ok(toolsFlagIndex >= 0 && launchRequest.args[toolsFlagIndex + 1] === "DeferExecuteTool", "WorkBuddy 仅神思模式只能暴露 MCP 延迟调用桥，不能开放本地工具");
assert.ok(launchRequest.args.includes("--allowedTools=DeferExecuteTool,mcp__shensi__interaction_delivery,mcp__shensi__documents_write"), "WorkBuddy 必须以单参数白名单预授权真实 MCP 工具与调用桥");
assert.ok(launchRequest.args.includes("--permission-mode=bypassPermissions"), "WorkBuddy 打印模式必须以独立单参数放行内部延迟调用桥");
assert.ok(launchRequest.args.indexOf("--permission-mode=bypassPermissions") < launchRequest.args.findIndex((arg) => arg.startsWith("--allowedTools=")), "WorkBuddy 权限模式必须先于可变长度的工具白名单参数");
assert.equal(launchRequest.args.includes("-y"), false, "WorkBuddy 不得使用无工具边界的全局 -y 跳过权限参数");

console.log(JSON.stringify({ ok: true, checks: ["powershell-output-decoding", "workbuddy-official-installer", "workbuddy-model-catalog", "runner-registry-removal", "runner-login-launch", "cancelled-install", "workbuddy-absolute-launch", "empty-model", "shensi-mcp-deferred-tool"] }, null, 2));
