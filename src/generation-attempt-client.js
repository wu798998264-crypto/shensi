const TERMINAL_ATTEMPT_STATUSES = new Set(["complete", "awaiting_action", "failed", "cancelled"]);

export const generationResultMayAutoLand = (result = {}) => {
  if (!String(result?.candidate || "").trim()) return false;
  if (result?.target?.landingBlocked === true) return false;

  const execution = result?.engineExecution && typeof result.engineExecution === "object"
    ? result.engineExecution
    : result?.execution && typeof result.execution === "object" ? result.execution : {};
  const attempt = result?.generationAttempt && typeof result.generationAttempt === "object"
    ? result.generationAttempt
    : {};
  // The result execution is finalized after the durable attempt snapshot was
  // attached to the response. During that small window the snapshot can still
  // say pending/not_requested while the exact same server run has already
  // reached passed/ready. Prefer the finalized execution pair when present;
  // otherwise a legitimate auto-land is stranded until the next reload.
  const authoritative = execution.validationStatus || execution.landingStatus ? execution : attempt;
  const validationStatuses = [authoritative.validationStatus].map((value) => String(value || "").trim()).filter(Boolean);
  const landingStatuses = [authoritative.landingStatus].map((value) => String(value || "").trim()).filter(Boolean);

  return validationStatuses.length > 0
    && validationStatuses.every((status) => status === "passed")
    && landingStatuses.length > 0
    && landingStatuses.every((status) => status === "ready");
};

export const generationResultMayDefaultLand = (result = {}) => {
  if (!String(result?.candidate || "").trim()) return false;
  if (result?.target?.landingBlocked === true) return false;

  const execution = result?.engineExecution && typeof result.engineExecution === "object"
    ? result.engineExecution
    : result?.execution && typeof result.execution === "object" ? result.execution : {};
  const attempt = result?.generationAttempt && typeof result.generationAttempt === "object"
    ? result.generationAttempt
    : {};
  const authoritative = execution.validationStatus || execution.landingStatus ? execution : attempt;
  const validationStatuses = [authoritative.validationStatus].map((value) => String(value || "").trim()).filter(Boolean);
  const landingStatuses = [authoritative.landingStatus].map((value) => String(value || "").trim()).filter(Boolean);

  // A warning already passed every deterministic hard gate and was previously
  // waiting only for an extra adoption click. The product default is now to
  // adopt and land unless the user explicitly asks to keep a preview.
  return validationStatuses.length > 0
    && validationStatuses.every((status) => status === "passed" || status === "warning" || status === "blocked")
    && landingStatuses.length > 0
    && landingStatuses.every((status) => status === "ready");
};

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const finish = () => {
    signal?.removeEventListener("abort", abort);
    resolve();
  };
  const timer = setTimeout(finish, milliseconds);
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reject(signal?.reason instanceof Error ? signal.reason : new DOMException("任务核对已停止", "AbortError"));
  };
  if (signal?.aborted) return abort();
  signal?.addEventListener("abort", abort, { once: true });
});

export const terminalGenerationAttempt = (payload) => {
  const attempt = payload?.attempt;
  if (!attempt || payload?.active === true) return null;
  const terminal = attempt.executionStatus === "terminal" || TERMINAL_ATTEMPT_STATUSES.has(attempt.status);
  if (!terminal) {
    return {
      ok: false,
      attempt,
      inactive: true,
      message: String(attempt.landingBlockReason || attempt.execution?.result || "后台任务已经结束，但还没有取得可校验的完整结果"),
    };
  }
  const resultPayload = attempt.resultData?.payload;
  if (resultPayload && typeof resultPayload === "object") {
    return { ok: true, payload: resultPayload, attempt };
  }
  return {
    ok: false,
    attempt,
    message: String(attempt.landingBlockReason || attempt.execution?.result || (
      attempt.status === "cancelled" ? "当前任务已终止" : "模型任务未能完成"
    )),
  };
};

export const waitForGenerationAttemptTerminal = async ({
  requestId,
  fetchAttempt = globalThis.fetch,
  intervalMs = 2_500,
  signal,
} = {}) => {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("缺少任务标识，无法核对后台结果");
  while (!signal?.aborted) {
    await delay(intervalMs, signal);
    let response;
    try {
      response = await fetchAttempt(`/api/generation/attempts/${encodeURIComponent(id)}`, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }
    if (!response?.ok) continue;
    const terminal = terminalGenerationAttempt(await response.json().catch(() => null));
    if (terminal) return terminal;
  }
  throw signal?.reason instanceof Error ? signal.reason : new DOMException("任务核对已停止", "AbortError");
};
