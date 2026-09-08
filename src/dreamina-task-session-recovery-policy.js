const AUTH_SESSION_CODES = new Set([
  "DREAMINA_AUTH_REQUIRED",
  "DREAMINA_PROVIDER_SESSION_EXPIRED",
]);

export const DEFAULT_DREAMINA_TASK_SESSION_RECOVERY_WINDOW_MS = 60 * 1_000;
export const DEFAULT_DREAMINA_TASK_SESSION_RECOVERY_MAX_ATTEMPTS = 3;

// Once the provider returned a task ID, preserve that task and its named
// account profile through short-lived authsdk losses before asking the user to
// repeat OAuth. Account mismatch and duplicate-account failures are excluded:
// they are identity-safety failures, not recoverable task-session failures.
export const dreaminaTaskSessionRecoveryPolicy = ({
  job = {},
  code = "",
  now = Date.now(),
  windowMs = DEFAULT_DREAMINA_TASK_SESSION_RECOVERY_WINDOW_MS,
  maxAttempts = DEFAULT_DREAMINA_TASK_SESSION_RECOVERY_MAX_ATTEMPTS,
} = {}) => {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const providerTaskId = String(job?.providerTaskId || "").trim();
  if (!providerTaskId || !AUTH_SESSION_CODES.has(normalizedCode)) {
    return { applies: false, expired: false, attempts: 0, delayMs: 0 };
  }
  const nowMs = Number(now) || Date.now();
  const savedStartedAt = Date.parse(String(job?.dreaminaSessionRecoveryStartedAt || ""));
  const startedAtMs = Number.isFinite(savedStartedAt) ? savedStartedAt : nowMs;
  const attempts = Math.max(0, Number(job?.dreaminaSessionRecoveryAttempts) || 0) + 1;
  const deadlineAtMs = startedAtMs + Math.max(30_000, Number(windowMs) || DEFAULT_DREAMINA_TASK_SESSION_RECOVERY_WINDOW_MS);
  const attemptLimit = Math.max(1, Number(maxAttempts) || DEFAULT_DREAMINA_TASK_SESSION_RECOVERY_MAX_ATTEMPTS);
  return {
    applies: true,
    expired: nowMs >= deadlineAtMs || attempts >= attemptLimit,
    attempts,
    delayMs: Math.min(20_000, 5_000 * (2 ** Math.min(2, attempts - 1))),
    startedAt: new Date(startedAtMs).toISOString(),
    deadlineAt: new Date(deadlineAtMs).toISOString(),
  };
};
