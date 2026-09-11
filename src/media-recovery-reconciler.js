// Keep the eventual recovery loop close to the provider poller so a result
// already present in the asset store is rebound to its card without a visible
// multi-second "后台完成、卡片未完成" gap.
export const DEFAULT_MEDIA_RECOVERY_INTERVAL_MS = 15_000;
export const DEFAULT_MEDIA_RECOVERY_FETCH_ATTEMPTS = 4;

const responsePayload = async (response, fallback = {}) => {
  try {
    return await response.json();
  } catch {
    return fallback;
  }
};

const retryableRecoveryStatus = (status) => status === 408 || status === 425 || status === 429 || status >= 500;

export const isMediaRecoveryTransportError = (error) => error?.code === "MEDIA_RECOVERY_TRANSPORT_UNAVAILABLE"
  || (error instanceof TypeError && /fetch|network|load/i.test(String(error.message || "")));

export const fetchMediaRecoveryJobs = async ({
  fetchFn = globalThis.fetch?.bind(globalThis),
  workspacePath,
  includeApplied = true,
  includeSmoke = true,
  pendingOnly = false,
  attempts = DEFAULT_MEDIA_RECOVERY_FETCH_ATTEMPTS,
  delayFn = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
} = {}) => {
  if (typeof fetchFn !== "function") throw new TypeError("媒体恢复缺少 fetch 实现");
  const totalAttempts = Math.max(1, Math.min(8, Math.trunc(Number(attempts) || 1)));
  const workspaceQuery = encodeURIComponent(String(workspacePath || ""));
  const emptySmokeResponse = { ok: true, status: 200, json: async () => ({ ok: true, jobs: [] }) };
  let lastError = null;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const [response, globalResponse, smokeResponse] = await Promise.all([
        fetchFn(`/api/generation/jobs?workspacePath=${workspaceQuery}&includeApplied=${includeApplied ? "true" : "false"}`, { cache: "no-store" }),
        fetchFn(pendingOnly ? "/api/generation/jobs/pending-media" : "/api/generation/jobs?includeApplied=false", { cache: "no-store" }),
        includeSmoke
          ? fetchFn("/api/generation/jobs?includeApplied=true&targetType=capability-smoke", { cache: "no-store" })
          : Promise.resolve(emptySmokeResponse),
      ]);
      const [payload, globalPayload, smokePayload] = await Promise.all([
        responsePayload(response, { ok: false, jobs: [], message: "生成任务恢复响应无效" }),
        responsePayload(globalResponse, { ok: false, jobs: [], message: "跨工作区媒体任务恢复响应无效" }),
        responsePayload(smokeResponse, { ok: false, jobs: [] }),
      ]);
      const retryResponse = [response, globalResponse].find((candidate) => retryableRecoveryStatus(Number(candidate.status)));
      if (retryResponse && attempt < totalAttempts) {
        lastError = new Error(payload.message || globalPayload.message || `本机媒体服务暂不可用（HTTP ${retryResponse.status}）`);
      } else {
        return { response, globalResponse, smokeResponse, payload, globalPayload, smokePayload, attemptsUsed: attempt };
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < totalAttempts) await delayFn(Math.min(1_600, 150 * (2 ** (attempt - 1))));
  }
  const unavailable = new Error("本机媒体服务暂未响应");
  unavailable.code = "MEDIA_RECOVERY_TRANSPORT_UNAVAILABLE";
  unavailable.cause = lastError;
  throw unavailable;
};

const swallowScheduledFailure = (operation) => {
  Promise.resolve(operation).catch(() => {});
};

export const createMediaRecoveryReconciler = ({
  recover,
  shouldRun = () => true,
  intervalMs = DEFAULT_MEDIA_RECOVERY_INTERVAL_MS,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
} = {}) => {
  if (typeof recover !== "function") throw new TypeError("媒体恢复协调器缺少 recover 函数");

  let inFlight = null;
  let timer = null;
  let started = false;

  const run = (options = {}) => {
    if (inFlight) return inFlight;
    const operation = Promise.resolve().then(() => recover(options));
    let tracked;
    tracked = operation.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  const trigger = () => {
    if (!shouldRun()) return;
    swallowScheduledFailure(run());
  };
  const onVisibilityChange = () => trigger();
  const onFocus = () => trigger();

  const start = () => {
    if (started) return;
    started = true;
    windowTarget?.addEventListener?.("focus", onFocus);
    documentTarget?.addEventListener?.("visibilitychange", onVisibilityChange);
    if (typeof setIntervalFn === "function") timer = setIntervalFn(trigger, intervalMs);
  };

  const stop = () => {
    if (!started) return;
    started = false;
    windowTarget?.removeEventListener?.("focus", onFocus);
    documentTarget?.removeEventListener?.("visibilitychange", onVisibilityChange);
    if (timer !== null && typeof clearIntervalFn === "function") clearIntervalFn(timer);
    timer = null;
  };

  return {
    run,
    start,
    stop,
    get active() {
      return started;
    },
    get pending() {
      return Boolean(inFlight);
    },
  };
};
