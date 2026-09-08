import { spawn } from "node:child_process";
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
    const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    values = source.map((item) => typeof item === "string" ? item : item?.id || item?.slug || item?.model);
    explicitDefault = modelId(parsed?.defaultModel || parsed?.default?.id || parsed?.default || "");
  } catch {
    values = clean.split(/\r?\n/).map((line) => line.trim().replace(/^[•*\-]\s*/, ""));
  }
  const models = [...new Set(values.map(modelId).filter(Boolean))].map((id) => {
    const provider = id.slice(0, id.indexOf("/"));
    return { id, slug: id, label: id, displayName: id, provider };
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

const probe = async ({ cwd, environment, launchResolver, timeoutMs }) => {
  const launch = await launchResolver({ environment });
  const prefix = Array.isArray(launch?.prefixArgs) ? launch.prefixArgs : [];
  const versionOutput = await spawnCaptured({
    executable: launch.executable,
    args: [...prefix, "--version"],
    cwd,
    environment,
    timeoutMs: Math.min(timeoutMs, 8_000),
  });
  const catalogOutput = await spawnCaptured({
    executable: launch.executable,
    args: [...prefix, "models", "--pure"],
    cwd,
    environment,
    timeoutMs,
  });
  const parsed = parseOpenCodeModelCatalog(catalogOutput);
  if (!parsed.models.length) throw new Error("OpenCode 没有返回任何完整 provider/model 模型 ID");
  return {
    available: true,
    version: String(versionOutput).split(/\r?\n/)[0].trim() || "OpenCode CLI",
    cliPath: "opencode",
    modelsVerified: true,
    ...parsed,
    checkedAt: new Date().toISOString(),
  };
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
} = {}) => {
  const key = normalizedCacheKey(cacheKey);
  const now = Date.now();
  const cached = caches.get(key);
  if (!force && cached && now - cached.savedAt < cacheMs) return abortable(Promise.resolve(cached.value), signal);
  if (!inFlights.has(key)) {
    const pending = probe({ cwd, environment, launchResolver, timeoutMs })
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
