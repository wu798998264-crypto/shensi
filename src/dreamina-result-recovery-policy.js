const timestamp = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const DEFAULT_DREAMINA_RESULT_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_DREAMINA_RESULT_RECOVERY_ATTEMPTS = 180;

export const dreaminaResultRecoveryPolicy = ({
  job = {},
  errorCode = "",
  message = "",
  nowMs = Date.now(),
  windowMs = DEFAULT_DREAMINA_RESULT_RECOVERY_WINDOW_MS,
  maxAttempts = DEFAULT_DREAMINA_RESULT_RECOVERY_ATTEMPTS,
} = {}) => {
  const code = String(errorCode || "").trim().toUpperCase();
  const detail = String(message || "");
  const pendingResult = code === "DREAMINA_RESULT_PENDING"
    || (code === "DREAMINA_QUERY_TRANSIENT" && /(?:任务|厂商).{0,80}已完成.{0,80}(?:未返回|没有|尚未).{0,40}(?:可下载|结果文件|文件)/u.test(detail));
  if (!pendingResult) return { applies: false, expired: false, attempts: 0, startedAt: "" };
  const configuredWindow = Math.max(60_000, Number(windowMs) || DEFAULT_DREAMINA_RESULT_RECOVERY_WINDOW_MS);
  const configuredAttempts = Math.max(1, Number(maxAttempts) || DEFAULT_DREAMINA_RESULT_RECOVERY_ATTEMPTS);
  const existingStart = timestamp(job.resultRecoveryStartedAt)
    || timestamp(job.providerStateChangedAt)
    || timestamp(job.lastPolledAt)
    || timestamp(job.updatedAt)
    || nowMs;
  const attempts = Math.max(0, Number(job.resultRecoveryAttempts) || 0) + 1;
  const elapsedMs = Math.max(0, nowMs - existingStart);
  return {
    applies: true,
    expired: elapsedMs >= configuredWindow || attempts >= configuredAttempts,
    attempts,
    elapsedMs,
    startedAt: new Date(existingStart).toISOString(),
    expiresAt: new Date(existingStart + configuredWindow).toISOString(),
  };
};
