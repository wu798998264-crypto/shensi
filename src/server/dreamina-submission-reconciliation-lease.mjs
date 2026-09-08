export const DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS = 30 * 60_000;

const timestamp = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const dreaminaSubmissionReconciliationLease = (job = {}, {
  now = Date.now(),
  leaseMs = DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS,
} = {}) => {
  const startedAt = timestamp(job.automaticRecoveryStartedAt || job.createdAt || job.startedAt);
  const stoppedAt = timestamp(job.automaticRecoveryStoppedAt);
  const stopped = stoppedAt > 0 && (!startedAt || stoppedAt >= startedAt);
  const duration = Math.max(1_000, Number(leaseMs) || DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS);
  const expiresAt = startedAt ? startedAt + duration : 0;
  return {
    startedAt,
    stoppedAt,
    expiresAt,
    stopped,
    expired: !stopped && expiresAt > 0 && Number(now) >= expiresAt,
  };
};

