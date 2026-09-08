export const DEFAULT_OPENAI_IMAGE_RECOVERY_POLL_MS = 2_500;
export const DEFAULT_OPENAI_IMAGE_RECOVERY_WINDOW_MS = 300_000;

const finiteMilliseconds = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
};

const timestamp = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const openAiImageRecoveryPolicy = (job = {}, {
  now = Date.now(),
  pollMs = DEFAULT_OPENAI_IMAGE_RECOVERY_POLL_MS,
  windowMs = DEFAULT_OPENAI_IMAGE_RECOVERY_WINDOW_MS,
} = {}) => {
  const checkedAt = finiteMilliseconds(now, Date.now(), 0, Number.MAX_SAFE_INTEGER);
  const effectivePollMs = finiteMilliseconds(pollMs, DEFAULT_OPENAI_IMAGE_RECOVERY_POLL_MS, 500, 30_000);
  const effectiveWindowMs = finiteMilliseconds(windowMs, DEFAULT_OPENAI_IMAGE_RECOVERY_WINDOW_MS, 5_000, 30 * 60_000);
  const existingStartedAt = timestamp(job.recoveryStartedAt);
  const startedAt = existingStartedAt || checkedAt;
  const deadlineAt = startedAt + effectiveWindowMs;
  const expired = checkedAt >= deadlineAt;
  return Object.freeze({
    expired,
    pollMs: effectivePollMs,
    windowMs: effectiveWindowMs,
    recoveryStartedAt: new Date(startedAt).toISOString(),
    recoveryDeadlineAt: new Date(deadlineAt).toISOString(),
    recoveryLastCheckedAt: new Date(checkedAt).toISOString(),
    nextPollAt: expired ? "" : new Date(Math.min(deadlineAt, checkedAt + effectivePollMs)).toISOString(),
  });
};
