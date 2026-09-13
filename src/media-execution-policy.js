const normalized = (value) => String(value || "").trim().toLowerCase();

export const boundedCliMediaJob = (job = {}) => ["image", "video", "audio"].includes(job.channel)
  && normalized(job.request?.settings?.adapter) === "cli"
  && ["即梦", "dreamina", "libtv"].includes(normalized(job.request?.settings?.provider));

export const MEDIA_CONNECTION_RETRY_LIMIT = 3;
export const MEDIA_CONNECTION_RETRY_WINDOW_MS = 2 * 60_000;

// Count failures, not normal provider observations. Healthy long-running
// generation may continue for hours; a broken connection may not do so.
export const mediaConnectionRetry = (job = {}, {
  nowMs = Date.now(), maxRetries = MEDIA_CONNECTION_RETRY_LIMIT,
  windowMs = MEDIA_CONNECTION_RETRY_WINDOW_MS,
} = {}) => {
  const recorded = Date.parse(job.connectionRetryStartedAt || "");
  const startedAt = Number.isFinite(recorded) ? recorded : nowMs;
  const attempts = Math.max(0, Number(job.connectionRetryAttempts || 0)) + 1;
  const deadline = startedAt + windowMs;
  return {
    connectionRetryStartedAt: new Date(startedAt).toISOString(),
    connectionRetryDeadlineAt: new Date(deadline).toISOString(),
    connectionRetryAttempts: attempts,
    connectionRetryExhausted: attempts > maxRetries || nowMs >= deadline,
  };
};

export const clearedMediaConnectionRetry = () => ({
  connectionRetryStartedAt: "", connectionRetryDeadlineAt: "",
  connectionRetryAttempts: 0, connectionRetryExhausted: false,
});

export const mediaGenerationHasTerminalProviderFailure = (job = {}) => normalized(job.status) === "failed"
  && normalized(job.providerStatus) === "failed"
  && Boolean(String(job.providerErrorCode || job.errorCode || job.error || "").trim());

export const mediaGenerationIssueNeedsCard = (job = {}) => !job.supersededBy
  && (!job.userStoppedAt && !job.resultSuppressed && !job.userStopped
    || mediaGenerationHasTerminalProviderFailure(job))
  && !["complete", "cancelled", "superseded"].includes(normalized(job.status))
  && (Boolean(String(job.error || "").trim())
    || ["failed", "retry_required", "waiting_credentials", "waiting_storage", "reconciliation_required"].includes(normalized(job.status)));
