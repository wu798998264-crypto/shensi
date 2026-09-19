import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgentRunnerOutput, createAgentRunnerInstallManager, detectKnownAgentRunnerInstallation, installAgentRunnerFromOfficialSource, parseWorkBuddyModelCatalog, startKnownAgentRunnerLogin } from "../src/server/agent-runner-installer.mjs";
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
    return args.includes("/model list")
      ? { exitCode: 0, stdout: JSON.stringify({ content: "- hy3\n- glm-5.2\n- deepseek-v4-pro\n- deepseek-v4-flash" }), stderr: "" }
      : { exitCode: 0, stdout: "2.151.0", stderr: "" };
  },
});
assert.equal(workBuddyProbeCalls, 2, "WorkBuddy 应分别探测版本和真实模型目录");
assert.equal(workBuddyCapability.authState, "authenticated");
assert.equal(workBuddyCapability.modelCatalogChecked, true);
assert.deepEqual(workBuddyCapability.models, ["hy3", "glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash"]);

const loggedOutWorkBuddy = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  resolveLaunch: async () => ({ executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }),
  runProcess: async ({ args }) => args.includes("/model list")
    ? { exitCode: 0, stdout: "Please login first", stderr: "" }
    : { exitCode: 0, stdout: "2.151.0", stderr: "" },
});
assert.equal(loggedOutWorkBuddy.state, "login_required");
assert.equal(loggedOutWorkBuddy.authenticated, false);

const defaultWorkBuddy = await detectKnownAgentRunnerInstallation({
  runnerId: "workbuddy",
  resolveLaunch: async () => ({ executable: "C:\\Node\\node.exe", prefixArgs: ["C:\\WorkBuddy\\codebuddy.js"] }),
  runProcess: async ({ args }) => args.includes("--help")
    ? { exitCode: 0, stdout: "--model <model>", stderr: "" }
    : args.includes("/model list")
      ? { exitCode: 0, stdout: JSON.stringify({ content: "Current model is managed by WorkBuddy" }), stderr: "" }
      : { exitCode: 0, stdout: "2.151.0", stderr: "" },
});
assert.equal(defaultWorkBuddy.state, "ready");
assert.equal(defaultWorkBuddy.modelState, "verified_runner_default");
assert.equal(defaultWorkBuddy.modelPolicy, "runner_default");

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
child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
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
assert.equal(launchRequest.args.includes("--model"), false, "WorkBuddy 空模型不得传递 --model");
const toolsFlagIndex = launchRequest.args.indexOf("--tools");
assert.ok(toolsFlagIndex >= 0 && launchRequest.args[toolsFlagIndex + 1] === "DeferExecuteTool", "WorkBuddy 仅神思模式只能暴露 MCP 延迟调用桥，不能开放本地工具");
assert.ok(launchRequest.args.includes("--allowedTools=DeferExecuteTool,mcp__shensi__interaction_delivery,mcp__shensi__documents_write"), "WorkBuddy 必须以单参数白名单预授权真实 MCP 工具与调用桥");
assert.ok(launchRequest.args.includes("--permission-mode=bypassPermissions"), "WorkBuddy 打印模式必须以独立单参数放行内部延迟调用桥");
assert.ok(launchRequest.args.indexOf("--permission-mode=bypassPermissions") < launchRequest.args.findIndex((arg) => arg.startsWith("--allowedTools=")), "WorkBuddy 权限模式必须先于可变长度的工具白名单参数");
assert.equal(launchRequest.args.includes("-y"), false, "WorkBuddy 不得使用无工具边界的全局 -y 跳过权限参数");

console.log(JSON.stringify({ ok: true, checks: ["powershell-output-decoding", "workbuddy-official-installer", "workbuddy-model-catalog", "runner-registry-removal", "runner-login-launch", "cancelled-install", "workbuddy-absolute-launch", "empty-model", "shensi-mcp-deferred-tool"] }, null, 2));
