const DREAMINA_ACTIVE_STATUSES = new Set([
  "queued",
  "submitting",
  "running",
  "polling",
  "downloading",
  "waiting_credentials",
]);

const DREAMINA_CANCEL_SWITCH_GRACE_MS = 30 * 60_000;
const DREAMINA_RECONCILIATION_SWITCH_GRACE_MS = 10 * 60_000;

const normalized = (value) => String(value || "").trim().toLowerCase();

export const dreaminaCliProfileId = (settings = {}) => validDreaminaCliProfileId(settings.dreaminaCliProfile)
  ? normalizeDreaminaCliProfileId(settings.dreaminaCliProfile)
  : "";

export const requireDreaminaCliProfileId = (settings = {}) => {
  const profileId = dreaminaCliProfileId(settings);
  if (profileId) return profileId;
  const supplied = String(settings.dreaminaCliProfile || "").trim();
  const code = supplied ? "DREAMINA_PROFILE_ID_INVALID" : "DREAMINA_PROFILE_REQUIRED";
  const message = supplied
    ? "即梦配置 ID 无效，请重新选择配置"
    : "当前连接未指定即梦账号，请重新选择配置";
  throw Object.assign(new Error(message), { code, providerErrorCode: code, statusCode: 422 });
};

const normalizedIdentity = (value) => String(value || "").trim().toLowerCase();

// A profile id is only a UI/configuration label. Once a profile has been
// verified, the account identity must be the switch-lock key so aliases that
// point to the same Dreamina account can run together.
export const dreaminaCredentialIdentity = (value = {}) => {
  const storedKey = normalizedIdentity(value?.profileIdentityKey || "");
  if (/^(?:user|credential):[^\s:]+$/u.test(storedKey)) return storedKey;
  const source = value?.request?.settings || value?.settings || value || {};
  const verifiedUserId = normalizedIdentity(
    value?.credentialIdentityUserId
      || value?.verifiedUserId
      || source.verifiedUserId
      || source.userId,
  );
  if (verifiedUserId) return `user:${verifiedUserId}`;
  const fingerprint = normalizedIdentity(
    value?.credentialIdentityFingerprint
      || value?.credentialFingerprint
      || source.credentialFingerprint,
  );
  if (fingerprint && fingerprint !== "unverified" && fingerprint !== "none") return `credential:${fingerprint}`;
  return "";
};

export const isDreaminaCliSettings = (settings = {}) => ["即梦", "dreamina"].includes(normalized(settings.provider))
  && normalized(settings.adapter) === "cli";

const withinGraceWindow = (activityAt, nowMs, graceMs) => {
  return activityAt > 0 && Math.max(0, nowMs - activityAt) <= graceMs;
};

export const dreaminaCancellationReconciliationExpired = (job = {}, { nowMs = Date.now() } = {}) => {
  if (normalized(job.status) !== "cancel_requested") return false;
  const requestedAt = Date.parse(job.cancelRequestedAt || job.createdAt || "") || 0;
  return requestedAt > 0 && nowMs - requestedAt > DREAMINA_CANCEL_SWITCH_GRACE_MS;
};

export const dreaminaJobRequiresCredentialProfile = (job = {}, { nowMs = Date.now() } = {}) => {
  if (!isDreaminaCliSettings(job.request?.settings || {})) return false;
  const status = normalized(job.status);
  const providerStatus = normalized(job.providerStatus);
  // Provider terminal state releases profile switching immediately. Download,
  // asset persistence and card readback have their own lifecycle and must not
  // hold the single Windows credential slot hostage.
  if (["completed", "complete", "succeeded", "success", "failed", "cancelled", "canceled"].includes(providerStatus)) return false;
  // A user stop is authoritative even if a recovery path subsequently moves
  // the job to waiting_credentials or retry_required. Cancellation auditing
  // must never reacquire the one shared Dreamina credential slot.
  if (normalized(job.desiredAction) === "cancel" || job.userStoppedAt) return false;
  if (DREAMINA_ACTIVE_STATUSES.has(status)) return true;
  // The user's cancel action immediately releases the profile-switch gate.
  // Provider-side cancellation may still be verified in the background, but
  // that audit work must never hold another Dreamina profile hostage.
  if (status === "cancel_requested") return false;
  if (["retry_required", "reconciliation_required"].includes(status)
    && normalized(job.providerStatus) === "reconciling") {
    const reconciliationStartedAt = Date.parse(job.recoveryStartedAt || job.automaticRecoveryStartedAt || job.interruptedAt || job.createdAt || "") || 0;
    return withinGraceWindow(reconciliationStartedAt, nowMs, DREAMINA_RECONCILIATION_SWITCH_GRACE_MS);
  }
  return false;
};

// Compatibility export for older callers. The old name described a card
// result condition, but the policy now answers only whether provider
// communication still requires keeping the current credential profile.
export const dreaminaJobAwaitsCardResult = dreaminaJobRequiresCredentialProfile;

export const dreaminaProfileSwitchDecision = ({ jobs = [], requestedProfileId = "", requestedCredentialIdentity = "", nowMs = Date.now() } = {}) => {
  const requested = validDreaminaCliProfileId(requestedProfileId)
    ? normalizeDreaminaCliProfileId(requestedProfileId)
    : "";
  if (!requested) return {
    allowed: false,
    queuedBehindCurrent: false,
    activeProfileId: "",
    blockingJobId: "",
    reason: "profile_required",
  };
  const requestedIdentity = normalizedIdentity(requestedCredentialIdentity);
  const blockingJobs = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => dreaminaJobRequiresCredentialProfile(job, { nowMs }))
    .sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
  if (!blockingJobs.length) return {
    allowed: true,
    queuedBehindCurrent: false,
    activeProfileId: "",
    blockingJobId: "",
  };
  const different = blockingJobs.find((job) => {
    const activeIdentity = normalizedIdentity(dreaminaCredentialIdentity(job));
    if (requestedIdentity && activeIdentity) return activeIdentity !== requestedIdentity;
    return dreaminaCliProfileId(job.request?.settings) !== requested;
  });
  const active = different || blockingJobs[0];
  const activeProfileId = dreaminaCliProfileId(active.request?.settings);
  return {
    allowed: !different,
    queuedBehindCurrent: false,
    activeProfileId,
    blockingJobId: String(active.id || ""),
  };
};

export const dreaminaProfileSwitchMessage = (decision = {}) => {
  if (decision.reason === "profile_required") return "当前连接未指定即梦账号，请重新选择已绑定真实账号的即梦配置。";
  if (decision.reason === "submission_outcome_unknown") {
    const current = String(decision.activeProfileId || "当前配置");
    return `即梦配置“${current}”的一次视频提交没有返回可确认的厂商任务编号，账号核验状态仍然有效。为避免重复扣费，神思已暂停新的即梦提交并保留原任务记录；请打开“查看占用任务”，必要时手动终止本机任务，再决定是否重新生成。不要重复核验账号。`;
  }
  const current = String(decision.activeProfileId || "当前配置");
  return `即梦 CLI 当前只有一个共享凭证锁。配置“${current}”仍有生成任务尚未结束；同一即梦配置可继续排队，但其他即梦配置暂时无法生成。手动停止后会立即释放切换限制。非即梦配置不受影响。`;
};
import { normalizeDreaminaCliProfileId, validDreaminaCliProfileId } from "./media-cli-presets.js";
