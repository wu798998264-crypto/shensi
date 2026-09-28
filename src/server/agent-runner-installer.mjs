import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRunnerLaunch } from "./agent-runner-launch.mjs";
import { rememberAgentRunnerLaunch } from "./agent-runner-registry.mjs";
import { inspectWorkBuddyDesktopBridge, runWorkBuddyDesktopBridge } from "./workbuddy-desktop-bridge.mjs";

const JOB_TTL_MS = 30 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_PROCESS_OUTPUT = 12_000;
const MAX_MODEL_CATALOG_OUTPUT = 64_000;
const RUNNER_PROBE_CACHE_TTL_MS = 45_000;
const runnerProbeCache = new Map();
const runnerProbeInFlight = new Map();
const probeFunctionIds = new WeakMap();
let nextProbeFunctionId = 1;

const probeFunctionIdentity = (value) => {
  if (typeof value !== "function") return "none";
  if (!probeFunctionIds.has(value)) probeFunctionIds.set(value, String(nextProbeFunctionId++));
  return probeFunctionIds.get(value);
};

export const AGENT_RUNNER_INSTALL_SPECS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    installKind: "npm",
    npmPackage: "@openai/codex@latest",
    wingetId: "OpenAI.Codex",
    officialUrl: "https://learn.chatgpt.com/docs/codex/cli",
  }),
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    installKind: "npm",
    npmPackage: "opencode-ai@latest",
    wingetId: "",
    officialUrl: "https://opencode.ai/docs/",
  }),
  claude_code: Object.freeze({
    id: "claude_code",
    label: "Claude Code",
    installKind: "npm",
    npmPackage: "@anthropic-ai/claude-code@latest",
    wingetId: "Anthropic.ClaudeCode",
    officialUrl: "https://code.claude.com/docs/en/installation",
  }),
  workbuddy: Object.freeze({
    id: "workbuddy",
    label: "WorkBuddy",
    npmPackage: "@tencent-ai/codebuddy-code@latest",
    wingetId: "",
    officialUrl: "https://www.codebuddy.ai/docs/cli/installation",
    installKind: "powershell_script",
    installScriptUrl: "https://www.codebuddy.cn/cli/install.ps1",
    allowedScriptHosts: ["www.codebuddy.cn", "codebuddy.cn"],
  }),
  custom: Object.freeze({
    id: "custom",
    label: "自定义运行器",
    npmPackage: "",
    wingetId: "",
    officialUrl: "",
    installKind: "manual",
  }),
});

const clean = (value = "") => String(value ?? "").replace(/\0/gu, "").trim();

const boundedOutput = (value = "") => clean(value).slice(-MAX_PROCESS_OUTPUT);

const windowsPowerShellInstallEnvironment = (environment = process.env) => {
  const next = Object.fromEntries(Object.entries(environment || {})
    .filter(([key]) => key.toLocaleLowerCase() !== "psmodulepath"));
  next.PYTHONIOENCODING = "utf-8";
  return next;
};

const pathDirectories = (environment = process.env) => clean(environment.PATH || environment.Path)
  .split(process.platform === "win32" ? ";" : ":")
  .map((item) => item.replace(/^"|"$/gu, "").trim())
  .filter(Boolean);

const accessible = async (candidate, accessFile = access) => {
  if (!clean(candidate)) return false;
  try {
    await accessFile(candidate);
    return true;
  } catch {
    return false;
  }
};

const firstAccessible = async (candidates = [], accessFile = access) => {
  for (const candidate of candidates) if (await accessible(candidate, accessFile)) return candidate;
  return "";
};

export const decodeAgentRunnerOutput = (value, source = "node") => {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
  if (!buffer.length) return "";
  const encoding = source === "powershell" ? "utf-8" : source === "npm" || source === "node" ? "utf-8" : "auto";
  if (encoding === "utf-8") return new TextDecoder("utf-8").decode(buffer);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {}
  try { return new TextDecoder("gb18030").decode(buffer); } catch { return buffer.toString("utf8"); }
};

export const createAgentRunnerError = ({
  runnerId = "",
  stage = "install",
  code = "AGENT_RUNNER_INSTALL_FAILED",
  summary = "Agent 运行器装配失败",
  detail = "",
  exitCode = null,
  retryable = false,
  suggestedAction = "",
} = {}) => Object.assign(new Error(clean(summary) || "Agent 运行器装配失败"), {
  code,
  runnerId: clean(runnerId),
  stage: clean(stage),
  summary: clean(summary),
  detail: boundedOutput(detail),
  exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
  retryable: retryable === true,
  suggestedAction: clean(suggestedAction),
});

export const resolveKnownAgentRunnerLaunch = resolveRunnerLaunch;

export const parseWorkBuddyModelCatalog = (output = "") => {
  const source = String(output || "").trim();
  const models = [];
  const append = (value) => {
    const model = clean(value);
    if (/^[a-z0-9][a-z0-9._:+/-]*$/iu.test(model)) models.push(model);
  };
  const collectModelArray = (value) => {
    if (!Array.isArray(value)) return;
    for (const item of value) append(typeof item === "string" ? item : item?.modelId || item?.model || item?.id || item?.name || item?.slug);
  };
  const collectPayload = (payload) => {
    if (!payload || typeof payload !== "object") return;
    collectModelArray(payload);
    collectModelArray(payload.models);
    collectModelArray(payload?.data?.models);
    collectModelArray(payload?.result?.models);
    for (const candidate of [payload.text, payload.content, payload.message, payload.output, payload.result?.text, payload.result?.content]) {
      if (typeof candidate !== "string") continue;
      for (const nestedLine of candidate.split(/\r?\n/u)) {
        const listed = nestedLine.trim().match(/^\s*(?:[-*•]|\d+[.)])\s*`?([a-z0-9][a-z0-9._:+/-]*)`?(?:\s|$)/iu);
        if (listed) append(listed[1]);
      }
    }
  };
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const payload = JSON.parse(trimmed);
      collectPayload(payload);
    } catch {}
    const listed = trimmed.match(/^\s*(?:[-*•]|\d+[.)])\s*`?([a-z0-9][a-z0-9._:+/-]*)`?(?:\s|$)/iu);
    if (listed) append(listed[1]);
  }
  const supported = source.match(/Currently supported:\s*\(([^)]+)\)/iu);
  if (supported) supported[1].split(",").forEach(append);
  return [...new Set(models)];
};

// WorkBuddy's product catalogue contains the model aliases shown in its
// desktop picker (for example fast-model/balanced-model/deep-model).  The
// CLI --help output is a separate, often older compatibility list.  Read the
// local product manifest for the exact launcher we selected; when it exists it
// is authoritative, and --help is only a fallback.  Merging an older static
// list would expose models that the current desktop account no longer offers.
export const parseWorkBuddyProductCatalog = (output = "") => {
  let payload;
  try { payload = JSON.parse(String(output || "")); } catch { return { models: [], labels: {} }; }
  const cliAgent = Array.isArray(payload?.agents)
    ? payload.agents.find((agent) => String(agent?.name || "").trim().toLocaleLowerCase() === "cli")
    : null;
  const models = [...new Set((Array.isArray(cliAgent?.models) ? cliAgent.models : [])
    .map((model) => clean(typeof model === "string" ? model : model?.id || model?.model || model?.slug))
    .filter((model) => /^[a-z0-9][a-z0-9._:+/-]*$/iu.test(model)))];
  const definitions = new Map((Array.isArray(payload?.models) ? payload.models : [])
    .map((model) => [clean(model?.id || model?.model || model?.slug), clean(model?.name || model?.displayName || model?.label)])
    .filter(([id, label]) => id && label));
  const labels = Object.fromEntries(models
    .map((model) => [model, definitions.get(model) || ""])
    .filter(([, label]) => label));
  return { models, labels };
};

const workBuddyConfigRoot = ({ environment = process.env, homeDirectory = homedir() } = {}) =>
  clean(environment.WORKBUDDY_CONFIG_DIR || environment.CODEBUDDY_CONFIG_DIR) || join(homeDirectory, ".workbuddy");

// The desktop product manager periodically merges a remote catalogue into
// ACC_PRODUCT_CONFIG_V3.  That resolved catalogue is spilled to disk before
// the desktop prewarm process is launched, while the bundled CLI's static
// product.json can remain several releases behind.  Reading the spill is
// still local and read-only; it does not import credentials or replace the
// CLI launch selected for account isolation.
const readWorkBuddyResolvedProductCatalog = async ({ environment = process.env, homeDirectory = homedir() } = {}) => {
  const explicitRoot = clean(environment.WORKBUDDY_CONFIG_DIR || environment.CODEBUDDY_CONFIG_DIR);
  // Test and embedded callers often pass a synthetic environment.  Never
  // accidentally read the developer's real WorkBuddy cache in that mode.
  if (!explicitRoot && environment !== process.env) return { models: [], labels: {}, manifest: "", source: "" };
  const root = explicitRoot || workBuddyConfigRoot({ environment, homeDirectory });
  const cacheRoot = join(root, "cache");
  const spillRoot = join(cacheRoot, "conversation-product-spill");
  const spillEntries = await readdir(spillRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [
    join(cacheRoot, "acc-product-config-v3.json"),
    ...spillEntries
      .filter((entry) => entry.isFile() && /^acc-product-config-v3-[a-f0-9]+\.json$/iu.test(entry.name))
      .map((entry) => join(spillRoot, entry.name)),
  ];
  const parsed = [];
  for (const candidate of candidates) {
    const source = await readFile(candidate, "utf8").catch(() => "");
    if (!source) continue;
    const catalog = parseWorkBuddyProductCatalog(source);
    if (!catalog.models.length) continue;
    parsed.push({ ...catalog, manifest: candidate, source: "workbuddy_resolved_product" });
  }
  // Prefer the resolved catalogue that declares the largest current CLI
  // model set.  The direct spill file may only contain the bundled fallback
  // list, while the conversation spill contains the desktop's remote merge.
  parsed.sort((left, right) => right.models.length - left.models.length);
  return parsed[0] || { models: [], labels: {}, manifest: "", source: "" };
};

const workBuddyProductManifestPath = (launch = {}) => {
  const script = (Array.isArray(launch.prefixArgs) ? launch.prefixArgs : [])
    .map((value) => clean(value))
    .find((value) => /(?:^|[\\/])codebuddy(?:\.cmd|\.exe)?$/iu.test(value) || /(?:^|[\\/])codebuddy$/iu.test(value));
  return script ? join(dirname(dirname(script)), "product.json") : "";
};

const readWorkBuddyProductCatalog = async (launch = {}, { environment = process.env, homeDirectory = homedir() } = {}) => {
  const manifest = workBuddyProductManifestPath(launch);
  const explicitRoot = clean(environment.WORKBUDDY_CONFIG_DIR || environment.CODEBUDDY_CONFIG_DIR);
  const resolved = launch.installSource === "workbuddy_desktop" || explicitRoot
    ? await readWorkBuddyResolvedProductCatalog({ environment, homeDirectory })
    : { models: [], labels: {}, manifest: "", source: "" };
  if (!manifest) return resolved;
  const source = await readFile(manifest, "utf8").catch(() => "");
  if (!source) return resolved.models.length ? resolved : { models: [], labels: {}, manifest, source: "" };
  const catalog = parseWorkBuddyProductCatalog(source);
  if (resolved.models.length > catalog.models.length) return resolved;
  return { ...catalog, manifest, source: "runner_product" };
};

const runnerLoginStateFromOutput = (output = "") => {
  const source = clean(output).toLocaleLowerCase();
  if (!source) return null;
  if (/not logged in|login required|please (?:sign in|log in|login)|authentication required|unauthorized|token expired|未登录|尚未登录|请先登录|登录已过期|认证失败|\b401\b/u.test(source)) return false;
  if (/logged in|authenticated|authentication succeeded|已登录|登录成功|认证成功/u.test(source)) return true;
  return null;
};

const runnerProbeDetail = (error) => clean([
  error?.result?.stdout,
  error?.result?.stderr,
  error?.detail,
  error?.message,
].filter(Boolean).join("\n")).slice(0, 2_000);

const runnerCapabilityError = ({ runnerId, stage, code, summary, detail, retryable = true, suggestedAction = "" }) => ({
  runnerId,
  stage,
  code,
  summary,
  detail: clean(detail).slice(0, 2_000),
  retryable,
  suggestedAction,
});

const detectKnownAgentRunnerInstallationUncached = async ({
  runnerId,
  cwd = process.cwd(),
  environment = process.env,
  machineRoot = "",
  installSource = "",
  persist = false,
  resolveLaunch = resolveKnownAgentRunnerLaunch,
  runProcess = runAgentRunnerInstallerProcess,
} = {}) => {
  try {
    const launch = await resolveLaunch({ runnerId, environment, machineRoot });
    const result = await runProcess({
      executable: launch.executable,
      args: [...launch.prefixArgs, "--version"],
      cwd,
      environment,
      timeoutMs: 8_000,
      outputSource: "node",
      operation: "probe",
    });
    const version = clean(result.stdout || result.stderr).split(/\r?\n/u)[0] || AGENT_RUNNER_INSTALL_SPECS[clean(runnerId)]?.label || "Agent CLI";
    let models = [];
    let modelCatalogChecked = false;
    const normalizedRunnerId = clean(runnerId);
    let authenticated = null;
    let authState = "unknown";
    let modelState = "blocked_by_auth";
    let modelPolicy = "";
    let catalogSource = "";
    let modelLabels = {};
    let state = "failed";
    let message = "";
    let capabilityError = null;
    if (normalizedRunnerId === "workbuddy") {
      const productCatalog = await readWorkBuddyProductCatalog(launch, { environment, homeDirectory: homedir() });
      modelLabels = productCatalog.labels;
      const desktopLaunch = launch.installSource === "workbuddy_desktop"
        || launch.prefixArgs?.some((value) => /[\\/]WorkBuddy[\\/]resources[\\/]app\.asar(?:\.unpacked)?[\\/]cli[\\/]bin[\\/]codebuddy/iu.test(String(value || "")));
      const desktopBridge = desktopLaunch
        ? await inspectWorkBuddyDesktopBridge({ cwd, environment }).catch(() => null)
        : null;
      if (desktopBridge?.authenticated === true) {
        models = Array.isArray(desktopBridge.models) ? desktopBridge.models : [];
        modelLabels = desktopBridge.modelLabels && typeof desktopBridge.modelLabels === "object" ? desktopBridge.modelLabels : modelLabels;
        catalogSource = desktopBridge.catalogSource || "workbuddy_acp_session";
        authenticated = true;
        authState = "authenticated";
        modelCatalogChecked = models.length > 0;
      }
      try {
        // WorkBuddy publishes the exact model IDs supported by the installed
        // CLI in --help. Reading that catalogue is local, immediate and does
        // not consume account quota. Login/quota remains a generation-time
        // online check; it must never hold the model picker open for 30–45s.
        const help = await runProcess({
          executable: launch.executable,
          args: [...launch.prefixArgs, "--help"],
          cwd,
          environment,
          timeoutMs: 3_000,
          outputSource: "node",
          maxOutputBytes: MAX_MODEL_CATALOG_OUTPUT,
          operation: "probe",
          acceptOutputOnTimeout: true,
        });
        const helpModels = parseWorkBuddyModelCatalog(`${help.stdout || ""}\n${help.stderr || ""}`);
        if (authenticated !== true) models = productCatalog.models.length ? productCatalog.models : helpModels;
        if (models.length) catalogSource = productCatalog.models.length
          ? (catalogSource || productCatalog.source)
          : "runner_cli";
      } catch (error) {
        const detail = runnerProbeDetail(error);
        capabilityError = runnerCapabilityError({
          runnerId: normalizedRunnerId,
          stage: "model_catalog",
          code: "AGENT_RUNNER_MODEL_CATALOG_FAILED",
          summary: "WorkBuddy 模型目录读取失败",
          detail,
          suggestedAction: "重新检查 WorkBuddy 安装，或留空跟随 CLI 默认模型",
        });
      }
      if (authenticated !== true) {
        authenticated = null;
        authState = "generation_check_required";
      }
    }
    modelCatalogChecked = models.length > 0;
    if (normalizedRunnerId === "workbuddy" && authenticated === null) {
      // A local product catalogue proves only that the picker can be
      // populated.  It must never be reported as an authenticated runner:
      // the bundled CLI and the desktop app can have different bootstrap
      // contexts, and the first real generation is the authority for login.
      modelState = modelCatalogChecked ? "catalog_available" : "catalog_unavailable";
      modelPolicy = modelCatalogChecked ? "explicit" : "runner_default";
      state = "generation_check_required";
      authState = "generation_check_required";
      message = modelCatalogChecked
        ? `已读取 ${models.length} 个 WorkBuddy CLI 支持模型，但尚未完成真实登录/生成验证`
        : "已检测到 WorkBuddy CLI，但尚未读取模型目录；登录与模型能力将在真实生成时核验";
    } else if (authenticated === true) {
      if (modelCatalogChecked) {
        modelState = "catalog_available";
        modelPolicy = "explicit";
        state = "ready";
        message = `已读取 ${models.length} 个 ${AGENT_RUNNER_INSTALL_SPECS[normalizedRunnerId]?.label || "CLI"} 当前可用模型`;
      } else {
        modelState = "verified_runner_default";
        modelPolicy = "runner_default";
        catalogSource = "verified_default";
        state = "ready";
        message = `${AGENT_RUNNER_INSTALL_SPECS[normalizedRunnerId]?.label || "CLI"} 未返回模型目录，将跟随已验证的 CLI 默认模型`;
      }
    } else if (authenticated === false) {
      modelState = "blocked_by_auth";
      state = "login_required";
      authState = "login_required";
      message = "WorkBuddy 未检测到有效登录会话";
    } else {
      modelState = "blocked_by_auth";
    }
    if (persist && machineRoot) await rememberAgentRunnerLaunch({ machineRoot, runnerId, launch, version, installSource });
    return {
      available: true,
      installed: true,
      installState: "installed",
      state,
      ready: state === "ready",
      version: version.slice(0, 160),
      cliPath: launch.executable,
      prefixArgs: launch.prefixArgs,
      authenticated,
      authState,
      models,
      modelCatalogChecked,
      modelState,
      modelPolicy,
      catalogSource,
      modelLabels,
      message,
      error: capabilityError,
    };
  } catch (error) {
    return { available: false, installed: false, installState: "missing", state: "missing", ready: false, authenticated: null, authState: "unknown", modelState: "blocked_by_auth", modelPolicy: "", message: clean(error?.message || error).slice(0, 500), error: {
      code: clean(error?.code || "AGENT_RUNNER_NOT_FOUND"),
      stage: clean(error?.stage || "executable_resolution"),
      summary: clean(error?.summary || error?.message || error).slice(0, 500),
      detail: clean(error?.detail || error?.message || error).slice(0, 2_000),
      retryable: error?.retryable === true,
      suggestedAction: clean(error?.suggestedAction),
    } };
  }
};

/**
 * A settings refresh and the first Agent turn can arrive together.  Reusing
 * the same short-lived, read-only probe avoids launching WorkBuddy twice
 * (version + login/model catalogue) before the first prompt is sent.  `force`
 * remains available for explicit refresh/login actions.
 */
export const detectKnownAgentRunnerInstallation = async (options = {}) => {
  const {
    runnerId = "",
    machineRoot = "",
    environment = process.env,
    resolveLaunch = resolveKnownAgentRunnerLaunch,
    runProcess = runAgentRunnerInstallerProcess,
    force = false,
    cache = true,
  } = options;
  if (!cache || force) {
    if (force) {
      const prefix = `${clean(runnerId)}|${clean(machineRoot || process.cwd())}|${probeFunctionIdentity(resolveLaunch)}|${probeFunctionIdentity(runProcess)}`;
      runnerProbeCache.delete(prefix);
      runnerProbeInFlight.delete(prefix);
    }
    return detectKnownAgentRunnerInstallationUncached(options);
  }
  const key = `${clean(runnerId)}|${clean(machineRoot || process.cwd())}|${probeFunctionIdentity(resolveLaunch)}|${probeFunctionIdentity(runProcess)}`;
  const cached = runnerProbeCache.get(key);
  if (cached && Date.now() - cached.checkedAt < RUNNER_PROBE_CACHE_TTL_MS) return cached.value;
  const pending = runnerProbeInFlight.get(key);
  if (pending) return pending;
  const request = detectKnownAgentRunnerInstallationUncached(options)
    .then((value) => {
      runnerProbeCache.set(key, { checkedAt: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (runnerProbeInFlight.get(key) === request) runnerProbeInFlight.delete(key);
    });
  runnerProbeInFlight.set(key, request);
  return request;
};

export const startKnownAgentRunnerLogin = async ({
  runnerId,
  cwd = process.cwd(),
  environment = process.env,
  machineRoot = "",
  resolveLaunch = resolveKnownAgentRunnerLaunch,
  spawnProcess = spawn,
} = {}) => {
  const id = clean(runnerId);
  if (id !== "workbuddy") {
    throw createAgentRunnerError({
      runnerId: id,
      stage: "login_probe",
      code: "AGENT_RUNNER_LOGIN_UNSUPPORTED",
      summary: "当前运行器不支持从神思打开登录窗口",
    });
  }
  const launch = await resolveLaunch({ runnerId: id, environment, machineRoot });
  // Some desktop builds ship only the headless CLI bundle. Starting that
  // script with no arguments exits before the user can sign in. Resolve the
  // desktop executable from the exact same bundled root instead.
  let loginExecutable = launch.executable;
  let args = [...(Array.isArray(launch.prefixArgs) ? launch.prefixArgs : [])];
  const bundledCli = args.find((value) => /[\\/]cli[\\/]bin[\\/]codebuddy(?:\.cmd|\.exe)?$/iu.test(String(value || "")));
  if (bundledCli) {
    const desktopRoot = dirname(dirname(dirname(dirname(dirname(String(bundledCli))))));
    const desktopExecutable = join(desktopRoot, "WorkBuddy.exe");
    if (await accessible(desktopExecutable)) {
      loginExecutable = desktopExecutable;
      args = [];
    }
  }
  await new Promise((resolveStart, rejectStart) => {
    let child;
    try {
      child = spawnProcess(loginExecutable, args, {
        cwd,
        env: environment,
        shell: false,
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      });
    } catch (error) {
      rejectStart(createAgentRunnerError({
        runnerId: id,
        stage: "login_probe",
        code: "AGENT_RUNNER_LOGIN_LAUNCH_FAILED",
        summary: `无法打开 ${AGENT_RUNNER_INSTALL_SPECS[id]?.label || "Agent"} 登录窗口`,
        detail: error?.message || error,
        retryable: true,
        suggestedAction: "重新检查运行器路径后再试",
      }));
      return;
    }
    const started = () => {
      child.removeListener?.("error", failed);
      child.unref?.();
      resolveStart();
    };
    const failed = (error) => {
      child.removeListener?.("spawn", started);
      rejectStart(createAgentRunnerError({
        runnerId: id,
        stage: "login_probe",
        code: "AGENT_RUNNER_LOGIN_LAUNCH_FAILED",
        summary: `无法打开 ${AGENT_RUNNER_INSTALL_SPECS[id]?.label || "Agent"} 登录窗口`,
        detail: error?.message || error,
        retryable: true,
        suggestedAction: "重新检查运行器路径后再试",
      }));
    };
    child.once?.("spawn", started);
    child.once?.("error", failed);
    if (child.pid && typeof child.once !== "function") started();
  });
  return {
    ok: true,
    runnerId: id,
    message: "已打开 WorkBuddy；请在 WorkBuddy 界面完成登录（若未出现登录页，可在会话中输入 /login），完成后回到神思点击“重新检查登录”",
    requiresUserConfirmation: true,
  };
};

// Unlike the safe startup probe (which only reads --help), this bounded check
// is called only after the user explicitly starts the login flow. It proves
// the account session with one real CLI request and never loops indefinitely.
export const verifyKnownAgentRunnerLogin = async ({
  runnerId,
  cwd = process.cwd(),
  environment = process.env,
  machineRoot = "",
  resolveLaunch = resolveKnownAgentRunnerLaunch,
  runProcess = runAgentRunnerInstallerProcess,
} = {}) => {
  const id = clean(runnerId);
  if (id !== "workbuddy") return { authenticated: null, authState: "unknown", state: "unknown", ready: false, message: "当前运行器不支持登录验证" };
  try {
    const bridge = await inspectWorkBuddyDesktopBridge({ cwd, environment });
    if (bridge?.authenticated === true) {
      const probe = await runWorkBuddyDesktopBridge({
        prompt: "Connection test. Reply with exactly SHENSI_LOGIN_PROBE_OK.",
        model: "auto",
        cwd,
        environment,
        timeoutMs: 120_000,
      });
      if (/SHENSI_LOGIN_PROBE_OK/iu.test(String(probe.text || ""))) {
        return {
          authenticated: true,
          authState: "authenticated",
          state: "ready",
          ready: true,
          models: bridge.models || [],
          modelLabels: bridge.modelLabels || {},
          catalogSource: bridge.catalogSource || "workbuddy_acp_session",
          message: "WorkBuddy 桌面登录会话有效，神思 ACP 真实连接成功",
        };
      }
    }
  } catch (error) {
    if (error?.code !== "WORKBUDDY_DESKTOP_BRIDGE_UNAVAILABLE") {
      return { authenticated: null, authState: "unknown", state: "unknown", ready: false, message: clean(error?.message || error).slice(0, 500) };
    }
  }
  const launch = await resolveLaunch({ runnerId: id, environment, machineRoot });
  const args = [...(Array.isArray(launch.prefixArgs) ? launch.prefixArgs : []), "-p", "--input-format", "text", "--output-format", "text", "--model", "auto", "--no-session-persistence"];
  let result;
  try {
    result = await runProcess({
      executable: launch.executable,
      args,
      stdinText: "Reply with exactly SHENSI_LOGIN_PROBE_OK.",
      cwd,
      environment,
      timeoutMs: 45_000,
      outputSource: "node",
      maxOutputBytes: 16_000,
      operation: "probe",
    });
  } catch (error) {
    result = error?.result || null;
    if (!result) throw error;
  }
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  if (/(?:authentication required|login required|not logged in|please (?:sign|log) in|请先登录|未登录|登录状态(?:已)?(?:失效|无效))/iu.test(output)) {
    return { authenticated: false, authState: "login_required", state: "login_required", ready: false, message: "WorkBuddy 仍未检测到有效登录会话" };
  }
  if (/(?:quota|额度|余额|usage limit|rate limit|请求过多)/iu.test(output) || /SHENSI_LOGIN_PROBE_OK/iu.test(output)) {
    return { authenticated: true, authState: "authenticated", state: "ready", ready: true, message: "WorkBuddy 登录会话有效" };
  }
  return { authenticated: null, authState: "unknown", state: "unknown", ready: false, message: "WorkBuddy 登录验证未得到明确结果，请完成登录后重新检查" };
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
  const powershell = await firstAccessible([
    ...directories.map((directory) => join(directory, "powershell.exe")),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ], accessFile);
  return { winget, npmCli, powershell, npmPrefix: join(roamingAppData, "npm") };
};

export const runAgentRunnerInstallerProcess = ({
  executable,
  args = [],
  stdinText = "",
  cwd = process.cwd(),
  environment = process.env,
  timeoutMs = INSTALL_TIMEOUT_MS,
  outputSource = "auto",
  maxOutputBytes = MAX_PROCESS_OUTPUT,
  acceptOutputOnTimeout = false,
  signal = null,
  spawnProcess = spawn,
  operation = "install",
} = {}) => new Promise((resolveProcess, rejectProcess) => {
  const probing = operation === "probe";
  if (!clean(executable)) return rejectProcess(new Error(probing ? "运行器检查没有找到可执行程序" : "安装器没有找到可执行程序"));
  const input = String(stdinText || "");
  const child = spawnProcess(executable, args.map((item) => String(item)), {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timer = null;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(value);
  };
  child.stdout?.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    stdoutBytes += buffer.length;
    stdoutChunks.push(buffer);
    while (stdoutBytes > maxOutputBytes && stdoutChunks.length) stdoutBytes -= stdoutChunks.shift().length;
  });
  child.stderr?.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    stderrBytes += buffer.length;
    stderrChunks.push(buffer);
    while (stderrBytes > maxOutputBytes && stderrChunks.length) stderrBytes -= stderrChunks.shift().length;
  });
  if (input) {
    child.stdin?.on?.("error", (error) => finish(rejectProcess, createAgentRunnerError({
      stage: probing ? "login_probe" : "package_install",
      code: probing ? "AGENT_RUNNER_PROBE_STDIN_FAILED" : "AGENT_RUNNER_INSTALL_STDIN_FAILED",
      summary: probing ? "运行器检查输入失败" : "安装器输入失败",
      detail: error?.message || error,
      retryable: true,
      suggestedAction: probing ? "重新检查运行器登录状态后重试" : "重新执行安装",
    })));
    child.stdin?.end?.(input);
  }
  child.once("error", (error) => finish(rejectProcess, createAgentRunnerError({
    stage: error?.code === "ENOENT" ? "executable_resolution" : "package_install",
    code: String(error?.code || "AGENT_RUNNER_INSTALL_PROCESS_FAILED"),
    summary: error?.code === "ENOENT"
      ? probing ? "无法启动运行器检查：找不到本机程序" : "无法启动官方安装程序：找不到本机安装工具"
      : probing ? "运行器检查无法启动" : "官方安装程序无法启动",
    detail: error?.message || error,
    retryable: error?.code === "ENOENT",
    suggestedAction: error?.code === "ENOENT" ? "点击重新检查安装前置组件" : "检查系统权限后重试",
  })));
  child.once("close", (exitCode) => {
    const result = {
      exitCode: Number(exitCode ?? -1),
      stdout: clean(decodeAgentRunnerOutput(Buffer.concat(stdoutChunks), outputSource)).slice(-maxOutputBytes),
      stderr: clean(decodeAgentRunnerOutput(Buffer.concat(stderrChunks), outputSource)).slice(-maxOutputBytes),
    };
    if (result.exitCode === 0) return finish(resolveProcess, result);
    const reason = result.stderr || result.stdout || `退出代码 ${result.exitCode}`;
    const error = createAgentRunnerError({
      stage: probing ? "version_probe" : "package_install",
      code: probing ? "AGENT_RUNNER_PROBE_PROCESS_FAILED" : "AGENT_RUNNER_INSTALL_PROCESS_FAILED",
      summary: probing ? "运行器检查失败" : "官方安装程序执行失败",
      detail: reason.slice(-1_200),
      exitCode: result.exitCode,
      retryable: true,
      suggestedAction: probing ? "重新检查运行器路径、登录状态或网络后重试" : "检查网络、代理和系统权限后重试",
    });
    error.result = result;
    finish(rejectProcess, error);
  });
  if (signal) {
    if (signal.aborted) {
      try { child.kill(); } catch {}
    } else signal.addEventListener("abort", () => { try { child.kill(); } catch {} }, { once: true });
  }
  timer = setTimeout(() => {
    const timedOutResult = {
      exitCode: 0,
      stdout: clean(decodeAgentRunnerOutput(Buffer.concat(stdoutChunks), outputSource)).slice(-maxOutputBytes),
      stderr: clean(decodeAgentRunnerOutput(Buffer.concat(stderrChunks), outputSource)).slice(-maxOutputBytes),
    };
    if (acceptOutputOnTimeout && (timedOutResult.stdout || timedOutResult.stderr)) {
      finish(resolveProcess, timedOutResult);
      try { child.kill(); } catch {}
      return;
    }
    try { child.kill(); } catch {}
    const error = createAgentRunnerError({
      stage: probing ? "version_probe" : "package_install",
      code: probing ? "AGENT_RUNNER_PROBE_TIMEOUT" : "AGENT_RUNNER_INSTALL_TIMEOUT",
      summary: probing ? "运行器检查超时" : "安装超时",
      detail: probing ? `运行器在 ${Math.round(timeoutMs / 1_000)} 秒内没有返回检查结果` : `安装在 ${Math.round(timeoutMs / 60_000)} 分钟内没有完成`,
      retryable: true,
      suggestedAction: probing ? "检查运行器登录状态或网络后重新检查" : "检查网络或代理后重试",
    });
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

const downloadOfficialPowerShellScript = async ({
  spec,
  report = () => {},
  fetchImpl = globalThis.fetch,
  tempRoot,
} = {}) => {
  const sourceUrl = String(spec?.installScriptUrl || "").trim();
  let parsedUrl;
  try { parsedUrl = new URL(sourceUrl); } catch {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_URL_INVALID", summary: `${spec?.label || "Agent 运行器"} 官方安装地址无效`, suggestedAction: "检查软件内置的官方安装源配置" });
  }
  if (parsedUrl.protocol !== "https:" || !spec.allowedScriptHosts?.includes(parsedUrl.hostname)) {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_HOST_REJECTED", summary: `${spec.label} 官方脚本来源未通过安全校验`, detail: parsedUrl.hostname, suggestedAction: `只允许使用 ${spec.label} 官方 HTTPS 安装源` });
  }
  if (typeof fetchImpl !== "function") {
    throw createAgentRunnerError({ stage: "network", code: "AGENT_RUNNER_FETCH_UNAVAILABLE", summary: "当前环境无法下载官方安装脚本", retryable: true, suggestedAction: "检查网络后重试" });
  }
  report({ stage: "download", progress: 22, message: `正在下载 ${spec.label} 官方安装脚本…` });
  let response;
  try { response = await fetchImpl(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(60_000) }); } catch (error) {
    throw createAgentRunnerError({ stage: "network", code: "AGENT_RUNNER_SCRIPT_DOWNLOAD_FAILED", summary: `${spec.label} 官方脚本下载失败`, detail: error?.message || error, retryable: true, suggestedAction: "检查网络、代理或防火墙后重试" });
  }
  let finalUrl;
  try { finalUrl = new URL(response?.url || sourceUrl); } catch {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_URL_INVALID", summary: `${spec.label} 官方脚本最终地址无效`, suggestedAction: `只允许使用 ${spec.label} 官方 HTTPS 安装源` });
  }
  if (finalUrl.protocol !== "https:" || !spec.allowedScriptHosts?.includes(finalUrl.hostname)) {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_REDIRECT_REJECTED", summary: `${spec.label} 官方脚本重定向到了非官方域名`, detail: finalUrl.hostname, suggestedAction: `只允许使用 ${spec.label} 官方 HTTPS 安装源` });
  }
  if (!response?.ok) {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_HTTP_FAILED", summary: `${spec.label} 官方脚本下载失败（HTTP ${response?.status || "?"}）`, retryable: Number(response?.status) >= 500, suggestedAction: "检查网络、代理或官方服务状态后重试" });
  }
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType && !/(?:text\/plain|text\/x-powershell|application\/x-powershell|application\/octet-stream)/u.test(contentType)) {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_CONTENT_TYPE_INVALID", summary: `${spec.label} 官方脚本内容类型异常`, detail: contentType, suggestedAction: "不要执行非脚本响应，请稍后重新检查官方安装源" });
  }
  const payload = Buffer.from(await response.arrayBuffer());
  if (!payload.length || payload.length > 2 * 1024 * 1024) {
    throw createAgentRunnerError({ stage: "download", code: "AGENT_RUNNER_SCRIPT_SIZE_INVALID", summary: `${spec.label} 官方脚本大小异常`, detail: `${payload.length} bytes`, suggestedAction: "重新检查官方安装源" });
  }
  const scriptSha256 = createHash("sha256").update(payload).digest("hex");
  const safeId = clean(spec.id).replace(/[^a-z0-9_-]/giu, "-") || "agent";
  const scriptPath = join(tempRoot, `${safeId}-install-official.ps1`);
  const wrapperPath = join(tempRoot, `${safeId}-install-wrapper.ps1`);
  await writeFile(scriptPath, payload);
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop",
    "if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) { throw 'Get-FileHash is unavailable (Microsoft.PowerShell.Utility)' }",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$scriptPath = '${scriptPath.replaceAll("'", "''")}'`,
    "& $scriptPath",
  ].join("\r\n");
  // Windows PowerShell 5.1 treats UTF-8 without a BOM as the active ANSI
  // code page while parsing a file. Prefix a BOM so the wrapper is decoded
  // deterministically before its UTF-8 console settings can take effect.
  await writeFile(wrapperPath, `\uFEFF${wrapper}`, "utf8");
  return { wrapperPath, scriptSha256, sourceUrl };
};

export const installAgentRunnerFromOfficialSource = async ({
  runnerId,
  cwd = process.cwd(),
  environment = process.env,
  nodeExecutable = process.execPath,
  report = () => {},
  locateTools = locateWindowsInstallTools,
  runProcess = runAgentRunnerInstallerProcess,
  resolveLaunch = resolveKnownAgentRunnerLaunch,
  fetchImpl = globalThis.fetch,
  signal = null,
} = {}) => {
  const spec = AGENT_RUNNER_INSTALL_SPECS[clean(runnerId)];
  if (!spec) {
    throw createAgentRunnerError({ code: "AGENT_RUNNER_NOT_ALLOWED", stage: "prerequisite", summary: "不支持安装这个 Agent 运行器" });
  }
  if (process.platform !== "win32") {
    throw createAgentRunnerError({ runnerId, stage: "prerequisite", code: "AGENT_RUNNER_INSTALL_PLATFORM_UNSUPPORTED", summary: "当前一键装配仅支持 Windows 桌面版" });
  }
  if (spec.installKind === "manual") {
    throw createAgentRunnerError({ runnerId, stage: "prerequisite", code: "AGENT_RUNNER_MANUAL_SETUP_REQUIRED", summary: `${spec.label} 需要在设置中填写可执行程序和参数模板，不提供自动下载安装` });
  }
  let tools = await locateTools({ environment });
  const npmEnvironment = { ...environment, NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
  if (spec.installKind === "powershell_script") {
    if (!tools.powershell) {
      throw createAgentRunnerError({ runnerId, stage: "prerequisite", code: "AGENT_RUNNER_INSTALL_TOOL_MISSING", summary: `无法自动装配 ${spec.label}：本机没有 Windows PowerShell`, suggestedAction: "安装或启用 Windows PowerShell 后重试" });
    }
    const tempRoot = await mkdtemp(join(process.env.TEMP || process.env.TMP || ".", `shensi-${spec.id}-install-`));
    try {
      const script = await downloadOfficialPowerShellScript({ spec, report, fetchImpl, tempRoot });
      report({ stage: "installing", progress: 34, message: `正在通过 ${spec.label} 官方 PowerShell 脚本装配…`, method: "powershell", scriptSha256: script.scriptSha256 });
      try {
        await runProcess({
          executable: tools.powershell,
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script.wrapperPath],
          cwd,
          // The desktop host can inherit PowerShell 7 or bundled-runtime module
          // paths that shadow Windows PowerShell's built-in Utility module. Let
          // Windows PowerShell rebuild its own standard PSModulePath so the
          // official Trae installer can reliably use Get-FileHash.
          environment: windowsPowerShellInstallEnvironment(environment),
          outputSource: "powershell",
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Trae's Windows installer currently creates a nested junction for its
        // stable command path. Some Windows/Node combinations cannot launch
        // through that junction even though the verified release binary is
        // complete. Accept recovery only after the real release path itself
        // passes an independent version probe.
        try {
          const launch = await resolveLaunch({ runnerId: spec.id, environment });
          await runProcess({
            executable: launch.executable,
            args: [...(launch.prefixArgs || []), "--version"],
            cwd,
            environment,
            outputSource: "node",
            signal,
          });
          return {
            method: "powershell",
            officialUrl: spec.officialUrl,
            scriptSha256: script.scriptSha256,
            recoveredFromInstallerExit: true,
            cliPath: launch.executable,
            prefixArgs: launch.prefixArgs || [],
          };
        } catch {
          throw error;
        }
      }
      return { method: "powershell", officialUrl: spec.officialUrl, scriptSha256: script.scriptSha256 };
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (spec.installKind === "npm" && tools.npmCli && spec.npmPackage) {
    report({ stage: "installing", progress: 34, message: `正在通过官方 npm 包装配 ${spec.label}…`, method: "npm" });
    await runProcess({
      executable: nodeExecutable,
      args: [tools.npmCli, ...npmInstallArgs({ prefix: tools.npmPrefix, packageName: spec.npmPackage })],
      cwd,
      environment: npmEnvironment,
      outputSource: "npm",
      signal,
    });
    return { method: "npm", officialUrl: spec.officialUrl };
  }
  if (spec.wingetId && tools.winget) {
    report({ stage: "installing", progress: 34, message: `正在通过 Windows 官方包管理器装配 ${spec.label}…`, method: "winget" });
    await runProcess({ executable: tools.winget, args: wingetInstallArgs(spec.wingetId), cwd, environment, outputSource: "winget", signal });
    return { method: "winget", officialUrl: spec.officialUrl };
  }
  if (spec.installKind === "npm" && !tools.npmCli && tools.winget) {
    report({ stage: "prerequisite", progress: 18, message: `本机缺少 npm，正在为 ${spec.label} 安装官方 Node.js LTS 前置组件…`, method: "winget+npm" });
    await runProcess({ executable: tools.winget, args: wingetInstallArgs("OpenJS.NodeJS.LTS"), cwd, environment, outputSource: "winget", signal });
    tools = await locateTools({ environment });
    if (!tools.npmCli) {
      throw createAgentRunnerError({ runnerId, stage: "executable_resolution", code: "AGENT_RUNNER_NPM_REFRESH_REQUIRED", summary: `Node.js 已安装，但当前进程仍未找到 npm；${spec.label} 尚未完成装配`, retryable: true, suggestedAction: "点击重新检查；无需重启软件即可再次定位 npm" });
    }
    report({ stage: "installing", progress: 48, message: `正在通过 ${spec.label} 官方 npm 包完成装配…`, method: "winget+npm" });
    await runProcess({
      executable: nodeExecutable,
      args: [tools.npmCli, ...npmInstallArgs({ prefix: tools.npmPrefix, packageName: spec.npmPackage })],
      cwd,
      environment: npmEnvironment,
      outputSource: "npm",
      signal,
    });
    return { method: "winget+npm", officialUrl: spec.officialUrl };
  }
  throw createAgentRunnerError({
    runnerId,
    stage: "prerequisite",
    code: "AGENT_RUNNER_INSTALL_TOOL_MISSING",
    summary: `无法自动装配 ${spec.label}：本机没有可用的 npm${spec.wingetId ? " 或 Windows 包管理器" : "，也没有 Windows 包管理器可安装前置组件"}`,
    suggestedAction: "安装 Node.js/npm 或启用 Windows 包管理器后重新检查",
  });
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
  scriptSha256: clean(job.scriptSha256, 128),
  state: clean(job.state || job.status),
  error: job.error && typeof job.error === "object" ? { ...job.error } : null,
  suggestedAction: clean(job.suggestedAction),
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
  const controllers = new Map();
  const cleanup = () => {
    const cutoff = now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.updatedAt < cutoff && job.status !== "running") jobs.delete(id);
  };
  const update = (job, patch = {}) => {
    Object.assign(job, patch, { updatedAt: now() });
    return publicJob(job);
  };
  const completedPatch = (spec, capability, messagePrefix = "") => {
    const runnerManaged = spec.id === "workbuddy";
    const loginRequired = capability?.authState === "login_required" || capability?.state === "login_required";
    const modelAttention = capability?.modelState === "failed" || capability?.modelState === "manual_configuration_required";
    const ready = capability?.ready === true || capability?.state === "ready";
    return {
      status: "completed",
      state: capability?.state || (ready ? "ready" : loginRequired ? "login_required" : "failed"),
      stage: loginRequired ? "login_probe" : modelAttention ? "model_probe" : "completed",
      progress: 100,
      message: loginRequired
        ? `${spec.label} 已安装并通过版本复检，但尚未登录`
        : modelAttention
          ? `${spec.label} 已安装并通过版本复检，但模型能力尚未就绪`
          : ready
            ? runnerManaged
              ? `${spec.label} 已安装，登录与模型能力检查通过`
              : messagePrefix || `${spec.label} 已安装并通过版本复检`
            : `${messagePrefix || `${spec.label} 已安装，但尚未完成可用性检查`}`,
      capability,
    };
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
      state: "running", error: null, suggestedAction: "", capability: null, createdAt: now(), updatedAt: now(),
    };
    jobs.set(job.id, job);
    activeByRunner.set(spec.id, job.id);
    const controller = new AbortController();
    controllers.set(job.id, controller);
    void (async () => {
      try {
        const before = await detectRunner(spec.id, { force: true });
        if (before?.available === true || before?.installed === true) {
          update(job, completedPatch(spec, before, `${spec.label} 已安装并通过版本复检，无需重复装配`));
          return;
        }
        update(job, { stage: "preparing", progress: 10, message: `正在准备 ${spec.label} 官方安装源…` });
        const result = await installRunner({
          runnerId: spec.id,
          cwd,
          report: (patch) => update(job, patch),
          signal: controller.signal,
        });
        update(job, { stage: "validating", progress: 88, message: "安装已完成，正在重新检测版本和可执行状态…", method: result?.method || job.method, scriptSha256: result?.scriptSha256 || job.scriptSha256 });
        await onInstalled(spec.id, { result });
        const after = await detectRunner(spec.id, { force: true });
        if (after?.available !== true && after?.installed !== true) {
          throw createAgentRunnerError({ runnerId: spec.id, stage: "version_probe", code: "AGENT_RUNNER_POST_INSTALL_CHECK_FAILED", summary: `${spec.label} 安装程序已结束，但版本复检未通过`, retryable: true, suggestedAction: "重新检查本机路径或重新装配" });
        }
        update(job, {
          ...completedPatch(spec, after, `${spec.label} 已完成下载、装配和版本复检`),
          officialUrl: result?.officialUrl || spec.officialUrl,
        });
      } catch (error) {
        const cancelled = controller.signal.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError";
        const structured = {
          runnerId: spec.id,
          stage: clean(error?.stage || "package_install"),
          code: clean(error?.code || "AGENT_RUNNER_INSTALL_FAILED"),
          summary: clean(error?.summary || error?.message || error).slice(0, 1_200),
          detail: clean(error?.detail || error?.message || error).slice(0, 4_000),
          exitCode: Number.isFinite(Number(error?.exitCode)) ? Number(error.exitCode) : null,
          retryable: error?.retryable === true,
          suggestedAction: clean(error?.suggestedAction),
        };
        update(job, {
          status: cancelled ? "cancelled" : error?.code === "AGENT_RUNNER_POST_INSTALL_CHECK_FAILED" ? "partial_install" : "failed",
          state: cancelled ? "cancelled" : error?.code === "AGENT_RUNNER_POST_INSTALL_CHECK_FAILED" ? "partial_install" : "failed",
          stage: cancelled ? "cancelled" : structured.stage,
          progress: cancelled ? job.progress : 0,
          message: cancelled ? `${spec.label} 装配已终止` : structured.summary,
          error: structured,
          suggestedAction: structured.suggestedAction,
        });
      } finally {
        if (activeByRunner.get(spec.id) === job.id) activeByRunner.delete(spec.id);
        controllers.delete(job.id);
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
    async cancel(jobId) {
      const job = jobs.get(clean(jobId));
      if (!job || job.status !== "running") return job ? publicJob(job) : null;
      controllers.get(job.id)?.abort();
      update(job, { status: "cancelled", state: "cancelled", stage: "cancelled", message: `${job.label} 装配已终止` });
      return publicJob(job);
    },
  };
};
