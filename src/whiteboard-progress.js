const finiteNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

const generationModel = (candidate = {}) => String(
  candidate?.model
    || candidate?.request?.settings?.model
    || candidate?.settings?.model
    || candidate?.generationProfile?.model
    || "",
).trim().toLowerCase();

// Seedance 2.5 uses the provider's queued status as an accepted/processing
// phase, not as a user-visible vendor queue. Keep this distinction local to
// presentation so durable task state remains suitable for recovery/cancel.
export const whiteboardProviderIsDirectGeneration = (candidate = {}) => {
  const model = generationModel(candidate);
  return /(?:seedance|doubao[-_ ]?seedance)[-_ .]?2(?:[-_. ]?5)(?:$|[-_. :])/u.test(model)
    || /seedance2[._-]5/u.test(model);
};

export const whiteboardProviderQueueVisible = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  if (String(current.providerStatus || "").trim().toLowerCase() !== "queued") return false;
  const position = finiteNumber(current.providerQueuePosition);
  const length = finiteNumber(current.providerQueueLength);
  // Empty/null/zero queue fields are placeholders, not evidence of a queue.
  // Seedance 2.5 often uses queued for accepted/processing, but explicit
  // position/length data is a real queue and must hide generation percentage.
  return (position !== null && position > 0) || (length !== null && length > 0);
};

const timestampMilliseconds = (value) => {
  const numeric = finiteNumber(value);
  if (numeric !== null && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const ACTIVE_MEDIA_TIMER_STATUSES = new Set([
  "connecting",
  "queued",
  "submitting",
  "running",
  "polling",
  "downloading",
  "cancel_requested",
]);

const ACTIVE_MEDIA_PROGRESS_STATUSES = new Set([
  "submitting",
  "running",
  "polling",
]);

export const whiteboardMediaProviderAccepted = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  if (!["image", "video", "audio"].includes(String(current.channel || ""))) return false;
  return Boolean(String(current.providerTaskId || "").trim())
    || String(current.submissionState || "") === "submitted"
    || timestampMilliseconds(current.submittedAt) !== null;
};

// A verified local attachment means the provider generation itself has
// finished. Card persistence/readback may still be pending, but the
// generation stopwatch must no longer present that bookkeeping as provider
// generation time. The durable job remains active until card readback passes.
export const whiteboardGenerationResultReady = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  if (!current.resultReady && !current.result?.attachment?.relativePath && !current.attachment?.relativePath) return false;
  return String(current.channel || "") === "image";
};

export const whiteboardGenerationConnectionPhase = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  const channel = String(current.channel || "text");
  const status = String(current.status || "");
  if (["image", "video", "audio"].includes(channel)) {
    if (whiteboardMediaProviderAccepted(current)) return false;
    return ["connecting", "queued", "submitting", "running", "polling"].includes(status);
  }
  return status === "connecting" || (!String(current.jobId || "").trim()
    && !["complete", "failed", "retry_required"].includes(status));
};

export const whiteboardGenerationMeasurementActive = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  if (current.cardApplyFailed === true) return false;
  if (whiteboardGenerationResultReady(current)) return false;
  // Provider completion is not the end of the user-visible task. Keep the
  // timer alive while the saved result is being written back and verified on
  // the originating card, then freeze it only after readback succeeds.
  if (current.cardApplyStage === "saving" || current.cardApplyStage === "verifying") return true;
  const channel = String(current.channel || "text");
  if (["image", "video", "audio"].includes(channel)) {
    return ACTIVE_MEDIA_TIMER_STATUSES.has(String(current.status || ""))
      || current.automaticRecoveryInProgress === true;
  }
  return ["connecting", "queued", "submitting", "running", "polling", "streaming"].includes(String(current.status || ""));
};

export const whiteboardGenerationProgressActive = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  if (current.cardApplyFailed === true) return false;
  if (whiteboardGenerationResultReady(current)) return false;
  if (String(current.providerErrorCode || current.errorCode || "").trim().toUpperCase()
    === "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING") return false;
  const channel = String(current.channel || "text");
  if (["image", "video", "audio"].includes(channel)) {
    if (whiteboardProviderQueueVisible(current)) return false;
    if (whiteboardGenerationConnectionPhase(current)) return false;
    const progressStatuses = whiteboardProviderIsDirectGeneration(current)
      ? new Set([...ACTIVE_MEDIA_PROGRESS_STATUSES, "queued"])
      : ACTIVE_MEDIA_PROGRESS_STATUSES;
    return whiteboardMediaProviderAccepted(current)
      && progressStatuses.has(String(current.status || ""));
  }
  return Boolean(String(current.jobId || "").trim())
    && ["running", "polling", "streaming"].includes(String(current.status || ""));
};

export const whiteboardGenerationStartedAt = (candidate = {}, { now = Date.now() } = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  const existing = timestampMilliseconds(current.startedAt);
  if (existing !== null) return existing;
  const createdAt = timestampMilliseconds(current.createdAt);
  if (createdAt !== null) return createdAt;
  return timestampMilliseconds(now) ?? Date.now();
};

export const whiteboardGenerationProgressTarget = (candidate = {}) => {
  const current = candidate && typeof candidate === "object" ? candidate : {};
  const media = ["image", "video", "audio"].includes(String(current.channel || ""));
  if (media && current.status === "complete") return 100;
  if (!whiteboardGenerationProgressActive(current)) return null;
  const providerProgress = finiteNumber(current.providerProgressPercent);
  const stageProgress = finiteNumber(current.progressPercent);
  const raw = media && providerProgress !== null && providerProgress > 0
    ? providerProgress
    : stageProgress;
  if (raw === null) return null;
  return Math.min(99, Math.max(0, raw));
};

export const syntheticMediaProgress = ({ elapsedMs = 0, channel = "image" } = {}) => {
  const elapsed = Math.max(0, finiteNumber(elapsedMs) ?? 0);
  const timeConstant = String(channel || "") === "video" ? 45 * 60_000 : 60_000;
  const estimated = 28 + 71 * (1 - Math.exp(-elapsed / timeConstant));
  return Math.min(99, Math.max(0, estimated));
};

export const monotonicElapsedMs = ({ previous = 0, incoming = 0, startedAt = 0, now = Date.now() } = {}) => {
  const previousValue = Math.max(0, finiteNumber(previous) ?? 0);
  const incomingValue = Math.max(0, finiteNumber(incoming) ?? 0);
  const startedAtMs = timestampMilliseconds(startedAt);
  const nowMs = timestampMilliseconds(now) ?? Date.now();
  const localValue = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
  return Math.max(previousValue, incomingValue, localValue);
};

export const formatGenerationDuration = (milliseconds = 0, { english = false } = {}) => {
  const roundedSeconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  if (roundedSeconds < 60) return english ? `${roundedSeconds}s` : `${roundedSeconds}秒`;
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return english ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${minutes}分${String(seconds).padStart(2, "0")}秒`;
};

export const monotonicProgress = (previous, next, {
  minimum = 1,
  maximum = 100,
  maxStep = Infinity,
} = {}) => {
  const previousValue = finiteNumber(previous);
  const nextValue = finiteNumber(next);
  const floor = Math.min(maximum, Math.max(minimum, previousValue ?? minimum));
  if (nextValue === null) return floor;
  const bounded = Math.min(maximum, Math.max(minimum, nextValue));
  return Math.min(maximum, Math.max(floor, Math.min(bounded, floor + Math.max(0, Number(maxStep) || 0))));
};

export const smoothProgressStep = (previous, next, {
  minimum = 0,
  maximum = 100,
  remainingFrames = 5,
} = {}) => {
  const previousValue = finiteNumber(previous);
  const nextValue = finiteNumber(next);
  const floor = Math.min(maximum, Math.max(minimum, previousValue ?? minimum));
  if (nextValue === null) return floor;
  const target = Math.min(maximum, Math.max(minimum, nextValue));
  if (target <= floor) return floor;
  const frameCount = Math.max(1, Math.round(Number(remainingFrames) || 1));
  return monotonicProgress(floor, target, {
    minimum,
    maximum,
    maxStep: Math.max(1, Math.ceil((target - floor) / frameCount)),
  });
};
