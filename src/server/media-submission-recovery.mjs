import { boundedCliMediaJob, mediaConnectionRetry } from "../media-execution-policy.js";
const normalizedProviderCode = (error = {}) => String(error.providerErrorCode || error.code || "").toUpperCase();
const normalizedIdentity = (value) => String(value || "").trim().toLowerCase();
const normalizedEndpoint = (value) => String(value || "").trim().replace(/\/+$/u, "").toLowerCase();

export const BUILTIN_AGGREGATE_IMAGE_CONNECTION_ID = "image-cockpit-aggregate-api";
export const BUILTIN_AGGREGATE_IMAGE_ENDPOINT = "http://127.0.0.1:5317/v1";
export const DEFAULT_AGGREGATE_IMAGE_RECOVERY_POLL_MS = 1_500;
// The aggregate image gateway can reject a request after waiting one minute
// for its upstream stream. Keep the original idempotency key alive long enough
// to cover several provider cold-start/overload windows before asking for a
// manual decision. This never creates a second key or an unbounded retry loop.
export const DEFAULT_AGGREGATE_IMAGE_RECOVERY_WINDOW_MS = 15 * 60_000;
export const DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS = 8;
const AGGREGATE_IMAGE_REFERENCE_EDIT_RELEASED_AT = Date.parse("2026-08-30T09:40:39.981Z");
const UPSTREAM_STREAM_OPEN_TIMEOUT_PATTERN = /(?:upstream[_ -]?first[_ -]?byte[_ -]?timeout|upstream[\s\S]{0,100}timed out[\s\S]{0,100}stream[_ -]?open)/iu;

export const isUpstreamStreamOpenTimeout = (value = {}) => {
  const source = typeof value === "string"
    ? value
    : `${value?.providerErrorCode || value?.code || ""} ${value?.message || value?.error || ""}`;
  return UPSTREAM_STREAM_OPEN_TIMEOUT_PATTERN.test(String(source || ""));
};

export const builtInAggregateImageRecoveryJob = (job = {}) => {
  const settings = job.request?.settings ?? {};
  const persistedEndpoint = normalizedEndpoint(settings.baseUrl);
  return String(job.channel || "") === "image"
    && normalizedIdentity(settings.adapter) === "api"
    && normalizedIdentity(settings.provider) === "自定义兼容接口"
    && String(settings.connectionId || settings.id || "").trim() === BUILTIN_AGGREGATE_IMAGE_CONNECTION_ID
    // Persistent generation jobs deliberately omit baseUrl from their public
    // request snapshot. The reserved built-in connection id is authoritative
    // in that shape; when an endpoint is present it must still match exactly.
    && (!persistedEndpoint || persistedEndpoint === BUILTIN_AGGREGATE_IMAGE_ENDPOINT)
    && Boolean(String(job.idempotencyKey || "").trim());
};

export const aggregateImageRecoveryPolicy = (job = {}, {
  now = Date.now(),
  pollMs = DEFAULT_AGGREGATE_IMAGE_RECOVERY_POLL_MS,
  windowMs = DEFAULT_AGGREGATE_IMAGE_RECOVERY_WINDOW_MS,
  maxAttempts = DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS,
} = {}) => {
  const nowMs = Number(now) || Date.now();
  const recordedStartedAt = Date.parse(String(job.automaticRecoveryStartedAt || ""));
  const recoveryStartedAtMs = Number.isFinite(recordedStartedAt) ? recordedStartedAt : nowMs;
  const recoveryDeadlineAtMs = recoveryStartedAtMs + Math.max(1_000, Number(windowMs) || DEFAULT_AGGREGATE_IMAGE_RECOVERY_WINDOW_MS);
  const attempts = Math.max(0, Number(job.aggregateRecoveryAttempts) || 0);
  const attemptLimit = Math.max(1, Number(maxAttempts) || DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS);
  const expired = attempts >= attemptLimit || nowMs >= recoveryDeadlineAtMs;
  const delayMs = Math.min(15_000, Math.max(500, Number(pollMs) || DEFAULT_AGGREGATE_IMAGE_RECOVERY_POLL_MS) * (2 ** Math.min(3, attempts)));
  return {
    attempts,
    maxAttempts: attemptLimit,
    expired,
    recoveryStartedAt: new Date(recoveryStartedAtMs).toISOString(),
    recoveryDeadlineAt: new Date(recoveryDeadlineAtMs).toISOString(),
    recoveryLastCheckedAt: new Date(nowMs).toISOString(),
    nextPollAt: expired ? "" : new Date(nowMs + delayMs).toISOString(),
  };
};

export const legacyAggregateReferencePreflightFailurePatch = (job = {}, { now = Date.now() } = {}) => {
  const createdAt = Date.parse(String(job.createdAt || job.startedAt || ""));
  const references = Array.isArray(job.request?.referenceMedia) ? job.request.referenceMedia : [];
  const legacyFailure = builtInAggregateImageRecoveryJob(job)
    && job.mode === "server"
    && job.status === "retry_required"
    && !job.providerTaskId
    && job.providerStatus === "submitting"
    && job.submissionState === "submitting"
    && job.billingRisk === "submission_outcome_unknown"
    && !String(job.providerErrorCode || "")
    && references.some((item) => String(item?.mimeType || "").startsWith("image/"))
    && Number.isFinite(createdAt)
    && createdAt < AGGREGATE_IMAGE_REFERENCE_EDIT_RELEASED_AT
    && /提交期间连接中断，未取得厂商任务 ID/.test(String(job.error || ""));
  if (!legacyFailure) return null;
  const migratedAt = new Date(Number(now) || Date.now()).toISOString();
  return {
    status: "failed",
    providerStatus: "not_submitted",
    providerErrorCode: "LEGACY_AGGREGATE_IMAGE_REFERENCE_PREFLIGHT",
    submissionState: "not_submitted",
    progressPercent: 100,
    failedAt: migratedAt,
    nextPollAt: "",
    safeNoTaskRetry: true,
    billingRisk: "",
    resubmitConfirmationRequired: false,
    automaticRecoveryStoppedAt: migratedAt,
    legacyRecoveryKind: "aggregate_reference_preflight_v1",
    error: "旧版本尚未接入聚合 API 参考图端点，本任务在向厂商提交前已经停止，没有生成、没有扣费。当前版本已支持参考图，可直接重新生成。",
    heartbeatAt: migratedAt,
  };
};

const safeRejectedImageRetry = (code) => code === "HTTP_408"
  || code === "HTTP_429"
  || /^HTTP_5\d\d$/.test(code);

const safeKnownNoTaskRetry = (code) => [
  "DREAMINA_PROFILE_BROKER_BUSY",
  "DREAMINA_CONTROL_PLANE_TRANSIENT",
  "DREAMINA_CREDIT_QUERY_TIMEOUT",
  "DRIVER_TIMEOUT",
  "DREAMINA_TASK_RESOURCE_UNVERIFIED",
  "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED",
  "DREAMINA_REFERENCE_UPLOAD_NO_TASK",
].includes(code);

export const classifyMediaSubmissionFailure = ({ job = {}, error = {}, maxAutomaticRetries = 3 } = {}) => {
  const failureCount = Number(job.transientFailures || 0) + 1;
  const upstreamStreamOpenTimeout = isUpstreamStreamOpenTimeout(error);
  const aggregateUpstreamStreamOpenTimeout = builtInAggregateImageRecoveryJob(job) && upstreamStreamOpenTimeout;
  const submissionUnknown = job.status === "submitting"
    && !job.providerTaskId
    && (error.submissionOutcomeKnown !== true || aggregateUpstreamStreamOpenTimeout);
  const code = normalizedProviderCode(error);
  const connectionRetry = boundedCliMediaJob(job) ? mediaConnectionRetry(job, { maxRetries: maxAutomaticRetries }) : {};
  const safeAutomaticRetry = error.submissionOutcomeKnown === true
    && !job.providerTaskId
    && (safeKnownNoTaskRetry(code) || (job.channel === "image" && safeRejectedImageRetry(code)))
    && connectionRetry.connectionRetryExhausted !== true
    && failureCount <= Math.max(0, Number(maxAutomaticRetries) || 0);
  const retryDelayMs = safeAutomaticRetry
    ? Math.max(Number(error.retryAfterMs) || 0, Math.min(30_000, 1_000 * (2 ** Math.max(0, failureCount - 1))))
    : 0;
  return { submissionUnknown, safeAutomaticRetry, retryDelayMs, failureCount, upstreamStreamOpenTimeout, connectionRetry };
};
