import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalOpenCodeLaunch } from "./opencode-launch.mjs";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_MS = 30_000;
const caches = new Map();
const inFlights = new Map();

const normalizedCacheKey = (value = "") => String(value || "default").trim().slice(0, 1_000) || "default";

const safeMessage = (value = "") => String(value || "OpenCode 探测失败")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/gi, "[REDACTED]")
  .replace(/[\r\n]+/g, " ")
  .trim()
  .slice(0, 1_000);

const modelId = (value = "") => {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/.test(id) ? id : "";
};

export const parseOpenCodeModelCatalog = (raw = "") => {
  const clean = String(raw).replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "").trim();
  let values = [];
  let explicitDefault = "";
  try {
    const parsed = JSON.parse(clean);
    const source = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.models)
        ? parsed.models
        : Array.isArray(parsed?.data)
          ? parsed.data
          : [];
    values = source.map((item) => typeof item === "string" ? item : item?.id || item?.slug || item?.model);
    explicitDefault = modelId(parsed?.defaultModel || parsed?.default?.id || parsed?.default || "");
  } catch {
    values = clean.split(/\r?\n/).map((line) => line.trim().replace(/^[•*\-]\s*/, ""));
  }
  const metadataById = new Map();
  if (Array.isArray(values)) {
    const source = (() => {
      try {
        const parsed = JSON.parse(clean);
        return Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.models)
            ? parsed.models
            : Array.isArray(parsed?.data)
              ? parsed.data
              : [];
      } catch { return []; }
    })();
    for (const item of source) {
      const id = modelId(typeof item === "string" ? item : item?.id || item?.slug || item?.model);
      if (!id || !item || typeof item !== "object") continue;
      metadataById.set(id, {
        free: item.free === true || item.isFree === true || item.requiresLogin === false || item.requiresAuth === false,
        requiresLogin: item.requiresLogin,
        requiresAuth: item.requiresAuth,
        cost: item.cost || item.pricing || item.price || null,
        label: item.name || item.label || id,
        displayName: item.displayName || item.name || item.label || id,
      });
    }
  }
  const models = [...new Set(values.map(modelId).filter(Boolean))].map((id) => {
    const provider = id.slice(0, id.indexOf("/"));
    const metadata = metadataById.get(id) || {};
    const shortId = id.slice(id.indexOf("/") + 1).toLowerCase();
    return { id, slug: id, label: metadata.label || id, displayName: metadata.displayName || id, provider, ...metadata, free: metadata.free === true || /(?:^|[-:])free$/u.test(shortId) || shortId === "big-pickle" };
  });
  const groups = [...new Set(models.map((item) => item.provider))].map((provider) => ({
    provider,
    models: models.filter((item) => item.provider === provider),
  }));
  return { models, groups, defaultModel: explicitDefault };
};

const spawnCaptured = ({ executable, args, cwd, environment, timeoutMs }) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, {
    cwd,
    env: { ...environment, OPENCODE_DISABLE_AUTOUPDATE: "true" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectRun(error);
    else resolveRun(value);
  };
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) {
      child.kill();
      finish(new Error("OpenCode 模型目录输出超过 2MB，已停止探测"));
      return;
    }
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  child.once("error", (error) => finish(new Error(`OpenCode 无法启动：${safeMessage(error.message)}`)));
  child.once("close", (code) => code === 0
    ? finish(null, stdout)
    : finish(new Error(`OpenCode 退出码 ${code}：${safeMessage(stderr || "没有错误输出")}`)));
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error(`OpenCode 探测超过 ${Math.round(timeoutMs / 1000)} 秒`));
  }, timeoutMs);
  timer.unref?.();
});

const fetchOfficialZenCatalog = async ({ timeoutMs = 20_000 } = {}) => {
  if (typeof fetch !== "function") return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://opencode.ai/zen/v1/models", { signal: controller.signal });
    if (!response.ok) return "";
    const parsed = await response.json().catch(() => null);
    if (!parsed || !Array.isArray(parsed.data)) return "";
    return JSON.stringify({
      ...parsed,
      data: parsed.data.map((item) => ({
        ...(item && typeof item === "object" ? item : {}),
        id: String(item?.id || item?.slug || item?.model || "").includes("/")
          ? String(item?.id || item?.slug || item?.model || "")
          : `opencode/${String(item?.id || item?.slug || item?.model || "")}`,
      })),
    });
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
};

const mergeOpenCodeCatalogs = (primary = {}, secondary = {}) => {
  const byId = new Map();
  for (const item of [...(primary.models || []), ...(secondary.models || [])]) {
    const id = modelId(item?.id || item?.slug || item?.model);
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...item, id, slug: id });
  }
  const models = [...byId.values()];
  const providers = [...new Set(models.map((item) => item.provider || idProvider(item.id)))];
  return {
    models,
    groups: providers.map((provider) => ({ provider, models: models.filter((item) => (item.provider || idProvider(item.id)) === provider) })),
    defaultModel: primary.defaultModel || secondary.defaultModel || "",
  };
};

const idProvider = (id = "") => String(id).split("/", 1)[0] || "opencode";

const probe = async ({ cwd, environment, credentialSource = "opencode", launchResolver, timeoutMs }) => {
  const freeProbe = String(credentialSource || "").trim().toLowerCase() === "opencode_free";
  let isolationRoot = "";
  let probeEnvironment = environment;
  if (freeProbe) {
    isolationRoot = await mkdtemp(join(tmpdir(), "shensi-opencode-free-probe-"));
    const dirs = ["config", "data", "cache", "state"].map((name) => join(isolationRoot, name));
    await Promise.all(dirs.map((path) => mkdir(path, { recursive: true })));
    probeEnvironment = {
      ...environment,
      XDG_CONFIG_HOME: dirs[0],
      XDG_DATA_HOME: dirs[1],
      XDG_CACHE_HOME: dirs[2],
      XDG_STATE_HOME: dirs[3],
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled" }),
    };
    delete probeEnvironment.OPENCODE_API_KEY;
    delete probeEnvironment.SHENSI_OPENCODE_API_KEY;
  }
  try {
    const launch = await launchResolver({ environment: probeEnvironment });
    const prefix = Array.isArray(launch?.prefixArgs) ? launch.prefixArgs : [];
    const versionOutput = await spawnCaptured({
      executable: launch.executable,
      args: [...prefix, "--version"],
      cwd,
      environment: probeEnvironment,
      timeoutMs: Math.min(timeoutMs, 8_000),
    });
    let catalogOutput = "";
    for (const args of [[...prefix, "models", "--pure"], [...prefix, "models", "--standalone"]]) {
      try {
        catalogOutput = await spawnCaptured({ executable: launch.executable, args, cwd, environment: probeEnvironment, timeoutMs });
        if (parseOpenCodeModelCatalog(catalogOutput).models.length) break;
      } catch {
        // Older and desktop OpenCode builds expose different model commands.
      }
    }
    let parsed = parseOpenCodeModelCatalog(catalogOutput);
    // The isolated free CLI can return a non-empty but stale local catalog.
    // Always merge the public, login-free Zen directory for this credential
    // source instead of using it only as an empty-catalog fallback.  This keeps
    // the desktop's newer free models visible while retaining CLI-only entries.
    if (freeProbe) {
      const official = parseOpenCodeModelCatalog(await fetchOfficialZenCatalog({ timeoutMs }));
      if (official.models.length) parsed = mergeOpenCodeCatalogs(parsed, official);
    }
    if (!parsed.models.length) throw new Error("OpenCode 没有返回任何完整 provider/model 模型 ID");
    return {
      available: true,
      version: String(versionOutput).split(/\r?\n/)[0].trim() || "OpenCode CLI",
      cliPath: "opencode",
      credentialSource: freeProbe ? "opencode_free" : "opencode",
      modelsVerified: true,
      ...parsed,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    if (isolationRoot) await rm(isolationRoot, { recursive: true, force: true }).catch(() => {});
  }
};

const abortable = (promise, signal) => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error("OpenCode 模型探测已取消"), { name: "AbortError" }));
  return new Promise((resolveRun, rejectRun) => {
    const abort = () => rejectRun(Object.assign(new Error("OpenCode 模型探测已取消"), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolveRun, rejectRun).finally(() => signal.removeEventListener("abort", abort));
  });
};

export const detectOpenCodeModelCatalog = ({
  cwd = process.cwd(),
  force = false,
  environment = process.env,
  launchResolver = resolveLocalOpenCodeLaunch,
  timeoutMs = 20_000,
  cacheMs = DEFAULT_CACHE_MS,
  signal = null,
  cacheKey = "default",
  credentialSource = "opencode",
} = {}) => {
  const key = normalizedCacheKey(cacheKey);
  const now = Date.now();
  const cached = caches.get(key);
  if (!force && cached && now - cached.savedAt < cacheMs) return abortable(Promise.resolve(cached.value), signal);
  if (!inFlights.has(key)) {
    const pending = probe({ cwd, environment, launchResolver, timeoutMs, credentialSource })
      .then((value) => {
        caches.set(key, { value, savedAt: Date.now() });
        return value;
      })
      .finally(() => { inFlights.delete(key); });
    inFlights.set(key, pending);
  }
  return abortable(inFlights.get(key), signal);
};

export const resetOpenCodeModelCatalogCache = (cacheKey = "") => {
  const key = String(cacheKey || "").trim();
  if (key) {
    caches.delete(normalizedCacheKey(key));
    inFlights.delete(normalizedCacheKey(key));
    return;
  }
  caches.clear();
  inFlights.clear();
};
