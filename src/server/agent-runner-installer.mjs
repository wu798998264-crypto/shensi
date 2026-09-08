import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const JOB_TTL_MS = 30 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_PROCESS_OUTPUT = 12_000;

export const AGENT_RUNNER_INSTALL_SPECS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    npmPackage: "@openai/codex@latest",
    wingetId: "OpenAI.Codex",
    officialUrl: "https://learn.chatgpt.com/docs/codex/cli",
  }),
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    npmPackage: "opencode-ai@latest",
    wingetId: "",
    officialUrl: "https://opencode.ai/docs/",
  }),
  claude_code: Object.freeze({
    id: "claude_code",
    label: "Claude Code",
    npmPackage: "@anthropic-ai/claude-code@latest",
    wingetId: "Anthropic.ClaudeCode",
    officialUrl: "https://code.claude.com/docs/en/installation",
  }),
});

const clean = (value = "") => String(value ?? "").replace(/\0/gu, "").trim();

const boundedOutput = (value = "") => clean(value).slice(-MAX_PROCESS_OUTPUT);

const accessible = async (candidate, accessFile = access) => {
  if (!clean(candidate)) return false;
  try {
    await accessFile(candidate);
    return true;
  } catch {
    return false;
  }
};

const pathDirectories = (environment = process.env) => clean(environment.PATH || environment.Path)
  .split(delimiter)
  .map((item) => item.replace(/^"|"$/gu, "").trim())
  .filter(Boolean);

const firstAccessible = async (candidates = [], accessFile = access) => {
  for (const candidate of candidates) if (await accessible(candidate, accessFile)) return candidate;
  return "";
};

export const locateWindowsInstallTools = async ({
  environment = process.env,
  homeDirectory = homedir(),
  accessFile = access,
} = {}) => {
  const directories = pathDirectories(environment);
  const programFiles = clean(environment.ProgramFiles) || "C:\\Program Files";
  const localAppData = clean(environment.LOCALAPPDATA) || join(homeDirectory, "AppData", "Local");
  const roamingAppData = clean(environment.APPDATA) || join(homeDirectory, "AppData", "Roaming");
  const systemRoot = clean(environment.SystemRoot) || "C:\\Windows";
  const winget = await firstAccessible([
    ...directories.map((directory) => join(directory, "winget.exe")),
    join(localAppData, "Microsoft", "WindowsApps", "winget.exe"),
    join(systemRoot, "System32", "winget.exe"),
  ], accessFile);
  const npmCli = await firstAccessible([
    ...directories.map((directory) => join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
    join(programFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    join(localAppData, "Programs", "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    join(roamingAppData, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
  ], accessFile);
  return { winget, npmCli, npmPrefix: join(roamingAppData, "npm") };
};

export const runAgentRunnerInstallerProcess = ({
  executable,
  args = [],
  cwd = process.cwd(),
  environment = process.env,
  timeoutMs = INSTALL_TIMEOUT_MS,
  spawnProcess = spawn,
} = {}) => new Promise((resolveProcess, rejectProcess) => {
  if (!clean(executable)) return rejectProcess(new Error("安装器没有找到可执行程序"));
  const child = spawnProcess(executable, args.map((item) => String(item)), {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer = null;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(value);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_PROCESS_OUTPUT); });
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_PROCESS_OUTPUT); });
  child.once("error", (error) => finish(rejectProcess, error));
  child.once("close", (exitCode) => {
    const result = { exitCode: Number(exitCode ?? -1), stdout: boundedOutput(stdout), stderr: boundedOutput(stderr) };
    if (result.exitCode === 0) return finish(resolveProcess, result);
    const reason = result.stderr || result.stdout || `退出代码 ${result.exitCode}`;
    const error = new Error(`官方安装程序执行失败：${reason.slice(-1_200)}`);
    error.code = "AGENT_RUNNER_INSTALL_PROCESS_FAILED";
    error.result = result;
    finish(rejectProcess, error);
  });
  timer = setTimeout(() => {
    try { child.kill(); } catch {}
    const error = new Error(`安装在 ${Math.round(timeoutMs / 60_000)} 分钟内没有完成，请检查网络或代理后重试`);
    error.code = "AGENT_RUNNER_INSTALL_TIMEOUT";
    finish(rejectProcess, error);
  }, timeoutMs);
  timer.unref?.();
});

const wingetInstallArgs = (packageId) => [
  "install",
  "--id", packageId,
  "--exact",
  "--source", "winget",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
];

const npmInstallArgs = ({ prefix, packageName }) => [
  "install",
  "--global",
  "--prefix", prefix,
  "--no-audit",
  "--no-fund",
  "--update-notifier=false",
  packageName,
];

export const installAgentRunnerFromOfficialSource = async ({
  runnerId,
  cwd = process.cwd(),
  environment = process.env,
  nodeExecutable = process.execPath,
  report = () => {},
  locateTools = locateWindowsInstallTools,
  runProcess = runAgentRunnerInstallerProcess,
} = {}) => {
  const spec = AGENT_RUNNER_INSTALL_SPECS[clean(runnerId)];
  if (!spec) {
    const error = new Error("不支持安装这个 Agent 运行器");
    error.code = "AGENT_RUNNER_NOT_ALLOWED";
    throw error;
  }
  if (process.platform !== "win32") {
    const error = new Error("当前一键装配仅支持 Windows 桌面版");
    error.code = "AGENT_RUNNER_INSTALL_PLATFORM_UNSUPPORTED";
    throw error;
  }
  let tools = await locateTools({ environment });
  const npmEnvironment = { ...environment, NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
  if (tools.npmCli) {
    report({ stage: "installing", progress: 34, message: `正在通过官方 npm 包装配 ${spec.label}…`, method: "npm" });
    await runProcess({
      executable: nodeExecutable,
      args: [tools.npmCli, ...npmInstallArgs({ prefix: tools.npmPrefix, packageName: spec.npmPackage })],
      cwd,
      environment: npmEnvironment,
    });
    return { method: "npm", officialUrl: spec.officialUrl };
  }
  if (spec.wingetId && tools.winget) {
    report({ stage: "installing", progress: 34, message: `正在通过 Windows 官方包管理器装配 ${spec.label}…`, method: "winget" });
    await runProcess({ executable: tools.winget, args: wingetInstallArgs(spec.wingetId), cwd, environment });
    return { method: "winget", officialUrl: spec.officialUrl };
  }
  if (spec.id === "opencode" && tools.winget) {
    report({ stage: "prerequisite", progress: 18, message: "本机缺少 npm，正在安装官方 Node.js LTS 前置组件…", method: "winget+npm" });
    await runProcess({ executable: tools.winget, args: wingetInstallArgs("OpenJS.NodeJS.LTS"), cwd, environment });
    tools = await locateTools({ environment });
    if (!tools.npmCli) {
      const error = new Error("Node.js 已安装，但当前进程仍未找到 npm；请重启神思后再次点击装配 OpenCode");
      error.code = "AGENT_RUNNER_NPM_REFRESH_REQUIRED";
      throw error;
    }
    report({ stage: "installing", progress: 48, message: "正在通过 OpenCode 官方 npm 包完成装配…", method: "winget+npm" });
    await runProcess({
      executable: nodeExecutable,
      args: [tools.npmCli, ...npmInstallArgs({ prefix: tools.npmPrefix, packageName: spec.npmPackage })],
      cwd,
      environment: npmEnvironment,
    });
    return { method: "winget+npm", officialUrl: spec.officialUrl };
  }
  const error = new Error(`无法自动装配 ${spec.label}：本机没有可用的 npm${spec.wingetId ? " 或 Windows 包管理器" : "，也没有 Windows 包管理器可安装前置组件"}`);
  error.code = "AGENT_RUNNER_INSTALL_TOOL_MISSING";
  throw error;
};

const publicJob = (job = {}) => ({
  id: clean(job.id),
  runnerId: clean(job.runnerId),
  label: clean(job.label),
  status: clean(job.status),
  stage: clean(job.stage),
  progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
  message: clean(job.message).slice(0, 1_200),
  method: clean(job.method),
  officialUrl: clean(job.officialUrl),
  createdAt: Number(job.createdAt) || 0,
  updatedAt: Number(job.updatedAt) || 0,
  capability: job.capability && typeof job.capability === "object" ? { ...job.capability } : null,
});

export const createAgentRunnerInstallManager = ({
  cwd = process.cwd(),
  detectRunner,
  installRunner = installAgentRunnerFromOfficialSource,
  onInstalled = async () => {},
  now = () => Date.now(),
} = {}) => {
  if (typeof detectRunner !== "function") throw new TypeError("detectRunner is required");
  const jobs = new Map();
  const activeByRunner = new Map();
  const cleanup = () => {
    const cutoff = now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.updatedAt < cutoff && job.status !== "running") jobs.delete(id);
  };
  const update = (job, patch = {}) => {
    Object.assign(job, patch, { updatedAt: now() });
    return publicJob(job);
  };
  const start = async (runnerId) => {
    cleanup();
    const spec = AGENT_RUNNER_INSTALL_SPECS[clean(runnerId)];
    if (!spec) {
      const error = new Error("不支持安装这个 Agent 运行器");
      error.code = "AGENT_RUNNER_NOT_ALLOWED";
      throw error;
    }
    const existingJobId = activeByRunner.get(spec.id);
    if (existingJobId && jobs.get(existingJobId)?.status === "running") return publicJob(jobs.get(existingJobId));
    const job = {
      id: randomUUID(), runnerId: spec.id, label: spec.label, status: "running", stage: "detecting",
      progress: 4, message: `正在检查 ${spec.label}…`, method: "", officialUrl: spec.officialUrl,
      capability: null, createdAt: now(), updatedAt: now(),
    };
    jobs.set(job.id, job);
    activeByRunner.set(spec.id, job.id);
    void (async () => {
      try {
        const before = await detectRunner(spec.id, { force: true });
        if (before?.available === true || before?.installed === true) {
          update(job, { status: "completed", stage: "completed", progress: 100, message: `${spec.label} 已安装，无需重复装配`, capability: before });
          return;
        }
        update(job, { stage: "preparing", progress: 10, message: `正在准备 ${spec.label} 官方安装源…` });
        const result = await installRunner({
          runnerId: spec.id,
          cwd,
          report: (patch) => update(job, patch),
        });
        update(job, { stage: "validating", progress: 88, message: "安装已完成，正在重新检测版本和可执行状态…", method: result?.method || job.method });
        await onInstalled(spec.id);
        const after = await detectRunner(spec.id, { force: true });
        if (after?.available !== true && after?.installed !== true) {
          const error = new Error(`${spec.label} 安装程序已结束，但版本复检未通过；请重启神思后重新检查`);
          error.code = "AGENT_RUNNER_POST_INSTALL_CHECK_FAILED";
          throw error;
        }
        update(job, {
          status: "completed", stage: "completed", progress: 100,
          message: `${spec.label} 已完成下载、装配和版本复检`, capability: after,
          officialUrl: result?.officialUrl || spec.officialUrl,
        });
      } catch (error) {
        update(job, { status: "failed", stage: "failed", progress: 0, message: clean(error?.message || error).slice(0, 1_200) });
      } finally {
        if (activeByRunner.get(spec.id) === job.id) activeByRunner.delete(spec.id);
      }
    })();
    return publicJob(job);
  };
  return {
    start,
    status(jobId) {
      cleanup();
      const job = jobs.get(clean(jobId));
      return job ? publicJob(job) : null;
    },
  };
};
