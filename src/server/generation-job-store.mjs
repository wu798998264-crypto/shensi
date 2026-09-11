import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { appDataRoot } from "./app-data.mjs";
import { sanitizeMediaProviderPrompt } from "../media-prompt.js";
import { normalizeNovelCoverAssetMetadata } from "../novel-cover-design.js";
import {
  LONG_VIDEO_MAX_DURATION_SECONDS,
  LONG_VIDEO_MIN_DURATION_SECONDS,
  normalizeSmartMultiframeTransitions,
  seedanceGenerationModeSupported,
  seedanceGenerationModesForModel,
  seedanceModelFamily,
  smartEditReferenceValidation,
  smartMultiframeDurationTotal,
} from "../video-generation-sequence.js";
import {
  canonicalMediaProfileSignature,
  CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX,
  MEDIA_CAPABILITY_EVIDENCE_MAX_AGE_MS,
} from "./media-profile-signature.mjs";
import {
  dreaminaCredentialIdentity,
  dreaminaJobRequiresCredentialProfile,
  dreaminaProfileSwitchDecision,
  dreaminaProfileSwitchMessage,
  isDreaminaCliSettings,
  requireDreaminaCliProfileId,
} from "../dreamina-manual-profile-policy.js";
import { dreaminaExpectedIdentitySync } from "./dreamina-profile-identity-store.mjs";
import { builtInAggregateImageRecoveryJob, legacyAggregateReferencePreflightFailurePatch } from "./media-submission-recovery.mjs";

const JOB_SCHEMA_VERSION = 3;
const RUNNING_STALE_MS = 15_000;
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MEDIA_CANCELLATION_FINALIZATION_MS = Math.max(
  60_000,
  Number(process.env.SHENSI_MEDIA_CANCELLATION_FINALIZATION_MS) || 30 * 60 * 1000,
);
const JOB_IO_LOCK_STALE_MS = Math.max(2_000, Number(process.env.SHENSI_JOB_IO_LOCK_STALE_MS) || 15_000);
const JOB_IO_LOCK_WAIT_MS = Math.max(JOB_IO_LOCK_STALE_MS + 1_000, Number(process.env.SHENSI_JOB_IO_LOCK_WAIT_MS) || 60_000);
const LEGACY_REPLACEMENT_RESERVATION_STALE_MS = Math.max(1_000, Number(process.env.SHENSI_LEGACY_REPLACEMENT_STALE_MS) || 60_000);
const LEGACY_REPLACEMENT_RESERVATION_HARD_STALE_MS = Math.max(
  LEGACY_REPLACEMENT_RESERVATION_STALE_MS,
  Number(process.env.SHENSI_LEGACY_REPLACEMENT_HARD_STALE_MS) || 10 * 60_000,
);
const CAPABILITY_SMOKE_LOCK_STALE_MS = Math.max(5_000, Number(process.env.SHENSI_CAPABILITY_SMOKE_LOCK_STALE_MS) || 30_000);
const MEDIA_SUBMISSION_ID = /^[a-z0-9][a-z0-9._:-]{15,199}$/i;
const SECRET_FIELD = /^(?:api|imageApi|videoApi)?key$|secret|authorization|accessToken|refreshToken/i;
const jobQueues = new Map();
const mediaCreationQueues = new Map();
const MEDIA_ACTIVE_STATUSES = new Set(["queued", "submitting", "running", "polling", "downloading", "cancel_requested"]);
const MEDIA_RESUMABLE_STATUSES = new Set(["waiting_credentials", "waiting_storage", "retry_required", "failed"]);
const CAPABILITY_SMOKE_REUSABLE_STATUSES = new Set([...MEDIA_ACTIVE_STATUSES, ...MEDIA_RESUMABLE_STATUSES]);
const RETENTION_TERMINAL_STATUSES = new Set(["complete", "cancelled", "superseded"]);

const jobsRoot = () => join(appDataRoot(), "generation-jobs");
const safeJobId = (jobId) => {
  const value = String(jobId || "").trim();
  if (!/^generation-[a-z0-9-]{20,}$/i.test(value)) throw new Error("生成任务编号无效");
  return value;
};
const jobPath = (jobId) => join(jobsRoot(), `${safeJobId(jobId)}.json`);
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const transientWindowsLockError = (error) => process.platform === "win32"
  && ["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code);

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

const readLockOwner = async (path) => {
  try {
    return JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const acquireJobIoLock = async (jobId) => {
  const lockRoot = join(jobsRoot(), ".update-locks");
  const lockPath = join(lockRoot, `${safeJobId(jobId)}.lock`);
  const token = `${process.pid}-${randomUUID()}`;
  await mkdir(lockRoot, { recursive: true });
  const deadline = Date.now() + JOB_IO_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = await readLockOwner(lockPath).catch(() => null);
        if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (transientWindowsLockError(error)) {
        await wait(25);
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      const [owner, lockMetadata] = await Promise.all([
        readLockOwner(lockPath).catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      const age = lockMetadata ? Date.now() - lockMetadata.mtimeMs : 0;
      if (lockMetadata && age > JOB_IO_LOCK_STALE_MS && (!owner || !processIsAlive(Number(owner.pid)))) {
        const abandonedPath = `${lockPath}.${process.pid}.${randomUUID()}.abandoned`;
        try {
          await rename(lockPath, abandonedPath);
          await rm(abandonedPath, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if (!["ENOENT", "EEXIST", "EPERM"].includes(recoveryError.code)) throw recoveryError;
        }
      }
      await wait(10);
    }
  }
  const error = new Error("生成任务正在被其他进程更新，请稍后重试");
  error.code = "GENERATION_JOB_BUSY";
  throw error;
};

const acquireCapabilitySmokeLock = async (profileSignature) => {
  const digest = createHash("sha256").update(String(profileSignature || "")).digest("hex");
  const lockRoot = join(jobsRoot(), ".capability-smoke-locks");
  const lockPath = join(lockRoot, `${digest}.lock`);
  const token = `${process.pid}-${randomUUID()}`;
  await mkdir(lockRoot, { recursive: true });
  const deadline = Date.now() + Math.max(60_000, CAPABILITY_SMOKE_LOCK_STALE_MS + 5_000);
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), "utf8");
        await writeFile(join(lockPath, "heartbeat.json"), JSON.stringify({ token, at: new Date().toISOString() }), "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      const heartbeat = setInterval(() => {
        writeFile(join(lockPath, "heartbeat.json"), JSON.stringify({ token, at: new Date().toISOString() }), "utf8").catch(() => {});
      }, 2_000);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        const owner = await readLockOwner(lockPath).catch(() => null);
        if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (transientWindowsLockError(error)) {
        await wait(25);
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      const [owner, heartbeatMetadata, lockMetadata] = await Promise.all([
        readLockOwner(lockPath).catch(() => null),
        stat(join(lockPath, "heartbeat.json")).catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      const activityMetadata = heartbeatMetadata || lockMetadata;
      const stale = activityMetadata && Date.now() - activityMetadata.mtimeMs > CAPABILITY_SMOKE_LOCK_STALE_MS;
      if (stale && (!owner || !processIsAlive(Number(owner.pid)))) {
        const abandonedPath = `${lockPath}.${process.pid}.${randomUUID()}.abandoned`;
        try {
          await rename(lockPath, abandonedPath);
          await rm(abandonedPath, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if (!["ENOENT", "EEXIST", "EPERM"].includes(recoveryError.code)) throw recoveryError;
        }
      }
      await wait(10);
    }
  }
  throw jobTransitionError("同一媒体能力验证任务正在创建，请稍后读取已有任务", "CAPABILITY_SMOKE_CREATE_BUSY", 503);
};

const withJobIoLock = async (jobId, operation) => {
  const release = await acquireJobIoLock(jobId);
  try {
    return await operation();
  } finally {
    await release();
  }
};

const enqueueMediaCreation = (key, operation) => {
  const queueKey = String(key || "media-create");
  const previous = mediaCreationQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  let tracked;
  tracked = current.finally(() => {
    if (mediaCreationQueues.get(queueKey) === tracked) mediaCreationQueues.delete(queueKey);
  });
  mediaCreationQueues.set(queueKey, tracked);
  return tracked;
};

const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const recoverySwapPath = async (path) => {
  const stableSwap = `${path}.swap`;
  if (await pathExists(stableSwap)) return stableSwap;
  const parent = dirname(path);
  const prefix = `${basename(path)}.`;
  const candidates = [];
  for (const entry of await readdir(parent, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".swap")) continue;
    const candidatePath = join(parent, entry.name);
    const metadata = await stat(candidatePath).catch(() => null);
    if (metadata) candidates.push({ path: candidatePath, mtimeMs: metadata.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path || "";
};

const recoverAtomicWrite = async (path) => {
  if (await pathExists(path)) return;
  const swap = await recoverySwapPath(path);
  if (!swap) return;
  try {
    await rename(swap, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
};

const atomicWrite = async (path, content) => {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const swap = `${path}.swap`;
  await recoverAtomicWrite(path);
  if (await pathExists(path)) await rm(swap, { force: true });
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let movedExisting = false;
  try {
    await rename(path, swap);
    movedExisting = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    if (movedExisting && !(await pathExists(path))) await rename(swap, path);
    throw error;
  }
  if (movedExisting) await rm(swap, { force: true }).catch(() => {});
  const directoryHandle = await open(parent, "r").catch(() => null);
  if (directoryHandle) {
    try { await directoryHandle.sync().catch(() => {}); } finally { await directoryHandle.close(); }
  }
};

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      const swap = await recoverySwapPath(path);
      if (!swap) return null;
      try {
        const recovered = JSON.parse(await readFile(swap, "utf8"));
        const damaged = `${path}.${Date.now()}.corrupt`;
        await rename(path, damaged);
        await rename(swap, path);
        return recovered;
      } catch (recoveryError) {
        if (recoveryError instanceof SyntaxError || recoveryError.code === "ENOENT") return null;
        throw recoveryError;
      }
    }
    throw error;
  }
};

const scrubSecrets = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, seen));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELD.test(key))
    .map(([key, item]) => [key, scrubSecrets(item, seen)]));
};

const generationJobElapsedMs = (job = {}) => {
  const startedAt = Date.parse(String(job.startedAt || job.createdAt || ""));
  if (!Number.isFinite(startedAt)) return Math.max(0, Number(job.elapsedMs) || 0);
  const stoppedAt = Date.parse(String(
    job.userStoppedAt
    || job.completedAt
    || job.cancelledAt
    || job.failedAt
    || job.supersededAt
    || "",
  ));
  const endedAt = Number.isFinite(stoppedAt) ? stoppedAt : Date.now();
  return Math.max(0, endedAt - startedAt);
};

export const publicGenerationJob = (job) => {
  const safe = scrubSecrets(job);
  if (!safe || typeof safe !== "object") return safe;
  if (safe.request && typeof safe.request === "object") {
    safe.request.generationProfile = publicGenerationProfile(safe.request.generationProfile);
  }
  delete safe.providerResultUrl;
  delete safe.replacementReservationId;
  delete safe.replacementReservationOwnerToken;
  delete safe.replacementReservationOwnerPid;
  delete safe.replacementSourceReservationId;
  const serverMedia = safe.mode === "server" && ["image", "video", "audio"].includes(safe.channel);
  const providerTerminalFailure = safe.status === "failed"
    && safe.providerStatus === "failed"
    && Boolean(safe.providerTaskId)
    && !safe.billingRisk;
  const terminal = ["complete", "cancelled", "superseded"].includes(safe.status)
    || providerTerminalFailure
    || Boolean(safe.supersededBy);
  const replacementPending = Boolean(job?.replacementReservationId);
  const dreaminaCliMedia = ["image", "video"].includes(safe.channel)
    && normalizedIdentity(safe.request?.settings?.adapter) === "cli"
    && ["即梦", "dreamina"].includes(normalizedIdentity(safe.request?.settings?.provider));
  const automaticRecoveryInProgress = safe.status === "retry_required"
    && safe.providerStatus === "reconciling"
    && Boolean(safe.nextPollAt);
  const safeNoTaskResubmit = !automaticRecoveryInProgress
    && !terminal
    && !replacementPending
    && safe.desiredAction !== "cancel"
    && !safe.providerTaskId
    && Boolean(safe.idempotencyKey)
    && safe.safeNoTaskRetry === true
    && safe.submissionState === "not_submitted"
    && !safe.billingRisk
    && MEDIA_RESUMABLE_STATUSES.has(safe.status);
  safe.automaticRecoveryInProgress = automaticRecoveryInProgress;
  safe.automaticRecoveryCreatesSubmission = false;
  safe.startedAt = safe.startedAt || safe.createdAt || "";
  safe.elapsedMs = generationJobElapsedMs(safe);
  safe.userStopped = Boolean(safe.userStoppedAt || safe.resultSuppressed);
  safe.cancelPending = !terminal && safe.desiredAction === "cancel";
  safe.availableActions = serverMedia ? {
    stop: !terminal && !replacementPending && !safe.userStopped && safe.desiredAction !== "cancel",
    cancel: !terminal && !replacementPending && !safe.userStopped && safe.desiredAction !== "cancel",
    resumeOriginal: !terminal && !replacementPending && safe.desiredAction !== "cancel" && Boolean(safe.providerTaskId) && (MEDIA_RESUMABLE_STATUSES.has(safe.status) || safe.status === "cancel_requested"),
    continueCancel: false,
    safeResubmit: safeNoTaskResubmit,
    confirmedResubmit: !safe.userStopped && !safeNoTaskResubmit && !automaticRecoveryInProgress && !terminal && !replacementPending && safe.desiredAction !== "cancel" && !safe.providerTaskId && Boolean(safe.idempotencyKey) && MEDIA_RESUMABLE_STATUSES.has(safe.status),
    replaceLegacy: !safe.userStopped && !terminal && !replacementPending && safe.desiredAction !== "cancel" && !safe.providerTaskId && !safe.idempotencyKey && MEDIA_RESUMABLE_STATUSES.has(safe.status),
    autoReconcileProviderTask: !safe.userStopped && dreaminaCliMedia && !terminal && !replacementPending && safe.desiredAction !== "cancel" && !safe.providerTaskId && Boolean(safe.idempotencyKey) && safe.billingRisk === "submission_outcome_unknown" && MEDIA_RESUMABLE_STATUSES.has(safe.status),
    dismissUncertain: !terminal && !replacementPending && mediaGenerationJobCanBeDismissed(safe),
    dismissCompleted: mediaGenerationJobCanBeAbandoned(safe),
  } : {};
  return safe;
};

const normalizedIdentity = (value) => String(value || "").trim().toLowerCase();

export const assertMediaGenerationProfileIdentity = ({ job, settings = {} } = {}) => {
  if (job?.mode !== "server" || !["image", "video", "audio"].includes(job?.channel)) {
    throw jobTransitionError("此任务不属于后台媒体队列", "MEDIA_JOB_PROFILE_IDENTITY_NOT_ALLOWED");
  }
  const expected = job.request?.settings || {};
  const expectedConnectionId = String(expected.connectionId || "").trim();
  const requestedConnectionId = String(settings.connectionId || settings.id || "").trim();
  if (expectedConnectionId && requestedConnectionId && expectedConnectionId !== requestedConnectionId) {
    throw jobTransitionError("续接或取消必须使用原任务的同一连接配置", "MEDIA_JOB_PROFILE_IDENTITY_MISMATCH");
  }
  for (const field of ["provider", "adapter", "protocol", "dreaminaCliProfile", "dreaminaExpectedIdentity"]) {
    const expectedValue = normalizedIdentity(expected[field]);
    const requestedValue = normalizedIdentity(settings[field]);
    if (expectedValue && requestedValue && expectedValue !== requestedValue) {
      throw jobTransitionError(`续接或取消不能更换原任务的 ${field}`, "MEDIA_JOB_PROFILE_IDENTITY_MISMATCH");
    }
  }
  return true;
};

const normalizedTarget = (target = {}) => ({
  workspaceKind: target.workspaceKind === "notebook" ? "notebook" : "project",
  workspacePath: String(target.workspacePath || "").trim() ? resolve(String(target.workspacePath).trim()) : "",
  documentId: String(target.documentId || ""),
  nodeId: String(target.nodeId || ""),
  targetType: ["document-artifact", "conversation-message", "capability-smoke", "composite-long-video-segment"].includes(target.targetType) ? target.targetType : "whiteboard-node",
  anchorId: String(target.anchorId || "").slice(0, 160),
  artifactId: String(target.artifactId || "").slice(0, 160),
  conversationId: String(target.conversationId || "").slice(0, 160),
  messageId: String(target.messageId || "").slice(0, 160),
  sourceMessageId: String(target.sourceMessageId || "").slice(0, 160),
  conversationBranchScope: String(target.conversationBranchScope || "").slice(0, 320),
  mediaBatchId: String(target.mediaBatchId || "").slice(0, 160),
  mediaBatchIndex: Math.max(0, Number(target.mediaBatchIndex) || 0),
  mediaBatchTotal: Math.max(0, Number(target.mediaBatchTotal) || 0),
  mediaBatchLabel: String(target.mediaBatchLabel || "").trim().slice(0, 240),
  landAfterGeneration: target.landAfterGeneration === true,
});

const assertGenerationTarget = (target) => {
  if (!target.workspacePath || !target.documentId) throw new Error("生成任务缺少目标工作区或文档");
  if (target.targetType === "capability-smoke") return;
  if (target.targetType === "document-artifact") {
    if (!target.anchorId || !target.artifactId) throw new Error("生成任务缺少正文锚点或配图编号");
    return;
  }
  if (target.targetType === "conversation-message") {
    if (!target.conversationId || !target.messageId) throw new Error("生成任务缺少对话或消息编号");
    return;
  }
  if (target.targetType === "composite-long-video-segment") {
    if (!target.nodeId || !target.artifactId) throw new Error("超长视频分段任务缺少目标卡片或生成清单编号");
    return;
  }
  if (!target.nodeId) throw new Error("生成任务缺少目标白板卡片");
};

const publicMultiframeTransitions = (request = {}) => {
  const references = Array.isArray(request.referenceMedia) ? request.referenceMedia : [];
  const frameCount = references.filter((item) => String(item?.mimeType || "").startsWith("image/")).length;
  const referenceTokens = Array.isArray(request.providerPromptReferenceTokens)
    ? request.providerPromptReferenceTokens
    : [];
  return normalizeSmartMultiframeTransitions(request.multiframeTransitions, {
    frameCount,
    defaultDuration: Number(request.duration) || 4,
  }).map((transition) => ({
    ...transition,
    prompt: sanitizeMediaProviderPrompt(transition.prompt, { referenceTokens }),
  }));
};

const publicGenerationProfile = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  if (!Object.keys(source).length) return {};
  const executionSurface = ["chat", "agent"].includes(String(source.executionSurface || ""))
    ? String(source.executionSurface)
    : "";
  const safe = {
    executionSurface,
    connectionId: String(source.connectionId || source.id || "").trim().slice(0, 240),
    model: String(source.model || "").trim().slice(0, 240),
    reasoningEffort: String(source.reasoningEffort || "").trim().slice(0, 40),
    speedMode: String(source.speedMode || "default").trim().slice(0, 40),
    agentEngine: String(source.agentEngine || "").trim().slice(0, 80),
    agentConnectionId: String(source.agentConnectionId || "").trim().slice(0, 240),
    agentModel: String(source.agentModel || "").trim().slice(0, 240),
    agentReasoningEffort: String(source.agentReasoningEffort || "").trim().slice(0, 40),
    agentSpeedMode: String(source.agentSpeedMode || "default").trim().slice(0, 40),
  };
  return Object.fromEntries(Object.entries(safe).filter(([, item]) => item !== ""));
};

const normalizedInteractionStartedAt = (request = {}, fallback = "") => {
  const parsed = Date.parse(String(request.interactionStartedAt || ""));
  const now = Date.now();
  // A UI click can precede durable task creation, but it cannot be in the
  // future or arbitrarily old. Bound external input without losing normal
  // connection/preflight time across a desktop restart.
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= now + 5_000 && parsed >= now - 24 * 60 * 60_000) {
    return new Date(parsed).toISOString();
  }
  return String(fallback || "");
};

const publicRequest = (channel, request = {}) => {
  const providerPromptReferenceTokens = Array.isArray(request.providerPromptReferenceTokens)
    ? [...new Set(request.providerPromptReferenceTokens.map(String).filter(Boolean))].slice(0, 300)
    : [];
  const multiframeTransitions = channel === "video" && request.generationMode === "smart_multiframe"
    ? publicMultiframeTransitions(request)
    : [];
  return ({
  channel,
  // The UI starts its user-visible timer before the durable server task is
  // created. Preserve that click timestamp across restart and recovery.
  interactionStartedAt: normalizedInteractionStartedAt(request),
  prompt: String(request.displayPrompt || (channel === "text" ? request.prompt : sanitizeMediaProviderPrompt(request.prompt, { referenceTokens: providerPromptReferenceTokens })) || ""),
  executionPrompt: channel === "text" ? String(request.prompt || "") : sanitizeMediaProviderPrompt(request.prompt, { referenceTokens: providerPromptReferenceTokens }),
  providerPromptReferenceTokens,
  capabilityProfileSignature: String(request.capabilityProfileSignature || request.settings?.capabilityProfileSignature || "").slice(0, 2000),
  aspectRatio: String(request.aspectRatio || ""),
  quality: String(request.quality || ""),
  imageCount: Math.max(1, Math.min(4, Number(request.imageCount) || 1)),
  spec: String(request.spec || ""),
  generationMode: String(request.generationMode || ""),
  duration: Number(request.duration) || 0,
  multiframeDuration: multiframeTransitions.length
    ? smartMultiframeDurationTotal(multiframeTransitions, { frameCount: multiframeTransitions.length + 1 })
    : 0,
  multiframeTransitions,
  resolution: String(request.resolution || ""),
  generateAudio: request.generateAudio !== false,
  videoCount: [1, 2, 3, 4].includes(Number(request.videoCount)) ? Number(request.videoCount) : 1,
  batchIndex: Math.max(1, Math.min(4, Number(request.batchIndex) || 1)),
  referenceOrder: Array.isArray(request.referenceOrder)
    ? [...new Set(request.referenceOrder.map(String).filter(Boolean))].slice(0, 100)
    : [],
  // Keep prompt occurrence order separately from the visible reference tray.
  // Duplicates are meaningful here (the same @ reference may occur several
  // times) and must not be used to reorder the tray.
  promptReferenceSequence: Array.isArray(request.promptReferenceSequence)
    ? request.promptReferenceSequence.map(String).filter(Boolean).slice(0, 300)
    : [],
  referenceMedia: (Array.isArray(request.referenceMedia) ? request.referenceMedia : []).map((item) => ({
    id: String(item.id || ""),
    relativePath: String(item.relativePath || ""),
    name: String(item.name || ""),
    mimeType: String(item.mimeType || ""),
    ...(Number(item.durationSeconds) > 0 ? { durationSeconds: Number(item.durationSeconds) } : Number(item.durationMs) > 0 ? { durationSeconds: Number(item.durationMs) / 1000 } : {}),
    referenceRole: ["target", "upstream", "document", "attachment"].includes(item.referenceRole) ? item.referenceRole : "",
  })),
  novelCover: normalizeNovelCoverAssetMetadata(request.novelCover),
  artifact: request.artifact ? {
    id: String(request.artifact.id || "").slice(0, 160),
    purpose: String(request.artifact.purpose || "").slice(0, 500),
    altText: String(request.artifact.altText || "").slice(0, 240),
    anchor: {
      type: String(request.artifact.anchor?.type || "").slice(0, 40),
      heading: String(request.artifact.anchor?.heading || "").slice(0, 240),
      paragraphIndex: Number.isInteger(request.artifact.anchor?.paragraphIndex) ? request.artifact.anchor.paragraphIndex : null,
      excerpt: String(request.artifact.anchor?.excerpt || "").slice(0, 240),
    },
  } : null,
  settings: scrubSecrets({
    provider: request.settings?.provider,
    adapter: request.settings?.adapter,
    protocol: request.settings?.protocol,
    model: request.settings?.model,
    connectionId: request.settings?.connectionId || request.settings?.id,
    name: request.settings?.name,
    remarkName: request.settings?.remarkName,
    dreaminaCliProfile: request.settings?.dreaminaCliProfile,
    dreaminaExpectedIdentity: request.settings?.dreaminaExpectedIdentity,
    timeoutMs: request.settings?.timeoutMs,
  }),
  generationProfile: publicGenerationProfile(request.generationProfile),
  });
};

const readJobUnlocked = async (jobId) => {
  const path = jobPath(jobId);
  await recoverAtomicWrite(path);
  return readJson(path);
};
const readJob = async (jobId) => withJobIoLock(jobId, () => readJobUnlocked(jobId));
const writeJobUnlocked = async (job) => {
  const safe = scrubSecrets(job);
  await atomicWrite(jobPath(job.id), JSON.stringify(safe));
  return safe;
};
const writeJob = async (job) => withJobIoLock(job.id, () => writeJobUnlocked(job));

const pruneExpiredGenerationJob = async (job, nowMs = Date.now()) => {
  if (!job?.id || !RETENTION_TERMINAL_STATUSES.has(job.status)) return false;
  const updatedAt = Date.parse(job.updatedAt || job.createdAt || "");
  if (!Number.isFinite(updatedAt) || nowMs - updatedAt <= JOB_RETENTION_MS) return false;
  return withJobIoLock(job.id, async () => {
    const current = await readJobUnlocked(job.id);
    const currentUpdatedAt = Date.parse(current?.updatedAt || current?.createdAt || "");
    if (!current || !RETENTION_TERMINAL_STATUSES.has(current.status)
      || !Number.isFinite(currentUpdatedAt) || nowMs - currentUpdatedAt <= JOB_RETENTION_MS) return false;
    await rm(jobPath(job.id), { force: true });
    await rm(join(jobsRoot(), "work", job.id), { recursive: true, force: true }).catch(() => {});
    return true;
  });
};

const enqueueJobUpdate = (jobId, operation) => {
  const previous = jobQueues.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const queued = next.finally(() => {
    if (jobQueues.get(jobId) === queued) jobQueues.delete(jobId);
  });
  jobQueues.set(jobId, queued);
  return queued;
};

const preserveStoppedMediaJobState = (current, patch = {}) => {
  const safePatch = scrubSecrets(patch);
  const stopped = current?.mode === "server"
    && ["image", "video", "audio"].includes(current?.channel)
    && Boolean(current.userStoppedAt || current.resultSuppressed || safePatch.userStoppedAt || safePatch.resultSuppressed);
  if (!stopped) return safePatch;
  return {
    ...safePatch,
    desiredAction: "cancel",
    userStoppedAt: current.userStoppedAt || new Date().toISOString(),
    resultSuppressed: true,
  };
};

const updateJob = (jobId, patch) => enqueueJobUpdate(jobId, () => withJobIoLock(jobId, async () => {
  const current = await readJobUnlocked(jobId);
  if (!current) throw new Error("生成任务不存在");
  const next = {
    ...current,
    ...preserveStoppedMediaJobState(current, patch),
    updatedAt: new Date().toISOString(),
  };
  return writeJobUnlocked(next);
}));

const transitionJob = (jobId, transition) => enqueueJobUpdate(jobId, () => withJobIoLock(jobId, async () => {
  const current = await readJobUnlocked(jobId);
  if (!current) throw new Error("生成任务不存在");
  const patch = await transition(current);
  if (!patch) return current;
  return writeJobUnlocked({
    ...current,
    ...preserveStoppedMediaJobState(current, patch),
    updatedAt: new Date().toISOString(),
  });
}));

const jobTransitionError = (message, code, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const assertSeedance25VideoRequest = (request = {}) => {
  const settings = request?.settings || {};
  const isSeedance25 = ["即梦", "dreamina"].includes(normalizedIdentity(settings.provider))
    && normalizedIdentity(settings.adapter) === "cli"
    && normalizedIdentity(settings.model) === "seedance2.5";
  if (!isSeedance25) return true;
  const duration = Number(request.duration || 4);
  const resolution = normalizedIdentity(request.resolution || "720p");
  const generationMode = normalizedIdentity(request.generationMode || "smart_params");
  const durationMinimum = generationMode === "long_video" ? LONG_VIDEO_MIN_DURATION_SECONDS : 4;
  const durationMaximum = generationMode === "long_video" ? LONG_VIDEO_MAX_DURATION_SECONDS : 30;
  if (!Number.isInteger(duration) || duration < durationMinimum || duration > durationMaximum) {
    throw jobTransitionError(`Seedance 2.5 ${generationMode === "long_video" ? "超长视频" : "视频"}时长必须是 ${durationMinimum}—${durationMaximum} 秒的整数`, "VIDEO_MODEL_OPTIONS_INVALID", 422);
  }
  if (!["480p", "720p"].includes(resolution)) {
    throw jobTransitionError("Seedance 2.5 仅支持 480p 或 720p 分辨率", "VIDEO_MODEL_OPTIONS_INVALID", 422);
  }
  if (!seedanceGenerationModeSupported(settings.model, generationMode)) {
    throw jobTransitionError("Seedance 2.5 当前仅支持智能多参、首尾帧、智能编辑或超长视频模式", "VIDEO_MODEL_OPTIONS_INVALID", 422);
  }
  const references = Array.isArray(request.referenceMedia) ? request.referenceMedia : [];
  const counts = references.reduce((result, item) => {
    const mimeType = normalizedIdentity(item?.mimeType);
    if (mimeType.startsWith("image/")) result.image += 1;
    else if (mimeType.startsWith("video/")) result.video += 1;
    else if (mimeType.startsWith("audio/")) result.audio += 1;
    else result.unsupported += 1;
    return result;
  }, { image: 0, video: 0, audio: 0, unsupported: 0 });
  if (counts.unsupported) {
    throw jobTransitionError("Seedance 2.5 参考中包含无法识别的媒体类型", "VIDEO_REFERENCE_LIMIT_INVALID", 422);
  }
  if (generationMode === "first_last_frame") {
    if (counts.image !== 2 || counts.video || counts.audio || references.length !== 2) {
      throw jobTransitionError("Seedance 2.5 首尾帧模式需要恰好 2 张图片，且不能包含视频或音频参考", "VIDEO_REFERENCE_LIMIT_INVALID", 422);
    }
  } else if (generationMode === "smart_edit") {
    const validation = smartEditReferenceValidation(references, { requireKnownVideoDuration: true });
    if (!validation.ok) {
      const durationError = ["video_duration_unknown", "video_too_long"].includes(validation.code);
      throw jobTransitionError(validation.message, durationError ? "VIDEO_REFERENCE_DURATION_INVALID" : "VIDEO_REFERENCE_LIMIT_INVALID", 422);
    }
  } else if (generationMode === "long_video" && references.length) {
    throw jobTransitionError("Seedance 2.5 超长视频当前为提示词直出模式，不能附带参考媒体", "VIDEO_REFERENCE_LIMIT_INVALID", 422);
  } else if (generationMode === "smart_params" && (counts.image > 30 || counts.video > 10 || counts.audio > 10 || references.length > 50)) {
    throw jobTransitionError(`Seedance 2.5 全能参考最多支持 30 张图片、10 个视频、10 个音频，总计不超过 50 项；当前为图片 ${counts.image}、视频 ${counts.video}、音频 ${counts.audio}，总计 ${references.length} 项`, "VIDEO_REFERENCE_LIMIT_INVALID", 422);
  }
  return true;
};

export const assertSeedanceVideoModeRequest = (request = {}) => {
  const settings = request?.settings || {};
  const provider = normalizedIdentity(settings.provider);
  const adapter = normalizedIdentity(settings.adapter);
  const family = seedanceModelFamily(settings.model);
  if (!family || !["即梦", "dreamina"].includes(provider) || !["cli", "api"].includes(adapter)) return true;
  const generationMode = normalizedIdentity(request.generationMode || "smart_params");
  if (!seedanceGenerationModeSupported(settings.model, generationMode)) {
    const labels = {
      smart_params: "智能多参",
      first_last_frame: "首尾帧",
      smart_multiframe: "智能多帧",
      smart_edit: "智能编辑",
      long_video: "超长视频",
    };
    throw jobTransitionError(
      `${settings.model || family} 不支持${labels[generationMode] || generationMode}；可用模式为 ${seedanceGenerationModesForModel(settings.model).map((mode) => labels[mode] || mode).join("、")}`,
      "VIDEO_MODEL_OPTIONS_INVALID",
      422,
    );
  }
  if (generationMode === "first_last_frame") {
    const references = Array.isArray(request.referenceMedia) ? request.referenceMedia : [];
    const images = references.filter((item) => String(item?.mimeType || "").startsWith("image/"));
    if (images.length !== 2 || references.length !== 2) {
      throw jobTransitionError("首尾帧模式需要恰好 2 张图片，且不能包含视频或音频参考", "VIDEO_REFERENCE_LIMIT_INVALID", 422);
    }
  }
  return true;
};

export const assertSmartMultiframeVideoRequest = (request = {}) => {
  if (normalizedIdentity(request.generationMode) !== "smart_multiframe") return true;
  const references = Array.isArray(request.referenceMedia) ? request.referenceMedia : [];
  const images = references.filter((item) => String(item?.mimeType || "").startsWith("image/"));
  if (references.length !== images.length || images.length < 2 || images.length > 20) {
    throw jobTransitionError("智能多帧需要 2—20 张图片，且不能包含视频或音频参考", "VIDEO_REFERENCE_LIMIT_INVALID", 422);
  }
  const suppliedTransitions = Array.isArray(request.multiframeTransitions) ? request.multiframeTransitions : [];
  if (suppliedTransitions.length && suppliedTransitions.length !== images.length - 1) {
    throw jobTransitionError("智能多帧的内容描述槽数量必须与相邻帧间隔一一对应", "VIDEO_TRANSITION_SEQUENCE_INVALID", 422);
  }
  if (suppliedTransitions.length) {
    const durations = suppliedTransitions.map((item) => Number(item?.duration));
    if (durations.some((duration) => !Number.isFinite(duration) || duration < 1 || duration > 8)) {
      throw jobTransitionError("智能多帧的每段内容时长必须在 1—8 秒之间", "VIDEO_TRANSITION_DURATION_INVALID", 422);
    }
    if (durations.reduce((total, duration) => total + duration, 0) < 2) {
      throw jobTransitionError("智能多帧的内容总时长不能少于 2 秒", "VIDEO_TRANSITION_DURATION_INVALID", 422);
    }
  }
  return true;
};

export const assertImageReferenceRequest = (request = {}) => {
  const prompt = String(request.prompt || "");
  const imageReferences = (Array.isArray(request.referenceMedia) ? request.referenceMedia : [])
    .filter((item) => String(item?.mimeType || "").toLowerCase().startsWith("image/"));
  const unresolvedReferencePlaceholder = /\[(?:reference[ _-]*)?image(?:[ _-]*url)?\]|<reference_images>|referenced_image_paths/iu.test(prompt);
  if (unresolvedReferencePlaceholder && !imageReferences.length) {
    throw jobTransitionError(
      "提示词要求使用参考图，但本次任务没有收到图片参考；请把图片连接到生成卡片或在生成栏添加参考后重试，当前未提交计费任务",
      "IMAGE_REFERENCE_REQUIRED",
      422,
    );
  }
  return true;
};

export const assertDreaminaImageModelRequest = (request = {}) => {
  const settings = request.settings || {};
  if (normalizedIdentity(settings.provider) !== normalizedIdentity("即梦") || normalizedIdentity(settings.adapter) !== "cli") return true;
  const model = String(settings.model || "").trim();
  if (!["5.0Pro", "jimeng-image-5.0-pro"].includes(model)) return true;
  const resolution = normalizedIdentity(request.quality || request.resolution);
  if (resolution && !["1.5k", "2k", "4k"].includes(resolution)) {
    throw jobTransitionError(
      "即梦图片 5.0 Pro 仅支持 1.5k、2k 或 4k；请重新选择分辨率，当前未提交计费任务",
      "IMAGE_MODEL_OPTIONS_INVALID",
      422,
    );
  }
  return true;
};

const persistedMediaProfileSignature = (job) => String(job?.profileSignature || "");
const isCanonicalProfileSignature = (value) => new RegExp(`^${CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX}[a-f0-9]{64}$`).test(String(value || ""));

const sameCapabilitySmokePublicIdentity = (job, channel, request = {}) => {
  if (job?.channel !== channel || job?.target?.targetType !== "capability-smoke") return false;
  const expected = job.request?.settings || {};
  const supplied = request?.settings || {};
  return ["connectionId", "provider", "adapter", "protocol", "model"].every((field) => {
    const left = normalizedIdentity(expected[field]);
    const right = normalizedIdentity(supplied[field === "connectionId" ? "connectionId" : field]
      || (field === "connectionId" ? supplied.id : ""));
    return !left || !right || left === right;
  });
};

const normalizedMediaSubmissionId = (value) => {
  const submissionId = String(value || "").trim();
  if (!submissionId) return "";
  if (!MEDIA_SUBMISSION_ID.test(submissionId)) {
    throw jobTransitionError("媒体提交编号格式无效", "MEDIA_SUBMISSION_ID_INVALID", 400);
  }
  return submissionId;
};

const mediaSubmissionFingerprint = ({ channel, target, request, profileSignature }) => createHash("sha256")
  .update(JSON.stringify({ channel, target, request: publicRequest(channel, request), profileSignature }), "utf8")
  .digest("hex");

const isGenerationJobEntry = (entry) => entry?.isFile?.() === true
  && /^generation-[a-z0-9-]{20,}\.json$/i.test(entry.name);

// Job lookups happen on every deliberate media submission. Reading the files
// one by one made the wait grow linearly with the retained task history. Keep
// the same durable JSON source of truth, but read independent job files with a
// small bounded worker pool so a large history does not delay a new request.
const readGenerationJobs = async (entries) => {
  const candidates = (Array.isArray(entries) ? entries : []).filter(isGenerationJobEntry);
  if (!candidates.length) return [];
  const jobs = new Array(candidates.length);
  let cursor = 0;
  const concurrency = Math.min(16, candidates.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= candidates.length) return;
      jobs[index] = await readJob(candidates[index].name.slice(0, -5));
    }
  }));
  return jobs.filter(Boolean);
};

const findMediaJobBySubmissionId = async (submissionId) => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  for (const job of await readGenerationJobs(entries)) {
    if (job?.submissionId === submissionId) return job;
  }
  return null;
};

const findReusableMediaJobByRequestFingerprint = async (requestFingerprint) => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const job of await readGenerationJobs(entries)) {
    if (job?.requestFingerprint !== requestFingerprint) continue;
    if (CAPABILITY_SMOKE_REUSABLE_STATUSES.has(job.status) || (job.status === "complete" && !job.appliedAt)) jobs.push(job);
  }
  return jobs.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))[0] || null;
};

const mediaTargetKey = (channel, target) => JSON.stringify({
  channel: String(channel || ""),
  workspaceKind: String(target?.workspaceKind || "project"),
  workspacePath: String(target?.workspacePath || "").replace(/\\/g, "/").toLocaleLowerCase(),
  documentId: String(target?.documentId || ""),
  nodeId: String(target?.nodeId || ""),
  targetType: String(target?.targetType || "whiteboard-node"),
});

export const mediaGenerationJobCanBeDismissed = (job = {}) => {
  const status = String(job?.status || "");
  const providerErrorCode = String(job?.providerErrorCode || "").toUpperCase();
  const unresolvedStatus = MEDIA_RESUMABLE_STATUSES.has(status)
    || ["cancel_requested", "reconciliation_required"].includes(status);
  return job?.mode === "server"
    && ["image", "video", "audio"].includes(String(job?.channel || ""))
    && unresolvedStatus
    && !job?.providerTaskId
    && !["complete", "cancelled", "superseded"].includes(status)
    && String(job?.billingRisk || "") === "submission_outcome_unknown"
    && (
      providerErrorCode === "DREAMINA_SUBMISSION_RECONCILIATION_LEASE_EXPIRED"
      || Boolean(job?.automaticRecoveryStoppedAt)
      || Boolean(job?.userStoppedAt)
      || Boolean(job?.resultSuppressed)
    );
};

// A provider-complete result can remain unapplied when its original workspace
// or card was removed. Keep it auditable, but let an explicit user decision
// release the stale card lock without deleting the result or task record.
export const mediaGenerationJobCanBeAbandoned = (job = {}) => (
  job?.mode === "server"
  && ["image", "video", "audio"].includes(String(job?.channel || ""))
  && String(job?.status || "") === "complete"
  && !job?.appliedAt
  && !job?.resultSuppressed
  && !job?.userStoppedAt
  && !job?.supersededBy
  && !job?.replacementReservationId
);

const findPendingMediaJobsByTarget = async ({ channel, target } = {}) => {
  const expected = mediaTargetKey(channel, target);
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const job of await readGenerationJobs(entries)) {
    if (!job || mediaTargetKey(job.channel, job.target) !== expected) continue;
    if (["cancelled", "superseded"].includes(String(job.status || "")) || job.supersededBy) continue;
    // A stopped, unidentified submission whose reconciliation lease has ended
    // must not remain an invisible card lock forever. Provider-task-backed
    // cancellation still follows the normal single-flight protection below.
    const dismissedUnidentifiedSubmission = mediaGenerationJobCanBeDismissed(job)
      && Boolean(job.userStoppedAt || job.resultSuppressed || job.desiredAction === "cancel");
    if (dismissedUnidentifiedSubmission) continue;
    const stopped = Boolean(job.userStoppedAt || job.resultSuppressed);
    const cardApplyPending = job.status === "complete" && !job.appliedAt && !stopped;
    if (MEDIA_ACTIVE_STATUSES.has(job.status) || cardApplyPending || (job.billingRisk && !job.appliedAt)) jobs.push(job);
  }
  return jobs.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
};

const findPendingMediaJobByTarget = async (options = {}) => (
  (await findPendingMediaJobsByTarget(options))[0] || null
);

const replacementAbandonmentPatch = (job) => {
  const now = new Date().toISOString();
  if (mediaGenerationJobCanBeAbandoned(job)) {
    return {
      // Preserve the completed artifact for audit while releasing its card
      // apply lease. A later task owns the card and this result cannot return.
      status: "complete",
      providerStatus: job.providerStatus || "completed",
      desiredAction: "cancel",
      userStoppedAt: job.userStoppedAt || now,
      resultSuppressed: true,
      abandonedAt: now,
      abandonmentReason: "user_submitted_replacement",
      retryAllowed: false,
      nextPollAt: "",
      error: "用户已提交新的生成请求；旧结果保留在任务记录中，不会回填当前卡片。",
      heartbeatAt: now,
    };
  }
  const providerMayStillRun = Boolean(job.providerTaskId || job.submissionState !== "not_submitted");
  return {
    status: "cancelled",
    providerStatus: providerMayStillRun ? "cancel_unconfirmed" : "cancelled",
    desiredAction: "cancel",
    progressPercent: 100,
    userStoppedAt: job.userStoppedAt || now,
    resultSuppressed: true,
    cancelRequestedAt: job.cancelRequestedAt || now,
    cancelledAt: now,
    cancellationFinalizedAt: now,
    cancellationFinalizationReason: "user_submitted_replacement",
    cancelOutcome: providerMayStillRun ? "replacement_local_abandonment" : "not_submitted",
    abandonedAt: now,
    abandonmentReason: "user_submitted_replacement",
    retryAllowed: false,
    nextPollAt: "",
    error: providerMayStillRun
      ? "用户已提交新的生成请求；旧任务已放弃本地跟踪，厂商远端状态和费用仍需按原任务记录核对。"
      : "用户已提交新的生成请求；旧任务尚未提交厂商，已放弃并释放当前卡片。",
    heartbeatAt: now,
  };
};

export const abandonMediaGenerationJobForReplacement = ({ jobId } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于可替代的后台媒体队列", "MEDIA_JOB_REPLACEMENT_NOT_ALLOWED");
  }
  if (["cancelled", "superseded"].includes(job.status) || job.supersededBy) return null;
  return replacementAbandonmentPatch(job);
});

export const listDreaminaProfileBlockingJobs = async () => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (let job of await readGenerationJobs(entries)) {
    job = await recoverLegacyDreaminaGenerationAuthFailure(job);
    const forceReleasePending = Boolean(job?.forceReleasePendingAt && !job?.forceReleaseCompletedAt);
    if (job && (dreaminaJobRequiresCredentialProfile(job) || forceReleasePending)) jobs.push(publicGenerationJob(job));
  }
  return jobs.sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
};

export const forceReleaseDreaminaJob = ({ jobId = "" } = {}) => transitionJob(safeJobId(jobId), (job) => {
  const forceReleasePending = Boolean(job?.forceReleasePendingAt && !job?.forceReleaseCompletedAt);
  if (!dreaminaJobRequiresCredentialProfile(job) && !forceReleasePending) {
    throw jobTransitionError("当前任务已经不占用即梦凭证锁", "DREAMINA_PROFILE_NOT_HELD");
  }
  const now = new Date().toISOString();
  return {
    status: "cancelled",
    desiredAction: "cancel",
    providerStatus: job.providerTaskId ? "cancel_unconfirmed" : "not_submitted",
    userStoppedAt: job.userStoppedAt || now,
    resultSuppressed: true,
    cancelRequestedAt: job.cancelRequestedAt || now,
    cancelledAt: now,
    cancellationFinalizedAt: now,
    cancellationFinalizationReason: "user_force_release_dreamina_lock",
    cancelOutcome: "local_terminalized_unconfirmed",
    profileSwitchReleasedAt: now,
    forceReleaseCompletedAt: now,
    retryAllowed: false,
    nextPollAt: "",
    error: job.providerTaskId
      ? "用户已强制释放本机即梦凭证锁；远端任务状态未确认，任务记录与任务编号仍保留，不会自动重新提交。"
      : "用户已强制释放本机即梦凭证锁；任务尚未提交给厂商，任务记录仍保留。",
    heartbeatAt: now,
  };
});

const dreaminaProfileIdentityKey = (settings = {}) => {
  const profileId = requireDreaminaCliProfileId(settings);
  const identity = dreaminaExpectedIdentitySync(profileId);
  return dreaminaCredentialIdentity({
    // Older persisted records can have expectedUserId without the newer
    // verifiedUserId mirror. Account identity is the stable key; auth.reg can
    // rotate after a normal CLI refresh and must not make an existing task look
    // as if it belongs to another account.
    credentialIdentityUserId: identity.verifiedUserId || identity.expectedUserId,
    credentialIdentityFingerprint: identity.credentialFingerprint,
  });
};

const freshCapabilitySmokeEvidence = (job, nowMs = Date.now()) => {
  const evidence = job?.capabilityEvidence || {};
  const explicitExpiry = Date.parse(evidence.evidenceExpiresAt || job?.evidenceExpiresAt || "");
  if (Number.isFinite(explicitExpiry)) return explicitExpiry > nowMs;
  const checkedAt = Date.parse(evidence.checkedAt || evidence.verifiedAt || job?.evidenceCheckedAt || job?.updatedAt || "");
  return Number.isFinite(checkedAt) && Math.max(0, nowMs - checkedAt) <= MEDIA_CAPABILITY_EVIDENCE_MAX_AGE_MS;
};

const findReusableCapabilitySmokeJobs = async (profileSignature) => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const job of await readGenerationJobs(entries)) {
    if (job?.target?.targetType !== "capability-smoke") continue;
    if (persistedMediaProfileSignature(job) !== profileSignature) continue;
    if (CAPABILITY_SMOKE_REUSABLE_STATUSES.has(job.status) || (job.status === "complete" && freshCapabilitySmokeEvidence(job))) jobs.push(job);
  }
  return jobs.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
};

const findUnverifiedActiveCapabilitySmokeJobs = async ({ channel, request } = {}) => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const job of await readGenerationJobs(entries)) {
    if (!job || isCanonicalProfileSignature(job.profileSignature) || !CAPABILITY_SMOKE_REUSABLE_STATUSES.has(job.status)) continue;
    if (sameCapabilitySmokePublicIdentity(job, channel, request)) jobs.push(job);
  }
  return jobs.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
};

export const createMediaGenerationJob = async ({ channel, target, request, replacement = null, forceNewGeneration = false, regenerationOfJobId = "", allowDuplicateCapabilitySmoke = false, canonicalProfileSignature = "", submissionId = "" } = {}) => {
  if (!['image', 'video', 'audio'].includes(channel)) throw new Error("仅支持图片、视频或音频后台任务");
  if (channel === "image") {
    assertImageReferenceRequest(request);
    assertDreaminaImageModelRequest(request);
  }
  if (channel === "video") {
    assertSeedanceVideoModeRequest(request);
    assertSeedance25VideoRequest(request);
    assertSmartMultiframeVideoRequest(request);
  }
  const normalized = normalizedTarget(target);
  assertGenerationTarget(normalized);
  const providerPromptReferenceTokens = Array.isArray(request?.providerPromptReferenceTokens)
    ? [...new Set(request.providerPromptReferenceTokens.map(String).filter(Boolean))].slice(0, 300)
    : [];
  const prompt = sanitizeMediaProviderPrompt(request?.prompt, { referenceTokens: providerPromptReferenceTokens });
  if (!prompt) throw new Error(channel === "video" ? "视频提示词不能为空" : channel === "audio" ? "音频提示词不能为空" : "生图提示词不能为空");
  const normalizedRequest = { ...request, prompt, providerPromptReferenceTokens };
  if (isDreaminaCliSettings(normalizedRequest.settings || {})) {
    requireDreaminaCliProfileId(normalizedRequest.settings || {});
  }
  const suppliedProfileSignature = String(canonicalProfileSignature || "");
  const profileIdentityVerified = isCanonicalProfileSignature(suppliedProfileSignature);
  const profileSignature = profileIdentityVerified
    ? suppliedProfileSignature
    : canonicalMediaProfileSignature(channel, normalizedRequest.settings || {});
  const normalizedSubmission = normalizedMediaSubmissionId(submissionId || normalizedRequest.submissionId);
  const submissionFingerprint = normalizedSubmission
    ? mediaSubmissionFingerprint({ channel, target: normalized, request: normalizedRequest, profileSignature })
    : "";
  const requestFingerprint = mediaSubmissionFingerprint({ channel, target: normalized, request: normalizedRequest, profileSignature });
  const createJob = async ({ duplicate = false } = {}) => {
    const now = new Date().toISOString();
    const operationId = normalizedSubmission || `media-${randomUUID()}`;
    const profileId = String(normalizedRequest.settings?.connectionId || normalizedRequest.settings?.id || "");
    const profileIdentityKey = isDreaminaCliSettings(normalizedRequest.settings || {})
      ? dreaminaProfileIdentityKey(normalizedRequest.settings || {})
      : "";
    const cardId = String(normalized.nodeId || normalized.messageId || normalized.artifactId || "");
    const job = {
      schemaVersion: JOB_SCHEMA_VERSION,
      id: `generation-${randomUUID()}`,
      channel,
      mode: "server",
      status: "queued",
      progressPercent: 5,
      target: normalized,
      request: publicRequest(channel, normalizedRequest),
      profileSignature,
      profileIdentityVerified,
      operationId,
      profileId,
      ...(profileIdentityKey ? { profileIdentityKey } : {}),
      cardId,
      providerTaskId: null,
      providerStatus: "queued",
      providerErrorCode: "",
      providerResultUrl: "",
      lastPolledAt: "",
      attempt: 0,
      pollCount: 0,
      transientFailures: 0,
      idempotencyKey: operationId,
      ...(normalizedSubmission ? { submissionId: normalizedSubmission, submissionFingerprint } : {}),
      requestFingerprint,
      submissionState: "not_submitted",
      desiredAction: "run",
      billingRisk: "",
      resubmitConfirmationRequired: false,
      resultUrlExpiresAt: "",
      ...(replacement?.sourceJobId && replacement?.reservationId ? {
        replacementSourceJobId: safeJobId(replacement.sourceJobId),
        replacementSourceReservationId: String(replacement.reservationId),
      } : {}),
      ...(forceNewGeneration === true ? {
        explicitRegeneration: true,
        regenerationOfJobId: regenerationOfJobId ? safeJobId(regenerationOfJobId) : "",
      } : {}),
      createdAt: now,
      startedAt: normalizedInteractionStartedAt(normalizedRequest, now),
      updatedAt: now,
      appliedAt: "",
      resultAssetId: "",
    };
    if (isDreaminaCliSettings(normalizedRequest.settings || {})) {
      const releaseProfileGate = await acquireCapabilitySmokeLock("dreamina-cli-manual-profile-gate");
      try {
        const decision = dreaminaProfileSwitchDecision({
          jobs: await listDreaminaProfileBlockingJobs(),
          requestedProfileId: requireDreaminaCliProfileId(normalizedRequest.settings || {}),
          requestedCredentialIdentity: profileIdentityKey,
        });
        if (!decision.allowed) {
          const error = jobTransitionError(
            dreaminaProfileSwitchMessage(decision),
            "DREAMINA_PROFILE_SWITCH_BLOCKED",
            409,
          );
          error.details = decision;
          throw error;
        }
        await writeJob(job);
      } finally {
        await releaseProfileGate();
      }
    } else {
      await writeJob(job);
    }
    return { ...job, duplicate, reused: false };
  };

  if (normalized.targetType !== "capability-smoke") {
    const targetKey = mediaTargetKey(channel, normalized);
    return enqueueMediaCreation(`target:${targetKey}`, async () => {
      const release = await acquireCapabilitySmokeLock(`media-target:${targetKey}`);
      try {
        const existing = normalizedSubmission ? await findMediaJobBySubmissionId(normalizedSubmission) : null;
        if (existing) {
          if (existing.submissionFingerprint !== submissionFingerprint) {
            throw jobTransitionError(
              "同一媒体提交编号已绑定到不同的生成请求，已阻止歧义提交",
              "MEDIA_SUBMISSION_ID_CONFLICT",
            );
          }
          return { ...existing, duplicate: true, reused: true };
        }
        const replacedJobs = [];
        if (forceNewGeneration === true) {
          // A deliberate new click may contain a different prompt, references,
          // model, or parameters. It abandons old card leases instead of
          // treating the current request as a retry of their payload.
          const pendingJobs = await findPendingMediaJobsByTarget({ channel, target: normalized });
          for (const pendingJob of pendingJobs) {
            const abandoned = await abandonMediaGenerationJobForReplacement({ jobId: pendingJob.id });
            if (abandoned) replacedJobs.push(abandoned);
          }
        } else {
          // Network retries and accidental duplicate submissions remain
          // single-flight and reuse the existing task.
          const pendingTarget = await findPendingMediaJobByTarget({ channel, target: normalized });
          if (pendingTarget) {
            return {
              ...pendingTarget,
              duplicate: true,
              reused: true,
              duplicateReason: pendingTarget.status === "complete" && !pendingTarget.appliedAt
                ? "card_apply_pending"
                : "target_active",
            };
          }
        }
        // A new UI submission is not a transport retry. Keep submissionId
        // idempotency above, but do not reuse an older failed/running job merely
        // because the user intentionally submitted identical inputs again.
        if (!replacement?.sourceJobId && forceNewGeneration !== true) {
          const reusable = await findReusableMediaJobByRequestFingerprint(requestFingerprint);
          if (reusable) return { ...reusable, duplicate: true, reused: true, duplicateReason: "same_active_request" };
        }
        const created = await createJob();
        return replacedJobs.length
          ? { ...created, abandonedJobIds: replacedJobs.map((job) => job.id) }
          : created;
      } finally {
        await release();
      }
    });
  }
  return enqueueMediaCreation(`capability:${profileSignature}`, async () => {
    const release = await acquireCapabilitySmokeLock(profileSignature);
    try {
      const existing = await findReusableCapabilitySmokeJobs(profileSignature);
      const active = existing.find((job) => CAPABILITY_SMOKE_REUSABLE_STATUSES.has(job.status));
      if (active) return { ...active, duplicate: true, reused: true };
      const completed = existing.find((job) => job.status === "complete");
      if (completed && allowDuplicateCapabilitySmoke !== true) return { ...completed, duplicate: true, reused: true };
      const unresolved = await findUnverifiedActiveCapabilitySmokeJobs({ channel, request: normalizedRequest });
      if (unresolved.length) {
        throw jobTransitionError(
          "发现同一连接、厂商和模型下身份未完成迁移的收费测试任务；必须先核对原任务，不能创建第二个可能重复计费的任务",
          "MEDIA_CAPABILITY_SMOKE_LEGACY_RECONCILIATION_REQUIRED",
        );
      }
      return createJob({ duplicate: Boolean(completed) });
    } finally {
      await release();
    }
  });
};

export const createClientGenerationJob = async ({ channel = "text", target, request = {} } = {}) => {
  const normalized = normalizedTarget(target);
  assertGenerationTarget(normalized);
  const now = new Date().toISOString();
  const job = {
    schemaVersion: JOB_SCHEMA_VERSION,
    id: `generation-${randomUUID()}`,
    channel: String(channel || "text"),
    mode: "client",
    status: "running",
    progressPercent: 8,
    target: normalized,
    request: publicRequest(channel, request),
    createdAt: now,
    startedAt: normalizedInteractionStartedAt(request, now),
    heartbeatAt: now,
    updatedAt: now,
    appliedAt: "",
  };
  await writeJob(job);
  return job;
};

const staleInterruptedJob = (job) => job?.mode === "client"
  && ["queued", "running"].includes(job?.status)
  && Date.now() - Date.parse(job.heartbeatAt || job.updatedAt || job.startedAt || job.createdAt || 0) > RUNNING_STALE_MS;

const recoverStaleJob = async (job) => {
  if (!staleInterruptedJob(job)) return job;
  return updateJob(job.id, {
    status: "retry_required",
    progressPercent: 100,
    interruptedAt: new Date().toISOString(),
    error: "生成连接已中断，提示词、上游范围和模型信息均已保留，请重新生成。",
    retryAllowed: true,
  });
};

export const getGenerationJob = async ({ jobId } = {}) => {
  const job = await readJob(safeJobId(jobId));
  if (!job) throw new Error("生成任务不存在");
  return publicGenerationJob(await recoverStaleJob(job));
};

export const listGenerationJobs = async ({ workspacePath = "", includeApplied = false, targetType = "", profileSignature = "" } = {}) => {
  const requestedPath = String(workspacePath || "").trim();
  const targetPath = requestedPath ? resolve(requestedPath).toLowerCase() : "";
  const requestedTargetType = String(targetType || "").trim();
  const requestedProfileSignature = String(profileSignature || "");
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const job of await readGenerationJobs(entries)) {
    if (!job) continue;
    const age = Date.now() - Date.parse(job.updatedAt || job.createdAt || 0);
    if (age > JOB_RETENTION_MS && await pruneExpiredGenerationJob(job)) continue;
    if (requestedProfileSignature && persistedMediaProfileSignature(job) !== requestedProfileSignature) continue;
    if (!requestedProfileSignature && targetPath && resolve(String(job.target?.workspacePath || "")).toLowerCase() !== targetPath) continue;
    if (requestedTargetType && job.target?.targetType !== requestedTargetType) continue;
    const recovered = await recoverStaleJob(job);
    if (!includeApplied && recovered.appliedAt) continue;
    jobs.push(publicGenerationJob(recovered));
  }
  // Workspace card reconciliation must be able to inspect older applied jobs:
  // their media can still exist in the asset ledger while a legacy card lost
  // its display binding. Keep global polling bounded, but widen the explicitly
  // scoped applied audit so startup can repair those cards without resubmitting.
  const resultLimit = includeApplied && targetPath ? 500 : 100;
  return jobs.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, resultLimit);
};

export const heartbeatGenerationJob = ({ jobId, progressPercent } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "client" || !["queued", "running"].includes(job.status)) {
    throw jobTransitionError("只有正在运行的客户端任务可以写入心跳", "CLIENT_JOB_HEARTBEAT_NOT_ALLOWED");
  }
  return {
    heartbeatAt: new Date().toISOString(),
    ...(Number.isFinite(Number(progressPercent)) ? { progressPercent: Math.min(96, Math.max(1, Number(progressPercent))) } : {}),
  };
});

export const completeClientGenerationJob = ({ jobId, result } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "client" || !["queued", "running"].includes(job.status)) {
    throw jobTransitionError("只有正在运行的客户端任务可以由客户端完成", "CLIENT_JOB_COMPLETE_NOT_ALLOWED");
  }
  return {
    status: "complete",
    progressPercent: 100,
    completedAt: new Date().toISOString(),
    result: scrubSecrets(result ?? {}),
  };
});

export const failClientGenerationJob = ({ jobId, message = "", retryRequired = true } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "client" || !["queued", "running"].includes(job.status)) {
    throw jobTransitionError("只有正在运行的客户端任务可以由客户端标记失败", "CLIENT_JOB_FAIL_NOT_ALLOWED");
  }
  return {
    status: retryRequired ? "retry_required" : "failed",
    progressPercent: 100,
    failedAt: new Date().toISOString(),
    error: String(message || "生成任务失败").slice(0, 2000),
    retryAllowed: true,
  };
});

export const markGenerationJobApplied = ({ jobId, resultAssetId = "", cardReadback = null } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.status !== "complete") throw jobTransitionError("只有已完成且已落盘的任务可以标记为已应用", "GENERATION_JOB_NOT_COMPLETE");
  if (["image", "video", "audio"].includes(job.channel) && (!job.result?.attachment?.relativePath || !job.result?.attachment?.sha256)) {
    throw jobTransitionError("媒体任务缺少已落盘附件校验信息，不能标记为已应用", "MEDIA_ATTACHMENT_RECEIPT_REQUIRED");
  }
  const stopped = Boolean(job.userStoppedAt || job.resultSuppressed || job.userStopped);
  const requiresCardReadback = job.target?.targetType === "whiteboard-node" && !stopped;
  const readback = cardReadback && typeof cardReadback === "object" ? scrubSecrets(cardReadback) : null;
  const normalizedAssetId = String(resultAssetId || job.resultAssetId || "").trim();
  const validCardReadback = readback?.verified === true
    && String(readback.generationJobId || "") === job.id
    && String(readback.documentId || "") === String(job.target?.documentId || "")
    && (!normalizedAssetId || String(readback.resultAssetId || "") === normalizedAssetId);
  if (requiresCardReadback && !validCardReadback) {
    throw jobTransitionError("媒体结果尚未完成目标卡片回读校验，不能向用户报告生成完成", "MEDIA_CARD_READBACK_RECEIPT_REQUIRED");
  }
  return {
    appliedAt: job.appliedAt || new Date().toISOString(),
    resultAssetId: normalizedAssetId,
    ...(validCardReadback ? {
      cardReadbackVerified: true,
      cardReadbackAt: String(readback.verifiedAt || new Date().toISOString()),
      cardReadbackReceipt: readback,
    } : {}),
  };
});

export const requestMediaGenerationResume = ({ jobId, allowNewSubmission = false, requestId = "" } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于可续接的后台媒体队列", "MEDIA_JOB_RESUME_NOT_ALLOWED");
  }
  if (job.supersededBy || job.replacementReservationId || job.status === "superseded") {
    throw jobTransitionError("此旧任务已被替代或正在创建替代任务，不能再次提交", "MEDIA_JOB_SUPERSEDED");
  }
  if (job.status === "complete" || job.status === "cancelled") {
    throw jobTransitionError("已完成或已取消的任务不能重新续接", "MEDIA_JOB_TERMINAL");
  }
  if (MEDIA_ACTIVE_STATUSES.has(job.status) && job.status !== "cancel_requested") return null;
  if (!MEDIA_RESUMABLE_STATUSES.has(job.status) && job.status !== "cancel_requested") {
    throw jobTransitionError("当前任务状态不允许续接", "MEDIA_JOB_RESUME_NOT_ALLOWED");
  }
  if (job.desiredAction === "cancel" || job.status === "cancel_requested") {
    throw jobTransitionError("此任务已经受理取消，正在等待厂商确认，不能恢复生成", "MEDIA_JOB_CANCEL_PENDING");
  }
  if (job.providerTaskId) {
    return {
      status: job.providerStatus === "completed" || job.status === "waiting_storage" ? "downloading" : "polling",
      desiredAction: "run",
      resumeKind: "continue_original",
      resumeRequestId: String(requestId || ""),
      resumedAt: new Date().toISOString(),
      explicitRetryAt: "",
      error: "",
      retryAllowed: true,
    };
  }
  if (!job.idempotencyKey) {
    throw jobTransitionError("旧版任务没有厂商任务 ID 或原始幂等键，不能伪装成原任务续接；只能明确复制为全新任务", "LEGACY_MEDIA_JOB_NON_RESUMABLE");
  }
  const safeNoTaskResubmit = job.safeNoTaskRetry === true
    && job.submissionState === "not_submitted"
    && !job.billingRisk;
  if (safeNoTaskResubmit) {
    return {
      status: "queued",
      providerStatus: "queued",
      submissionState: "not_submitted",
      desiredAction: "run",
      resumeKind: "safe_no_task_retry",
      resumeRequestId: String(requestId || ""),
      explicitRetryAt: new Date().toISOString(),
      safeNoTaskRetry: false,
      resubmitConfirmationRequired: false,
      error: "",
      retryAllowed: true,
    };
  }
  if (!allowNewSubmission) {
    throw jobTransitionError("没有厂商任务 ID，无法证明原任务是否已提交；必须核对厂商任务列表后明确确认新提交", "NEW_SUBMISSION_CONFIRMATION_REQUIRED");
  }
  return {
    status: "queued",
    providerStatus: "queued",
    desiredAction: "run",
    resumeKind: "confirmed_new_submission",
    resumeRequestId: String(requestId || ""),
    explicitRetryAt: new Date().toISOString(),
    resubmitConfirmedAt: new Date().toISOString(),
    resubmitConfirmationRequired: false,
    error: "",
    retryAllowed: true,
  };
});

export const reconcileMediaGenerationProviderTask = ({ jobId, providerTaskId = "" } = {}) => transitionJob(safeJobId(jobId), (job) => {
  const taskId = String(providerTaskId || "").trim();
  if (job.mode !== "server" || !["image", "video"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于可找回的后台媒体队列", "MEDIA_JOB_RECONCILE_NOT_ALLOWED");
  }
  if (normalizedIdentity(job.request?.settings?.adapter) !== "cli"
    || !["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider))) {
    throw jobTransitionError("当前仅支持找回即梦 CLI 已有任务", "MEDIA_JOB_RECONCILE_PROVIDER_NOT_SUPPORTED");
  }
  if (job.supersededBy || job.replacementReservationId || ["complete", "cancelled", "superseded"].includes(job.status)) {
    throw jobTransitionError("已完成、已取消或已替代的任务不能重新绑定厂商任务", "MEDIA_JOB_TERMINAL");
  }
  if (job.providerTaskId && job.providerTaskId !== taskId) {
    throw jobTransitionError("任务已经绑定另一个厂商任务 ID，不能覆盖", "MEDIA_JOB_PROVIDER_TASK_ID_MISMATCH");
  }
  if (!MEDIA_RESUMABLE_STATUSES.has(job.status) && job.status !== "cancel_requested") {
    throw jobTransitionError("当前任务状态不允许找回厂商结果", "MEDIA_JOB_RECONCILE_NOT_ALLOWED");
  }
  if (job.desiredAction === "cancel" || job.status === "cancel_requested") {
    throw jobTransitionError("此任务已经受理取消，正在等待厂商确认，不能绑定为生成结果", "MEDIA_JOB_CANCEL_PENDING");
  }
  if (!taskId) {
    if (!job.idempotencyKey) {
      throw jobTransitionError("旧任务缺少自动找回所需的幂等键，只能由用户明确确认后重新生成", "MEDIA_JOB_AUTOMATIC_RECONCILE_UNAVAILABLE");
    }
    return {
      status: "retry_required",
      providerStatus: "reconciling",
      submissionState: "uncertain",
      desiredAction: "run",
      resumeKind: "automatic_submission_reconciliation",
      automaticRecoveryStartedAt: new Date().toISOString(),
      automaticRecoveryStoppedAt: "",
      billingRisk: "submission_outcome_unknown",
      resubmitConfirmationRequired: false,
      nextPollAt: new Date().toISOString(),
      error: "正在按原连接、幂等键、提示词、任务类型和创建时间自动查找即梦结果；无需填写任务 ID，也不会重新提交或重复扣费。",
      retryAllowed: true,
      heartbeatAt: new Date().toISOString(),
    };
  }
  if (!MEDIA_SUBMISSION_ID.test(taskId)) {
    throw jobTransitionError("即梦厂商任务 ID 格式无效", "MEDIA_JOB_PROVIDER_TASK_ID_INVALID");
  }
  return {
    status: "polling",
    providerStatus: "running",
    providerTaskId: taskId,
    submissionState: "submitted",
    desiredAction: "run",
    resumeKind: "reconcile_existing_provider_task",
    reconciledProviderTaskAt: new Date().toISOString(),
    billingRisk: "",
    resubmitConfirmationRequired: false,
    explicitRetryAt: "",
    error: "",
    retryAllowed: true,
    heartbeatAt: new Date().toISOString(),
  };
});

export const requestMediaGenerationCancel = ({ jobId } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于可取消的后台媒体队列", "MEDIA_JOB_CANCEL_NOT_ALLOWED");
  }
  if (job.supersededBy || job.replacementReservationId || job.status === "superseded") {
    throw jobTransitionError("此旧任务已被替代或正在创建替代任务，不能再次操作", "MEDIA_JOB_SUPERSEDED");
  }
  if (job.status === "complete") throw jobTransitionError("已经完成并落盘的任务不能再取消", "MEDIA_JOB_TERMINAL");
  if (job.status === "cancelled" && job.userStoppedAt) return null;
  if (job.desiredAction === "cancel" && job.userStoppedAt) return null;
  const now = new Date().toISOString();
  if (mediaGenerationJobCanBeDismissed(job)) {
    return {
      status: "cancelled",
      providerStatus: "cancel_unconfirmed",
      desiredAction: "cancel",
      progressPercent: 100,
      userStoppedAt: job.userStoppedAt || now,
      resultSuppressed: true,
      cancelRequestedAt: job.cancelRequestedAt || now,
      cancelledAt: now,
      cancellationFinalizedAt: now,
      cancellationFinalizationReason: "submission_reconciliation_dismissed",
      cancelOutcome: "local_terminalized_unconfirmed",
      retryAllowed: false,
      nextPollAt: "",
      error: "已忽略无法确认的旧提交并释放当前卡片。旧提示词、参考和任务记录仍保留；若厂商实际已受理，远端结果或费用仍需按厂商任务列表核对。",
      heartbeatAt: now,
    };
  }
  if (!job.providerTaskId && job.status === "queued" && job.submissionState === "not_submitted") {
    return {
      status: "cancelled",
      providerStatus: "cancelled",
      desiredAction: "cancel",
      progressPercent: 100,
      userStoppedAt: now,
      resultSuppressed: true,
      cancelRequestedAt: now,
      cancelledAt: now,
      providerResultUrl: "",
      resultUrlExpiresAt: "",
    };
  }
  return {
    status: "cancel_requested",
    desiredAction: "cancel",
    userStoppedAt: job.userStoppedAt || now,
    resultSuppressed: true,
    cancelRequestedAt: job.cancelRequestedAt || now,
    error: "",
  };
});

export const dismissMediaGenerationJob = ({ jobId } = {}) => transitionJob(safeJobId(jobId), (job) => {
  const abandonCompleted = mediaGenerationJobCanBeAbandoned(job);
  if (!mediaGenerationJobCanBeDismissed(job) && !abandonCompleted) {
    throw jobTransitionError("当前任务不属于可忽略的待核对提交", "MEDIA_JOB_DISMISS_NOT_ALLOWED");
  }
  const now = new Date().toISOString();
  if (abandonCompleted) {
    return {
      // Keep the provider-complete status for billing and asset auditing. The
      // suppression marker releases the stale card lock without deleting data.
      status: "complete",
      desiredAction: "cancel",
      userStoppedAt: now,
      resultSuppressed: true,
      abandonedAt: now,
      abandonmentReason: "user_abandoned_completed_backfill",
      retryAllowed: false,
      error: "已放弃回填并隐藏该任务。生成结果、任务记录和费用信息仍保留，不会重新生成或重复扣费。",
      heartbeatAt: now,
    };
  }
  return {
    status: "cancelled",
    providerStatus: "cancel_unconfirmed",
    desiredAction: "cancel",
    progressPercent: 100,
    userStoppedAt: job.userStoppedAt || now,
    resultSuppressed: true,
    cancelRequestedAt: job.cancelRequestedAt || now,
    cancelledAt: now,
    cancellationFinalizedAt: now,
    cancellationFinalizationReason: "submission_reconciliation_dismissed",
    cancelOutcome: "local_terminalized_unconfirmed",
    retryAllowed: false,
    nextPollAt: "",
    error: "已忽略无法确认的旧提交并释放当前卡片。旧提示词、参考和任务记录仍保留；若厂商实际已受理，远端结果或费用仍需按厂商任务列表核对。",
    heartbeatAt: now,
  };
});

const cancellationRequestedAtMs = (job = {}) => Date.parse(
  job.cancelRequestedAt || job.userStoppedAt || job.updatedAt || job.createdAt || "",
) || 0;

export const mediaGenerationCancellationFinalizationExpired = (job = {}, { nowMs = Date.now() } = {}) => {
  if (job?.mode !== "server" || !["image", "video", "audio"].includes(job?.channel)) return false;
  if (job?.desiredAction !== "cancel" || !job?.userStoppedAt) return false;
  const requestedAt = cancellationRequestedAtMs(job);
  return requestedAt > 0 && Number(nowMs) - requestedAt >= MEDIA_CANCELLATION_FINALIZATION_MS;
};

// A provider may accept a cancellation request but never expose a terminal
// state again. Keep the remote task auditable, but end the local state machine
// so it cannot retry forever or retain a scheduling resource.
export const finalizeMediaGenerationCancellation = ({ jobId, force = false, reason = "" } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于可终结的后台媒体队列", "MEDIA_JOB_CANCEL_NOT_ALLOWED");
  }
  if (["complete", "cancelled", "superseded"].includes(job.status) || job.supersededBy) return null;
  if (job.desiredAction !== "cancel" || !job.userStoppedAt) {
    throw jobTransitionError("只有用户已停止的媒体任务才能终结", "MEDIA_JOB_FINALIZE_CANCEL_NOT_ALLOWED");
  }
  if (!force && !mediaGenerationCancellationFinalizationExpired(job)) return null;
  const now = new Date().toISOString();
  return {
    status: "cancelled",
    providerStatus: "cancel_unconfirmed",
    desiredAction: "cancel",
    resultSuppressed: true,
    providerResultUrl: "",
    resultUrlExpiresAt: "",
    progressPercent: 100,
    retryAllowed: false,
    nextPollAt: "",
    cancelledAt: now,
    cancellationFinalizedAt: now,
    cancellationFinalizationReason: String(reason || (force ? "user_force_stop" : "provider_cancel_confirmation_timeout")),
    cancelOutcome: "local_terminalized_unconfirmed",
    error: "已停止本地任务并结束后台跟踪。厂商取消结果在限定时间内未能确认；神思不会重新提交或继续轮询，请按厂商任务列表或账单核对可能的远端费用。",
    heartbeatAt: now,
  };
});

export const reserveLegacyMediaGenerationReplacement = async ({ jobId, ownerToken = "" } = {}) => {
  const reservationId = `replacement-${randomUUID()}`;
  const normalizedOwnerToken = String(ownerToken || `process-${process.pid}`).slice(0, 200);
  const job = await transitionJob(safeJobId(jobId), (current) => {
    if (current.mode !== "server" || !["image", "video", "audio"].includes(current.channel)) {
      throw jobTransitionError("此任务不属于后台媒体队列", "MEDIA_JOB_REPLACE_NOT_ALLOWED");
    }
    if (current.supersededBy || current.replacementReservationId || current.status === "superseded") {
      throw jobTransitionError("此旧任务已被替代或正在创建替代任务", "MEDIA_JOB_SUPERSEDED");
    }
    if (!MEDIA_RESUMABLE_STATUSES.has(current.status) || current.providerTaskId || current.idempotencyKey) {
      throw jobTransitionError("只有缺少厂商任务 ID 和幂等键的旧版失败任务可以复制为新任务", "LEGACY_MEDIA_JOB_REPLACE_NOT_ALLOWED");
    }
    return {
      replacementReservationId: reservationId,
      replacementReservedAt: new Date().toISOString(),
      replacementReservationOwnerPid: process.pid,
      replacementReservationOwnerToken: normalizedOwnerToken,
      retryAllowed: false,
    };
  });
  return { job, reservationId };
};

export const finalizeLegacyMediaGenerationReplacement = ({ jobId, reservationId, replacementJobId } = {}) => transitionJob(safeJobId(jobId), (job) => {
  const normalizedReplacementJobId = safeJobId(replacementJobId);
  if (job.status === "superseded" && job.supersededBy === normalizedReplacementJobId) return null;
  if (!reservationId || job.replacementReservationId !== reservationId) {
    throw jobTransitionError("旧任务替代预约已失效", "MEDIA_JOB_REPLACEMENT_RESERVATION_MISMATCH");
  }
  return {
    status: "superseded",
    supersededBy: normalizedReplacementJobId,
    supersededAt: new Date().toISOString(),
    replacementReservationId: "",
    replacementReservedAt: "",
    replacementReservationOwnerPid: null,
    replacementReservationOwnerToken: "",
    retryAllowed: false,
    billingRisk: "legacy_task_replaced_after_confirmation",
  };
});

export const releaseLegacyMediaGenerationReplacement = ({ jobId, reservationId } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (!reservationId || job.replacementReservationId !== reservationId || job.supersededBy) return null;
  return {
    replacementReservationId: "",
    replacementReservedAt: "",
    replacementReservationOwnerPid: null,
    replacementReservationOwnerToken: "",
    retryAllowed: true,
  };
});

const findLegacyReplacementByReservation = async ({ sourceJobId, reservationId } = {}) => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^generation-[a-z0-9-]{20,}\.json$/i.test(entry.name)) continue;
    const candidateId = entry.name.slice(0, -5);
    if (candidateId === sourceJobId) continue;
    const candidate = await readJob(candidateId);
    if (candidate?.replacementSourceJobId === sourceJobId && candidate?.replacementSourceReservationId === reservationId) return candidate;
  }
  return null;
};

export const recoverLegacyMediaGenerationReplacement = async ({
  jobId,
  ownerToken = "",
  nowMs = Date.now(),
  staleMs = LEGACY_REPLACEMENT_RESERVATION_STALE_MS,
  hardStaleMs = LEGACY_REPLACEMENT_RESERVATION_HARD_STALE_MS,
} = {}) => {
  const sourceJobId = safeJobId(jobId);
  const current = await readJob(sourceJobId);
  if (!current) throw new Error("生成任务不存在");
  if (current.supersededBy) {
    return { action: "finalized", job: current, replacement: await readJob(current.supersededBy) };
  }
  const reservationId = String(current.replacementReservationId || "");
  if (!reservationId) return { action: "none", job: current, replacement: null };

  const normalizedOwnerToken = String(ownerToken || "");
  const reservedOwnerToken = String(current.replacementReservationOwnerToken || "");
  const reservedOwnerPid = Number(current.replacementReservationOwnerPid || 0);
  const reservedAtMs = Date.parse(current.replacementReservedAt || current.updatedAt || current.createdAt || 0);
  const reservationAge = Number.isFinite(reservedAtMs) ? Math.max(0, Number(nowMs) - reservedAtMs) : Number.POSITIVE_INFINITY;
  const sameLiveOwner = Boolean(normalizedOwnerToken && reservedOwnerToken === normalizedOwnerToken && processIsAlive(reservedOwnerPid));
  const pidReusedByCurrentProcess = reservedOwnerPid === process.pid && Boolean(normalizedOwnerToken) && reservedOwnerToken !== normalizedOwnerToken;
  const ownerAppearsAlive = processIsAlive(reservedOwnerPid) && !pidReusedByCurrentProcess;
  const hardExpired = reservationAge >= Math.max(Number(staleMs) || 0, Number(hardStaleMs) || 0);
  if (sameLiveOwner || (ownerAppearsAlive && !hardExpired)) {
    return { action: "pending", job: current, replacement: null };
  }

  const replacement = await findLegacyReplacementByReservation({ sourceJobId, reservationId });
  if (replacement) {
    const finalized = await finalizeLegacyMediaGenerationReplacement({
      jobId: sourceJobId,
      reservationId,
      replacementJobId: replacement.id,
    });
    return { action: "finalized", job: finalized, replacement };
  }
  if (reservationAge < Math.max(0, Number(staleMs) || 0)) {
    return { action: "pending", job: current, replacement: null };
  }
  const released = await releaseLegacyMediaGenerationReplacement({ jobId: sourceJobId, reservationId });
  return { action: "released", job: released, replacement: null };
};

export const recoverOrphanedLegacyMediaGenerationReplacements = async ({ ownerToken = "", nowMs = Date.now() } = {}) => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^generation-[a-z0-9-]{20,}\.json$/i.test(entry.name)) continue;
    const job = await readJob(entry.name.slice(0, -5));
    if (!job?.replacementReservationId) continue;
    results.push(await recoverLegacyMediaGenerationReplacement({ jobId: job.id, ownerToken, nowMs }));
  }
  return results;
};

export const completeMediaGenerationJob = ({ jobId, patch = {}, allowProviderCompletionAfterCancel = false } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于后台媒体队列", "MEDIA_JOB_COMPLETE_NOT_ALLOWED");
  }
  if (job.status === "complete") return null;
  if (job.status === "superseded" || job.supersededBy) {
    throw jobTransitionError("已取消或已替代的任务不能标记完成", "MEDIA_JOB_TERMINAL");
  }
  const stopped = Boolean(job.userStoppedAt || job.resultSuppressed);
  const stoppedCancellationWithDurableResult = job.status === "cancelled"
    && stopped
    && allowProviderCompletionAfterCancel
    && Boolean(patch?.result?.attachment?.relativePath && patch?.result?.attachment?.sha256);
  if (job.status === "cancelled" && !stoppedCancellationWithDurableResult) return null;
  const cancelPending = job.status === "cancel_requested"
    || job.desiredAction === "cancel"
    || stopped;
  if (cancelPending && !allowProviderCompletionAfterCancel) return null;
  return {
    ...scrubSecrets(patch),
    status: "complete",
    providerStatus: "completed",
    providerErrorCode: "",
    desiredAction: cancelPending ? "cancel" : "run",
    submissionState: "submitted",
    progressPercent: 100,
    billingRisk: "",
    resubmitConfirmationRequired: false,
    retryAllowed: false,
    transientFailures: 0,
    nextPollAt: "",
    failedAt: "",
    interruptedAt: "",
    completedAt: patch.completedAt || new Date().toISOString(),
    ...(!cancelPending ? { error: "" } : {}),
    ...(cancelPending ? {
      userStoppedAt: job.userStoppedAt || new Date().toISOString(),
      resultSuppressed: true,
      cancelRejectedAt: new Date().toISOString(),
      cancelOutcome: "provider_already_completed",
      error: "取消请求到达时厂商任务已经完成，结果已安全落盘。",
    } : {}),
  };
});

export const confirmMediaGenerationCancelled = ({ jobId, patch = {} } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于后台媒体队列", "MEDIA_JOB_CANCEL_NOT_ALLOWED");
  }
  if (["complete", "superseded"].includes(job.status) || job.supersededBy) return null;
  if (job.status === "cancelled") return null;
  return {
    ...scrubSecrets(patch),
    status: "cancelled",
    providerStatus: "cancelled",
    desiredAction: "cancel",
    providerResultUrl: "",
    resultUrlExpiresAt: "",
    progressPercent: 100,
    cancelledAt: patch.cancelledAt || new Date().toISOString(),
  };
});

export const updateRunnableMediaGenerationJob = ({ jobId, patch = {} } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于后台媒体队列", "MEDIA_JOB_UPDATE_NOT_ALLOWED");
  }
  if (["complete", "cancelled", "superseded"].includes(job.status) || job.supersededBy) return null;
  if (job.status === "cancel_requested" || job.desiredAction === "cancel") return null;
  return scrubSecrets(patch);
});

export const updateActiveMediaGenerationJob = ({ jobId, expectedDesiredAction = "", expectedStatuses = [], expectedUpdatedAt = "", patch = {} } = {}) => transitionJob(safeJobId(jobId), (job) => {
  if (job.mode !== "server" || !["image", "video", "audio"].includes(job.channel)) {
    throw jobTransitionError("此任务不属于后台媒体队列", "MEDIA_JOB_UPDATE_NOT_ALLOWED");
  }
  if (["complete", "cancelled", "superseded"].includes(job.status) || job.supersededBy) return null;
  const desiredAction = String(expectedDesiredAction || "");
  if (desiredAction && job.desiredAction !== desiredAction) return null;
  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses.map(String) : [];
  if (statuses.length && !statuses.includes(job.status)) return null;
  if (expectedUpdatedAt && job.updatedAt !== expectedUpdatedAt) return null;
  return scrubSecrets(patch);
});

export const readGenerationJobForWorker = async ({ jobId } = {}) => {
  const job = await readJob(safeJobId(jobId));
  if (!job) throw new Error("生成任务不存在");
  return job;
};

export const updateMediaGenerationJob = ({ jobId, patch = {} } = {}) => updateJob(safeJobId(jobId), patch);

const legacyDreaminaConcurrencyFailure = (job) => job?.mode === "server"
  && job.channel === "video"
  && job.status === "failed"
  && normalizedIdentity(job.request?.settings?.adapter) === "cli"
  && ["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider))
  && (/ExceedConcurrencyLimit|(?:ret|code)\s*[=:]\s*1310/i.test(String(job.error || ""))
    || String(job.providerErrorCode || "").toUpperCase() === "DREAMINA_CONCURRENCY_LIMIT");

const legacyDreaminaPreSubmitTransportFailure = (job) => job?.mode === "server"
  && ["image", "video"].includes(job.channel)
  && job.status === "failed"
  && !job.providerTaskId
  && job.submissionState === "not_submitted"
  && Number(job.attempt || 0) === 0
  && normalizedIdentity(job.request?.settings?.adapter) === "cli"
  && ["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider))
  && (/Dreamina CLI 命令 (?:version|user_credit) 超过 \d+ 秒未响应/i.test(String(job.error || ""))
    || /媒体驱动命令超过 \d+ 秒未响应/i.test(String(job.error || ""))
    || ["DRIVER_TIMEOUT", "DREAMINA_PROFILE_BROKER_BUSY", "DREAMINA_CREDIT_QUERY_TIMEOUT", "DREAMINA_CONTROL_PLANE_TRANSIENT"]
      .includes(String(job.providerErrorCode || "").toUpperCase()));

// Older workers treated an authsdk response from the paid video command as a
// definitive account failure and persisted waiting_credentials while the
// submission phase was already active. That state is not safe to resubmit:
// the provider may have accepted the request. Migrate it to the same durable
// reconciliation state used by the current worker, preserving the idempotency
// key and keeping the credential lock visible until the user resolves it.
const legacyDreaminaGenerationAuthFailure = (job) => {
  if (!job?.id
    || job.mode !== "server"
    || !["image", "video"].includes(String(job.channel || ""))
    || job.status !== "waiting_credentials"
    || job.providerTaskId
    || String(job.submissionState || "").toLowerCase() !== "submitting"
    || !["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider))
    || normalizedIdentity(job.request?.settings?.adapter) !== "cli"
    || !/^(?:DREAMINA_AUTH_REQUIRED|DREAMINA_GENERATION_SESSION_REJECTED)$/i.test(String(job.providerErrorCode || ""))
    || !/authsdk|未检测到(?:有效)?登录态|dreamina\s+login/i.test(String(job.error || ""))) return false;
  return true;
};

const recoverLegacyDreaminaGenerationAuthFailure = async (job) => {
  if (!legacyDreaminaGenerationAuthFailure(job)) return job;
  const now = new Date().toISOString();
  return updateJob(job.id, {
    status: "retry_required",
    providerStatus: "reconciling",
    providerErrorCode: "DREAMINA_SUBMISSION_UNCERTAIN",
    submissionState: "uncertain",
    progressPercent: Math.max(24, Number(job.progressPercent) || 0),
    failedAt: "",
    billingRisk: "submission_outcome_unknown",
    resubmitConfirmationRequired: false,
    safeNoTaskRetry: false,
    nextPollAt: now,
    automaticRecoveryStartedAt: job.automaticRecoveryStartedAt || now,
    automaticRecoveryStoppedAt: "",
    error: "旧版本曾把生成阶段会话异常误判为账号失效；当前版本已停止重复核验和重复提交，正在按原幂等键核对即梦任务。必要时请在占用任务列表手动终止本机任务。",
    heartbeatAt: now,
  });
};

const recoverLegacyDreaminaPreSubmitTransportFailure = async (job) => {
  if (!legacyDreaminaPreSubmitTransportFailure(job)) return job;
  const now = new Date().toISOString();
  return updateJob(job.id, {
    status: "failed",
    providerStatus: "not_submitted",
    providerErrorCode: "DREAMINA_PRE_SUBMIT_INTERRUPTED",
    progressPercent: 100,
    failedAt: job.failedAt || now,
    nextPollAt: "",
    safeNoTaskRetry: true,
    billingRisk: "",
    resubmitConfirmationRequired: false,
    error: "此前任务在进入即梦凭据槽前被旧版超时规则中断，未创建厂商任务、未扣积分；如仍需生成，请明确点击“重新生成”。",
    heartbeatAt: now,
  });
};

const recoverLegacyDreaminaConcurrencyFailure = async (job) => {
  if (!legacyDreaminaConcurrencyFailure(job)) {
    const safeCapacityRetryGuard = job?.mode === "server"
      && job.channel === "video"
      && job.status === "retry_required"
      && !job.providerTaskId
      && job.submissionState === "not_submitted"
      && job.capacityRetrySafe === true
      && !job.billingRisk
      && job.resubmitConfirmationRequired !== true;
    if (safeCapacityRetryGuard) {
      const now = new Date().toISOString();
      return updateJob(job.id, {
        status: "queued",
        providerStatus: "queued",
        providerErrorCode: "",
        progressPercent: 8,
        failedAt: "",
        nextPollAt: now,
        error: "即梦此前明确拒绝创建收费项目；正在恢复安全排队，不会重复计费。",
        heartbeatAt: now,
      });
    }
    const safeValidatorPreflightFailure = job?.mode === "server"
      && job.channel === "video"
      && job.status === "failed"
      && !job.providerTaskId
      && job.submissionState === "not_submitted"
      && job.capacityRetrySafe === true
      && job.providerErrorCode === "VIDEO_VALIDATOR_UNAVAILABLE"
      && Number(job.preflightRecoveryCount || 0) < 1;
    if (!safeValidatorPreflightFailure) return job;
    const now = new Date().toISOString();
    return updateJob(job.id, {
      status: "queued",
      providerStatus: "queued",
      providerErrorCode: "",
      progressPercent: 8,
      failedAt: "",
      nextPollAt: now,
      preflightRecoveryCount: Number(job.preflightRecoveryCount || 0) + 1,
      error: "正在重新检查随包视频校验器；尚未向厂商提交，不会产生重复计费。",
      heartbeatAt: now,
    });
  }
  const providerTaskAccepted = Boolean(job.providerTaskId) && Number(job.pollCount || 0) > 0;
  const now = new Date().toISOString();
  return updateJob(job.id, providerTaskAccepted ? {
    status: "polling",
    providerStatus: "queued",
    providerErrorCode: "DREAMINA_CONCURRENCY_LIMIT",
    progressPercent: Math.max(24, Number(job.progressPercent) || 0),
    failedAt: "",
    nextPollAt: now,
    error: "正在按原厂商任务 ID 恢复查询；不会重新提交或重复计费。",
    heartbeatAt: now,
  } : {
    status: "queued",
    providerTaskId: null,
    rejectedProviderTaskId: job.providerTaskId || job.rejectedProviderTaskId || null,
    providerStatus: "queued",
    providerErrorCode: "DREAMINA_CONCURRENCY_LIMIT",
    submissionState: "not_submitted",
    capacityRetrySafe: true,
    transientFailures: Math.max(1, Number(job.transientFailures) || 0),
    progressPercent: 8,
    failedAt: "",
    nextPollAt: now,
    error: "此前即梦因并发名额不足拒绝创建项目；任务已恢复到本地队列，将在名额释放后自动重试。",
    heartbeatAt: now,
  });
};

const recoverTransientProviderTrackingFailure = async (job) => {
  const code = String(job?.providerErrorCode || "").toUpperCase();
  const recoverable = job?.mode === "server"
    && ["image", "video", "audio"].includes(job.channel)
    && job.status === "failed"
    && Boolean(job.providerTaskId)
    && !["failed", "cancelled"].includes(String(job.providerStatus || "").toLowerCase())
    && (/^(?:DRIVER_EXIT_FAILED|DRIVER_TIMEOUT|DREAMINA_QUERY_TRANSIENT|DREAMINA_RESULT_PENDING|WORKSPACE_STATE_CONFLICT|WORKSPACE_BUSY|EBUSY|EPERM)$/.test(code)
      || /Dreamina CLI[^\n]*退出码\s*1[^\n]*(?:没有错误输出|no error output)/i.test(String(job.error || ""))
      || /正在被另一个神思任务写入|另一个窗口或任务中更新/.test(String(job.error || "")));
  if (!recoverable) return job;
  const now = new Date().toISOString();
  return updateJob(job.id, {
    status: job.providerStatus === "completed" ? "downloading" : "polling",
    providerErrorCode: "DREAMINA_QUERY_TRANSIENT",
    progressPercent: Math.max(24, Number(job.progressPercent) || 0),
    failedAt: "",
    nextPollAt: now,
    error: "此前一次即梦查询进程异常退出，但原厂商任务 ID 完整；已恢复持续查询，不会重新提交或重复扣费。",
    heartbeatAt: now,
  });
};

const recoverLegacyAggregateReferencePreflightFailure = async (job) => {
  const patch = legacyAggregateReferencePreflightFailurePatch(job);
  return patch ? updateJob(job.id, patch) : job;
};

export const listMediaGenerationJobsForWorker = async () => {
  await mkdir(jobsRoot(), { recursive: true });
  const entries = await readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (let job of await readGenerationJobs(entries)) {
    if (await pruneExpiredGenerationJob(job)) continue;
    job = await recoverLegacyDreaminaGenerationAuthFailure(job);
    job = await recoverLegacyAggregateReferencePreflightFailure(job);
    job = await recoverLegacyDreaminaPreSubmitTransportFailure(job);
    job = await recoverLegacyDreaminaConcurrencyFailure(job);
    job = await recoverTransientProviderTrackingFailure(job);
    if (mediaGenerationCancellationFinalizationExpired(job)) {
      job = await finalizeMediaGenerationCancellation({
        jobId: job.id,
        reason: "provider_cancel_confirmation_timeout",
      });
    }
    if (!job || ["complete", "cancelled", "superseded"].includes(job.status)) continue;
    // A force-release request has already stopped the local worker. Keep the
    // record auditable, but do not let the watchdog launch it again while the
    // credential-slot probe is waiting for every competing task to finish.
    const forceReleasePending = Boolean(job.forceReleasePendingAt && !job.forceReleaseCompletedAt);
    if (forceReleasePending) continue;
    const automaticSubmissionReconciliation = job?.mode === "server"
      && ["image", "video"].includes(job.channel)
      && job.status === "retry_required"
      && !job.providerTaskId
      && (job.billingRisk === "submission_outcome_unknown" || job.resubmitConfirmationRequired === true || ["submitting", "uncertain", "unknown"].includes(String(job.submissionState || "")))
      && ((normalizedIdentity(job.request?.settings?.adapter) === "cli"
        && (["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider))
          || (job.channel === "image"
            && normalizedIdentity(job.request?.settings?.provider) === "openai"
            && normalizedIdentity(job.request?.settings?.cliPath || "shensi-openai-image") === "shensi-openai-image")))
        || (builtInAggregateImageRecoveryJob(job)
          && job.providerStatus === "reconciling"
          && Boolean(job.nextPollAt)));
    const recoverableDreaminaAuthTransport = job?.mode === "server"
      && job.status === "waiting_credentials"
      && String(job.providerErrorCode || "") === "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED"
      && normalizedIdentity(job.request?.settings?.adapter) === "cli"
      && ["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider));
    if (job?.mode === "server" && (["queued", "submitting", "running", "polling", "downloading", "waiting_storage", "cancel_requested"].includes(job.status) || automaticSubmissionReconciliation || recoverableDreaminaAuthTransport)) jobs.push(job);
  }
  return jobs.sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
};

export const generationJobsDirectory = () => jobsRoot();
