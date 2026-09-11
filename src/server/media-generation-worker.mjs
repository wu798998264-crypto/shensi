#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { generateImageWithAdapter } from "./adapters.mjs";
import { OPENAI_IMAGE_CLI_ALIAS } from "../media-cli-presets.js";
import { classifyCustomApiCapabilityFailure } from "../custom-api-capabilities.js";
import { dreaminaFailureDiagnosis, dreaminaFailureRequiresAccountVerification } from "../dreamina-failure.js";
import { dreaminaResultRecoveryPolicy } from "../dreamina-result-recovery-policy.js";
import { appDataRoot, initializeConfiguredDataRoot } from "./app-data.mjs";
import { createUpdateWriteBarrier } from "./update-write-barrier.mjs";
import {
  generationJobsDirectory,
  completeMediaGenerationJob,
  confirmMediaGenerationCancelled,
  listMediaGenerationJobsForWorker,
  readGenerationJobForWorker,
  updateActiveMediaGenerationJob,
  updateMediaGenerationJob,
  updateRunnableMediaGenerationJob,
} from "./generation-job-store.mjs";
import { resolveMediaProviderDriver } from "./media-provider-drivers.mjs";
import {
  aggregateImageRecoveryPolicy,
  builtInAggregateImageRecoveryJob,
  classifyMediaSubmissionFailure,
  DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS,
  DEFAULT_AGGREGATE_IMAGE_RECOVERY_POLL_MS,
  DEFAULT_AGGREGATE_IMAGE_RECOVERY_WINDOW_MS,
} from "./media-submission-recovery.mjs";
import { durableProviderPollDelayMs, providerTerminalStatus } from "../media-provider-poll-policy.js";
import {
  DEFAULT_OPENAI_IMAGE_RECOVERY_POLL_MS,
  DEFAULT_OPENAI_IMAGE_RECOVERY_WINDOW_MS,
  openAiImageRecoveryPolicy,
} from "../openai-image-recovery-policy.js";
import {
  canonicalMediaProfileSignature,
  CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX,
  mediaCapabilityEvidenceExpiry,
} from "./media-profile-signature.mjs";
import { resolveTrustedGenerationSettings } from "./generation-runtime-store.mjs";
import { recordDreaminaProfileCreditEstimate } from "./dreamina-profile-identity-store.mjs";
import {
  dreaminaCancellationReconciliationExpired,
  dreaminaCredentialIdentity,
  requireDreaminaCliProfileId,
} from "../dreamina-manual-profile-policy.js";
import { dreaminaTaskSessionRecoveryPolicy } from "../dreamina-task-session-recovery-policy.js";
import { dreaminaExpectedIdentitySync } from "./dreamina-profile-identity-store.mjs";
import {
  DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS,
  dreaminaSubmissionReconciliationLease,
} from "./dreamina-submission-reconciliation-lease.mjs";
import {
  readWorkspaceAttachments,
  probeVideoValidationRuntime,
  saveWorkspaceAttachment,
  saveWorkspaceAttachmentFromPath,
  saveWorkspaceAttachmentFromStream,
  upsertWorkspaceMediaBatchIndex,
  upsertWorkspaceWhiteboardMediaIndex,
} from "./workspace.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};
const targetJobId = option("--job");
const appRoot = resolve(option("--app-root", process.cwd()));
const scanMode = targetJobId ? "targeted" : option("--scan-mode", "startup");
const recoveryScan = !targetJobId && ["startup", "watchdog"].includes(scanMode);
const POLL_INTERVAL_MS = Math.max(100, Number(process.env.SHENSI_MEDIA_POLL_INTERVAL_MS) || 2_000);
const LOCK_STALE_MS = Math.max(3_000, Number(process.env.SHENSI_MEDIA_LOCK_STALE_MS) || 8_000);
const MAX_TRANSIENT_FAILURES = Math.max(3, Number(process.env.SHENSI_MEDIA_MAX_TRANSIENT_FAILURES) || 12);
const MAX_MEDIA_DOWNLOAD_INTEGRITY_RETRIES = Math.max(
  1,
  Number(process.env.SHENSI_MEDIA_DOWNLOAD_INTEGRITY_RETRIES) || 3,
);
const MEDIA_DOWNLOAD_INTEGRITY_CODES = new Set([
  "MEDIA_DOWNLOAD_TRUNCATED",
  "MEDIA_DURATION_INCOMPLETE",
  "MEDIA_VALIDATION_FAILED",
  "FFPROBE_MEDIA_ERROR",
  "FFPROBE_EXIT_NONZERO",
  "FFPROBE_OUTPUT_INVALID",
]);
const RECOVERY_FRESH_JOB_GRACE_MS = Math.max(5_000, Number(process.env.SHENSI_MEDIA_RECOVERY_FRESH_JOB_GRACE_MS) || 45_000);
const OPENAI_IMAGE_RECOVERY_POLL_MS = Number(process.env.SHENSI_OPENAI_IMAGE_RECOVERY_POLL_MS) || DEFAULT_OPENAI_IMAGE_RECOVERY_POLL_MS;
const OPENAI_IMAGE_RECOVERY_WINDOW_MS = Number(process.env.SHENSI_OPENAI_IMAGE_RECOVERY_WINDOW_MS) || DEFAULT_OPENAI_IMAGE_RECOVERY_WINDOW_MS;
const AGGREGATE_IMAGE_RECOVERY_POLL_MS = Number(process.env.SHENSI_AGGREGATE_IMAGE_RECOVERY_POLL_MS) || DEFAULT_AGGREGATE_IMAGE_RECOVERY_POLL_MS;
const AGGREGATE_IMAGE_RECOVERY_WINDOW_MS = Number(process.env.SHENSI_AGGREGATE_IMAGE_RECOVERY_WINDOW_MS) || DEFAULT_AGGREGATE_IMAGE_RECOVERY_WINDOW_MS;
const AGGREGATE_IMAGE_RECOVERY_ATTEMPTS = Number(process.env.SHENSI_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS) || DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS;
const DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS = Number(process.env.SHENSI_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS)
  || DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS;

const ephemeralSettings = (() => {
  const encoded = String(process.env.SHENSI_MEDIA_WORKER_SETTINGS || "");
  delete process.env.SHENSI_MEDIA_WORKER_SETTINGS;
  if (!encoded) return {};
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return {}; }
})();

const ephemeralCredentials = (() => {
  const encoded = String(process.env.SHENSI_MEDIA_WORKER_CREDENTIALS || "");
  delete process.env.SHENSI_MEDIA_WORKER_CREDENTIALS;
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([channel, records]) =>
      ["text", "image", "video", "audio"].includes(channel)
      && records && typeof records === "object" && !Array.isArray(records),
    ).map(([channel, records]) => [channel, Object.fromEntries(
      Object.entries(records).slice(0, 512).map(([profileId, value]) => [
        String(profileId).slice(0, 120),
        String(value || "").slice(0, 16_384),
      ]).filter(([, value]) => value),
    )]));
  } catch {
    return {};
  }
})();

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const errorMessage = (error) => String(error?.message || error || "媒体任务失败").slice(0, 2000);
const imageAttachmentName = (job, index, extension) => {
  const batchId = String(job?.target?.mediaBatchId || "").trim();
  if (!batchId) return `神思生图-${job.id}${index ? `-${index + 1}` : ""}.${extension}`;
  const batchIndex = Math.max(1, Number(job.target?.mediaBatchIndex) || 1);
  const batchTotal = Math.max(1, Number(job.target?.mediaBatchTotal) || 1);
  const width = Math.max(2, String(batchTotal).length);
  const outputSuffix = index ? `-${index + 1}` : "";
  const label = String(job.target?.mediaBatchLabel || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return `${String(batchIndex).padStart(width, "0")}${outputSuffix}-${job.id}${label ? `-${label}` : ""}.${extension}`;
};
const whiteboardMediaJob = (job) => job?.target?.targetType === "whiteboard-node"
  && Boolean(String(job?.target?.documentId || "").trim())
  && Boolean(String(job?.target?.nodeId || "").trim());
const workspaceMediaDestination = (job) => whiteboardMediaJob(job)
  ? {
      whiteboardDocumentId: job.target.documentId,
      whiteboardMediaKind: job.channel,
    }
  : {
      mediaBatchId: job?.channel === "image" ? job?.target?.mediaBatchId : "",
    };
const updateMediaLandingIndex = async (job, attachments) => {
  if (whiteboardMediaJob(job) && ["image", "video"].includes(job.channel)) {
    try {
      const index = await upsertWorkspaceWhiteboardMediaIndex({
        appRoot,
        requestedPath: job.target.workspacePath,
        documentId: job.target.documentId,
        nodeId: job.target.nodeId,
        jobId: job.id,
        channel: job.channel,
        prompt: job.request?.prompt,
        attachments,
        completedAt: new Date().toISOString(),
      });
      return index ? {
        ...index,
        mediaBatchDirectory: index.whiteboardMediaDirectory,
        mediaBatchIndexPath: index.whiteboardMediaIndexPath,
      } : {};
    } catch (error) {
      const mediaDirectory = attachments[0]?.relativePath
        ? dirname(dirname(String(attachments[0].relativePath))).replaceAll("\\", "/")
        : "";
      return {
        whiteboardMediaDirectory: mediaDirectory,
        mediaBatchDirectory: mediaDirectory,
        mediaBatchIndexError: errorMessage(error),
      };
    }
  }
  if (job?.channel !== "image" || !job?.target?.mediaBatchId) return {};
  try {
    const index = await upsertWorkspaceMediaBatchIndex({
      appRoot,
      requestedPath: job.target.workspacePath,
      mediaBatchId: job.target.mediaBatchId,
      jobId: job.id,
      batchIndex: job.target.mediaBatchIndex,
      batchTotal: job.target.mediaBatchTotal,
      batchLabel: job.target.mediaBatchLabel,
      prompt: job.request?.prompt,
      attachments,
      completedAt: new Date().toISOString(),
    });
    return index || {};
  } catch (error) {
    const mediaBatchDirectory = attachments[0]?.relativePath
      ? dirname(String(attachments[0].relativePath)).replaceAll("\\", "/")
      : "";
    return { mediaBatchDirectory, mediaBatchIndexError: errorMessage(error) };
  }
};
const normalizedIdentity = (value) => String(value || "").trim().toLowerCase();
const openAiImageCliJob = (job = {}) => job.channel === "image"
  && normalizedIdentity(job.request?.settings?.adapter) === "cli"
  && normalizedIdentity(job.request?.settings?.provider) === "openai"
  && normalizedIdentity(job.request?.settings?.cliPath || OPENAI_IMAGE_CLI_ALIAS) === OPENAI_IMAGE_CLI_ALIAS;
const dreaminaCliMediaJob = (job = {}) => ["image", "video"].includes(String(job.channel || ""))
  && normalizedIdentity(job.request?.settings?.adapter) === "cli"
  && ["即梦", "dreamina"].includes(normalizedIdentity(job.request?.settings?.provider));
const dreaminaAutomaticSubmissionRecoveryAllowed = (job = {}) => {
  const lease = dreaminaSubmissionReconciliationLease(job, { leaseMs: DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS });
  return !lease.stopped && !lease.expired;
};
const automaticSubmissionRecoveryJob = (job = {}) => submissionOutcomeUnknown(job)
  && (
    (normalizedIdentity(job.request?.settings?.adapter) === "cli"
      && (openAiImageCliJob(job) || (dreaminaCliMediaJob(job) && dreaminaAutomaticSubmissionRecoveryAllowed(job))))
    || (builtInAggregateImageRecoveryJob(job) && !aggregateImageRecoveryPolicy(job, {
      pollMs: AGGREGATE_IMAGE_RECOVERY_POLL_MS,
      windowMs: AGGREGATE_IMAGE_RECOVERY_WINDOW_MS,
      maxAttempts: AGGREGATE_IMAGE_RECOVERY_ATTEMPTS,
    }).expired)
  );

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

const readJobLockOwner = async (lockPath) => {
  try {
    return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const acquireJobLock = async (jobId) => {
  const lockRoot = join(generationJobsDirectory(), ".locks");
  const lockPath = join(lockRoot, `${jobId}.lock`);
  const token = `${process.pid}-${randomUUID()}`;
  await mkdir(lockRoot, { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS + 2_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), "utf8");
      const heartbeat = async () => writeFile(join(lockPath, "heartbeat.json"), JSON.stringify({ token, at: new Date().toISOString() }), "utf8").catch(() => {});
      await heartbeat();
      const timer = setInterval(heartbeat, 2_000);
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        const owner = await readJobLockOwner(lockPath).catch(() => null);
        if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const [owner, heartbeatMetadata, lockMetadata] = await Promise.all([
        readJobLockOwner(lockPath).catch(() => null),
        stat(join(lockPath, "heartbeat.json")).catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      const activityMetadata = heartbeatMetadata || lockMetadata;
      const stale = activityMetadata && Date.now() - activityMetadata.mtimeMs > LOCK_STALE_MS;
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
      return null;
    }
  }
  return null;
};

const update = (jobId, patch) => updateMediaGenerationJob({ jobId, patch });

const mediaJobAllowsTargetIndexWrite = async (jobId) => {
  const current = await readGenerationJobForWorker({ jobId });
  return !current.userStoppedAt
    && !current.resultSuppressed
    && current.desiredAction !== "cancel"
    && !["cancelled", "superseded"].includes(current.status)
    && !current.supersededBy;
};

const providerQueueNumber = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const providerProgressNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : null;
};

const providerResultProgress = (result = {}) => {
  const explicitPercent = result.progressPercent
    ?? result.raw?.progress_percent
    ?? result.raw?.output?.progress_percent
    ?? result.raw?.data?.progress_percent;
  if (explicitPercent !== null && explicitPercent !== undefined) return explicitPercent;
  const genericProgress = result.raw?.progress ?? result.raw?.output?.progress ?? result.raw?.data?.progress;
  const parsed = Number(genericProgress);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed * 100 : genericProgress;
};

const VALID_PROVIDER_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const assertProviderStatus = (result, phase) => {
  const status = String(result?.providerStatus || "");
  if (VALID_PROVIDER_STATUSES.has(status)) return status;
  // Defensive compatibility for older/custom CLI bridges. Submission verbs
  // mean the provider accepted or is processing the request; they are never a
  // terminal failure and must remain pollable.
  const rawStatus = String(result?.rawStatus || status || "").trim().toLowerCase();
  if (["submit", "submitted", "submitting", "querying", "processing", "generating", "in_progress", "in-progress"].includes(rawStatus)) return "running";
  throw Object.assign(
    new Error(`${phase}返回无法识别的厂商状态：${result?.rawStatus || status || "空状态"}`),
    {
      providerErrorCode: result?.errorCode || "INVALID_PROVIDER_STATUS",
      ...(result?.providerTaskId ? { providerTaskId: String(result.providerTaskId) } : {}),
    },
  );
};

const providerPatch = (result = {}) => ({
  ...(result.providerTaskId ? { providerTaskId: result.providerTaskId } : {}),
  providerStatus: String(result.providerStatus || result.rawStatus || "running"),
  providerRawStatus: String(result.rawStatus || ""),
  providerErrorCode: String(result.errorCode || ""),
  ...(result.failureCategory ? { failureCategory: String(result.failureCategory) } : {}),
  ...(result.failureReason ? { failureReason: String(result.failureReason) } : {}),
  ...(result.failureResolution ? { failureResolution: String(result.failureResolution) } : {}),
  ...(result.resultUrl ? { providerResultUrl: String(result.resultUrl) } : {}),
  ...(result.resultUrlExpiresAt ? { resultUrlExpiresAt: String(result.resultUrlExpiresAt) } : {}),
  ...(providerProgressNumber(providerResultProgress(result)) !== null ? { providerProgressPercent: providerProgressNumber(providerResultProgress(result)) } : {}),
  providerQueuePosition: providerQueueNumber(result.providerQueuePosition),
  providerQueueLength: providerQueueNumber(result.providerQueueLength),
  providerQueuePriority: providerQueueNumber(result.providerQueuePriority),
  providerQueueStatus: String(result.providerQueueStatus || ""),
  ...(Number.isFinite(Number(result.creditCount)) && Number(result.creditCount) > 0
    ? { providerCreditCount: Number(result.creditCount) }
    : {}),
  ...(result.executionReceipt && typeof result.executionReceipt === "object" ? {
    providerExecutionReceipt: {
      profileId: String(result.executionReceipt.profileId || ""),
      expectedUserId: String(result.executionReceipt.expectedUserId || ""),
      actualUserId: String(result.executionReceipt.actualUserId || ""),
      credentialFingerprint: String(result.executionReceipt.credentialFingerprint || ""),
      verificationSource: String(result.executionReceipt.verificationSource || ""),
      recordedAt: new Date().toISOString(),
    },
  } : {}),
  lastPolledAt: new Date().toISOString(),
});

const transientProviderFailure = (error) => {
  const code = String(error?.providerErrorCode || error?.code || "").toUpperCase();
  const message = errorMessage(error);
  return /^(?:HTTP_(?:408|409|425|429|5\d\d)|DRIVER_TIMEOUT|DRIVER_EXIT_FAILED|DREAMINA_(?:PROFILE_BROKER_BUSY|AUTH_REFRESH_TRANSPORT_FAILED|CREDIT_QUERY_TIMEOUT|CONTROL_PLANE_TRANSIENT|QUERY_TRANSIENT|RESULT_PENDING)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_)/.test(code)
    || /fetch failed|network|socket|timeout|timed out|temporarily unavailable|rate limit/i.test(message);
};

const explicitDreaminaAccountVerificationFailure = (job, error) => dreaminaCliMediaJob(job)
  && dreaminaFailureRequiresAccountVerification({
    code: String(error?.providerErrorCode || error?.code || ""),
    message: errorMessage(error),
    providerTaskId: job?.providerTaskId,
    submissionState: job?.submissionState,
  });

const mediaDownloadIntegrityFailure = (job, error) => {
  if (job?.channel !== "video") return false;
  const code = String(error?.providerErrorCode || error?.code || "").toUpperCase();
  return MEDIA_DOWNLOAD_INTEGRITY_CODES.has(code);
};

const providerCapacityLimited = (value = {}) => value.capacityLimited === true
  || String(value.providerErrorCode || value.errorCode || value.code || "").toUpperCase() === "DREAMINA_CONCURRENCY_LIMIT"
  || /ExceedConcurrencyLimit|(?:ret|code)\s*[=:]\s*1310/i.test(errorMessage(value));

const transientBackoffMs = (failureCount, retryAfterMs = 0) => Math.max(
  Number(retryAfterMs) || 0,
  Math.min(30_000, 750 * (2 ** Math.min(6, Math.max(0, failureCount - 1)))),
);

const capacityBackoffMs = (failureCount, retryAfterMs = 0) => Math.max(
  Number(retryAfterMs) || 0,
  Math.min(15 * 60_000, 60_000 * (2 ** Math.min(4, Math.max(0, failureCount - 1)))),
);

const submissionOutcomeUnknown = (job) => !job.providerTaskId && (
  job.billingRisk === "submission_outcome_unknown"
  || job.resubmitConfirmationRequired === true
  || ["submitting", "uncertain", "unknown"].includes(String(job.submissionState || ""))
);

const freshUnsubmittedJob = (job) => {
  if (job.providerTaskId || job.status !== "queued" || job.submissionState !== "not_submitted" || Number(job.attempt || 0) !== 0) return false;
  const timestamps = [job.createdAt, job.heartbeatAt]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  const lastActivityAt = timestamps.length ? Math.max(...timestamps) : 0;
  return lastActivityAt > 0 && Date.now() - lastActivityAt < RECOVERY_FRESH_JOB_GRACE_MS;
};

const reconcileUnknownCancellation = async (job) => update(job.id, {
  status: "retry_required",
  providerStatus: "unknown",
  desiredAction: "run",
  progressPercent: 100,
  billingRisk: "submission_outcome_unknown",
  resubmitConfirmationRequired: true,
  retryAllowed: true,
  error: "厂商可能已收到提交，但本地没有任务 ID，无法证明取消成功；请先在厂商任务列表核对，不能把任务伪装成已取消。",
  heartbeatAt: new Date().toISOString(),
});

const settleProviderCancellation = async ({ job, settings, driver, workRoot }) => {
  if (!job.providerTaskId) {
    if (!submissionOutcomeUnknown(job) && job.submissionState === "not_submitted" && Number(job.attempt || 0) === 0) {
      const cancelled = await update(job.id, {
        status: "cancelled",
        providerStatus: "cancelled",
        desiredAction: "cancel",
        providerResultUrl: "",
        resultUrlExpiresAt: "",
        progressPercent: 100,
        cancelledAt: new Date().toISOString(),
      });
      return { outcome: "cancelled", job: cancelled };
    }
    return { outcome: "reconciliation_required", job: await reconcileUnknownCancellation(job) };
  }

  let observed;
  const providerCancelAlreadyHandled = Boolean(job.providerCancelAcceptedAt || job.providerCancelUnsupportedAt);
  if (providerCancelAlreadyHandled) {
    observed = await driver.resume({ job, settings, workRoot });
  } else {
    try {
      observed = await driver.cancel({ job, settings, workRoot });
    } catch (error) {
      if (!/HTTP_(?:404|409)/i.test(String(error.providerErrorCode || error.code || error.message))) throw error;
      observed = await driver.resume({ job, settings, workRoot });
    }
    job = await update(job.id, observed?.cancellationUnsupported === true ? {
      providerCancelUnsupportedAt: new Date().toISOString(),
      providerCancelAttempts: Math.max(1, Number(job.providerCancelAttempts || 0) + 1),
      heartbeatAt: new Date().toISOString(),
    } : {
      providerCancelAcceptedAt: new Date().toISOString(),
      providerCancelAttempts: Math.max(1, Number(job.providerCancelAttempts || 0) + 1),
      heartbeatAt: new Date().toISOString(),
    });
  }
  const cancellationUnsupported = observed?.cancellationUnsupported === true;
  if (!cancellationUnsupported && !["completed", "cancelled", "failed"].includes(String(observed?.providerStatus || ""))) {
    try {
      observed = await driver.resume({ job, settings, workRoot });
    } catch (error) {
      if (!transientProviderFailure(error)) throw error;
      const pending = await update(job.id, {
        status: "cancel_requested",
        desiredAction: "cancel",
        providerErrorCode: String(error.providerErrorCode || error.code || ""),
        error: `厂商已接收取消请求，确认状态暂时不可用，将继续核对：${errorMessage(error)}`,
        nextPollAt: new Date(Date.now() + transientBackoffMs(1, error.retryAfterMs)).toISOString(),
        heartbeatAt: new Date().toISOString(),
      });
      return { outcome: "pending", job: pending };
    }
  }

  const state = String(observed?.providerStatus || "running");
  if (cancellationUnsupported && !["completed", "cancelled", "failed"].includes(state)) {
    const pending = await update(job.id, {
      status: "cancel_requested",
      ...providerPatch(observed),
      desiredAction: "cancel",
      error: observed.cancellationMessage || "当前媒体驱动不支持取消厂商任务；神思将继续跟踪原任务。",
      nextPollAt: new Date(Date.now() + Math.max(POLL_INTERVAL_MS, 20_000)).toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    return { outcome: "pending", job: pending };
  }
  if (state === "completed") {
    const completed = await update(job.id, {
      status: "downloading",
      ...providerPatch(observed),
      desiredAction: "run",
      cancelRejectedAt: new Date().toISOString(),
      cancelOutcome: "provider_already_completed",
      error: "取消请求到达时厂商任务已经完成，正在安全下载结果。",
      heartbeatAt: new Date().toISOString(),
    });
    return { outcome: "completed", job: completed };
  }
  if (state === "cancelled") {
    const cancelled = await confirmMediaGenerationCancelled({ jobId: job.id, patch: {
      ...providerPatch(observed),
      cancelledAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    } });
    return { outcome: cancelled.status === "cancelled" ? "cancelled" : "terminal", job: cancelled };
  }
  if (state === "failed") {
    const failed = await update(job.id, {
      status: "failed",
      ...providerPatch(observed),
      desiredAction: "run",
      progressPercent: 100,
      failedAt: new Date().toISOString(),
      error: observed.error || "厂商任务在取消确认前已经失败。",
      heartbeatAt: new Date().toISOString(),
    });
    return { outcome: "failed", job: failed };
  }
  const pending = await update(job.id, {
    status: "cancel_requested",
    ...providerPatch(observed),
    desiredAction: "cancel",
    error: "厂商已接收取消请求，正在等待厂商确认终态。",
    nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
    heartbeatAt: new Date().toISOString(),
  });
  return { outcome: "pending", job: pending };
};

const resolvedSettings = async (job) => {
  const connectionId = String(job.request?.settings?.connectionId || job.request?.settings?.id || "").trim();
  const handedOffCredential = String(ephemeralSettings.apiKey || ephemeralCredentials?.[job.channel]?.[connectionId] || "").trim();
  return resolveTrustedGenerationSettings({
    channel: job.channel,
    settings: {
      ...(job.request?.settings || {}),
      ...ephemeralSettings,
      ...(handedOffCredential ? { apiKey: handedOffCredential } : {}),
      workspacePath: job.target.workspacePath,
    },
  });
};

const executionProfileSignature = (job, settings) => {
  if (job.profileIdentityVerified === false) return "";
  if (dreaminaCliMediaJob(job) && String(job.profileIdentityKey || "").trim()) {
    const profileId = requireDreaminaCliProfileId(settings);
    const expected = dreaminaExpectedIdentitySync(profileId);
    const currentIdentity = dreaminaCredentialIdentity({
      credentialIdentityUserId: expected.verifiedUserId || expected.expectedUserId,
      credentialIdentityFingerprint: expected.credentialFingerprint,
    });
    if (!currentIdentity || currentIdentity !== String(job.profileIdentityKey).trim()) {
      throw Object.assign(
        new Error("当前即梦任务绑定的账号身份已变化；已停止使用新账号续接原任务，请恢复原配置后再继续"),
        { providerErrorCode: "DREAMINA_ACCOUNT_MISMATCH" },
      );
    }
  }
  if (!String(job.profileSignature || "").startsWith(CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX)) return "";
  if (settings.adapter === "api" && !settings.apiKey) {
    throw Object.assign(
      new Error("原媒体任务需要同一连接凭证才能继续，尚未向厂商发起任何操作"),
      { providerErrorCode: "MISSING_CREDENTIALS" },
    );
  }
  const current = canonicalMediaProfileSignature(job.channel, settings);
  if (!String(job.profileSignature || "").startsWith(CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX)
    || current !== job.profileSignature) {
    throw Object.assign(
      new Error("当前 endpoint、CLI 参数、模型或凭证身份与任务创建时不一致；已在厂商调用前停止，请恢复原配置后继续"),
      { providerErrorCode: "MEDIA_JOB_CANONICAL_PROFILE_MISMATCH" },
    );
  }
  return current;
};

const loadReferences = (job) => job.request?.referenceMedia?.length
  ? readWorkspaceAttachments({ appRoot, requestedPath: job.target.workspacePath, attachments: job.request.referenceMedia })
  : [];

const processImageJob = async (job, settings) => {
  const explicitRetry = Boolean(job.explicitRetryAt);
  const recoveryOnly = !explicitRetry && (Number(job.attempt || 0) > 0 || job.status !== "queued");
  const aggregateAutomaticRecovery = recoveryOnly && builtInAggregateImageRecoveryJob(job);
  const recoveryStartedAt = recoveryOnly ? (job.startedAt || job.createdAt || "") : "";
  const recoveryEndedAt = recoveryOnly ? (job.updatedAt || "") : "";
  const attempt = recoveryOnly ? Number(job.attempt || 0) : Number(job.attempt || 0) + 1;
  const started = await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
    status: "submitting",
    providerStatus: "submitting",
    submissionState: "submitting",
    progressPercent: 12,
    attempt,
    ...(aggregateAutomaticRecovery ? {
      aggregateRecoveryAttempts: Math.max(0, Number(job.aggregateRecoveryAttempts) || 0) + 1,
      aggregateRecoveryLastAttemptAt: new Date().toISOString(),
    } : explicitRetry && builtInAggregateImageRecoveryJob(job) ? {
      aggregateRecoveryAttempts: 0,
      aggregateRecoveryLastAttemptAt: "",
      automaticRecoveryStartedAt: "",
      automaticRecoveryStoppedAt: "",
    } : {}),
    explicitRetryAt: "",
    startedAt: job.startedAt || new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  } });
  if (started.status !== "submitting" || started.desiredAction === "cancel") return;
  job = started;
  const referenceMedia = await loadReferences(job);
  await update(job.id, { progressPercent: 24, heartbeatAt: new Date().toISOString() });
  const generated = await generateImageWithAdapter({
    settings,
    prompt: job.request.executionPrompt || job.request.prompt,
    referencePromptTokens: job.request.providerPromptReferenceTokens || [],
    spec: job.request.spec,
    aspectRatio: job.request.aspectRatio,
    quality: job.request.quality,
    imageCount: Math.max(1, Math.min(4, Number(job.request.imageCount) || 1)),
    referenceMedia,
    idempotencyKey: job.idempotencyKey,
    recoveryOnly,
    forceNewSubmission: explicitRetry,
    recoveryStartedAt,
    recoveryEndedAt,
  });
  const returnedDataUrls = (Array.isArray(generated.dataUrls) && generated.dataUrls.length
    ? generated.dataUrls
    : [generated.dataUrl]
  ).map((value) => String(value || "")).filter(Boolean).slice(0, 4);
  const attachments = [];
  for (let index = 0; index < returnedDataUrls.length; index += 1) {
    const [, mimeType = "image/png", base64 = ""] = returnedDataUrls[index].match(/^data:([^;]+);base64,(.+)$/s) ?? [];
    if (!base64) throw new Error("生成图片格式无效");
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    attachments.push(await saveWorkspaceAttachment({
      appRoot,
      requestedPath: job.target.workspacePath,
      name: imageAttachmentName(job, index, extension),
      mimeType,
      base64,
      requireValidImage: true,
      stableName: true,
      ...workspaceMediaDestination(job),
    }));
  }
  if (!attachments.length) throw new Error("生成图片格式无效");
  const attachment = attachments[0];
  const mediaBatchIndex = await mediaJobAllowsTargetIndexWrite(job.id)
    ? await updateMediaLandingIndex(job, attachments)
    : {};
  const verifiedAt = new Date().toISOString();
  const evidenceExpiresAt = mediaCapabilityEvidenceExpiry(verifiedAt);
  const completionPatch = {
    providerTaskId: generated.providerResponseId || job.providerTaskId || null,
    submissionState: "submitted",
    billingRisk: "",
    resubmitConfirmationRequired: false,
    nextPollAt: "",
    error: "",
    automaticRecoveryStoppedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    providerTerminalAt: job.providerTerminalAt || new Date().toISOString(),
    assetSavedAt: new Date().toISOString(),
    appliedAt: job.target.targetType === "capability-smoke" ? new Date().toISOString() : job.appliedAt || "",
    ...(job.target.targetType === "capability-smoke" ? { evidenceCheckedAt: verifiedAt, evidenceExpiresAt } : {}),
    heartbeatAt: new Date().toISOString(),
    landingReceipt: {
      relativePath: attachment.relativePath,
      sha256: attachment.sha256,
      size: attachment.size,
      mimeType: attachment.mimeType,
      imageWidth: attachment.imageWidth,
      imageHeight: attachment.imageHeight,
      imageFormat: attachment.imageFormat,
      imageValidation: attachment.imageValidation,
      verifiedAt,
    },
    landingReceipts: attachments.map((item) => ({
      relativePath: item.relativePath,
      sha256: item.sha256,
      size: item.size,
      mimeType: item.mimeType,
      imageWidth: item.imageWidth,
      imageHeight: item.imageHeight,
      imageFormat: item.imageFormat,
      imageValidation: item.imageValidation,
      verifiedAt,
    })),
    capabilityEvidence: job.target.targetType === "capability-smoke" ? {
      channel: "image",
      provider: settings.provider || job.request?.settings?.provider || "",
      model: settings.model || job.request?.settings?.model || "",
      driverId: `${settings.adapter || "adapter"}:image`,
      providerTaskId: generated.providerResponseId || job.providerTaskId || null,
      artifactSha256: attachment.sha256,
      artifactMimeType: attachment.mimeType,
      artifactBytes: attachment.size,
      imageWidth: attachment.imageWidth,
      imageHeight: attachment.imageHeight,
      imageFormat: attachment.imageFormat,
      imageValidation: attachment.imageValidation,
      landed: true,
      durableProfileSignature: job.executionProfileSignature || job.profileSignature || "",
      checkedAt: verifiedAt,
      evidenceExpiresAt,
      verifiedAt,
    } : null,
    result: {
      kind: "image",
      attachment,
      attachments,
      requestedImageCount: Math.max(1, Math.min(4, Number(job.request.imageCount) || 1)),
      returnedImageCount: attachments.length,
      revisedPrompt: generated.revisedPrompt || "",
      providerResponseId: generated.providerResponseId || null,
      ...mediaBatchIndex,
    },
  };
  const completed = await completeMediaGenerationJob({ jobId: job.id, patch: completionPatch });
  if (completed.status !== "complete") {
    await completeMediaGenerationJob({
      jobId: job.id,
      patch: completionPatch,
      allowProviderCompletionAfterCancel: true,
    });
  }
};

const downloadProviderResult = async ({ job, settings, driver, workRoot }) => {
  let current = await updateRunnableMediaGenerationJob({
    jobId: job.id,
    patch: { status: "downloading", progressPercent: 90, heartbeatAt: new Date().toISOString() },
  });
  if (current.status !== "downloading" || current.desiredAction === "cancel") {
    const cancellation = await settleProviderCancellation({ job: current, settings, driver, workRoot });
    if (cancellation.outcome !== "completed") return cancellation.job;
    current = cancellation.job;
  }
  const outputPath = join(workRoot, job.channel === "image" ? "provider-result.image" : job.channel === "audio" ? "provider-result.audio" : "provider-result.mp4");
  const forceRedownload = ["video", "audio"].includes(job.channel) && Number(current.downloadRetryCount || 0) > 0;
  const resultExpired = current.resultUrlExpiresAt && Date.parse(current.resultUrlExpiresAt) <= Date.now() + 60_000;
  if (resultExpired) {
    const refreshed = await driver.resume({ job: current, settings, workRoot });
    current = await update(job.id, { ...providerPatch(refreshed), heartbeatAt: new Date().toISOString() });
  }
  let generated;
  try {
    try {
      generated = await driver.download({ job: current, settings, workRoot, outputPath, forceRedownload });
    } catch (error) {
      if (!current.providerTaskId || !/HTTP_(?:401|403|404)|MISSING_RESULT_URL/i.test(String(error.providerErrorCode || error.code || error.message))) throw error;
      const refreshed = await driver.resume({ job: current, settings, workRoot });
      current = await update(job.id, { ...providerPatch(refreshed), heartbeatAt: new Date().toISOString() });
      generated = await driver.download({ job: current, settings, workRoot, outputPath, forceRedownload });
    }
    if (!generated?.path && !generated?.paths?.length && !generated?.stream && !generated?.body && !generated?.bytes && !generated?.base64) {
      throw Object.assign(
        new Error(`厂商任务 ${current.providerTaskId} 已显示完成，但可下载文件尚未就绪`),
        { providerErrorCode: "DREAMINA_RESULT_PENDING" },
      );
    }
  } catch (error) {
    if (!current.providerTaskId || !transientProviderFailure(error)) throw error;
    const failures = Number(current.transientFailures || 0) + 1;
    const dreaminaResultRecovery = dreaminaCliMediaJob(current)
      ? dreaminaResultRecoveryPolicy({
        job: current,
        errorCode: error.providerErrorCode || error.code,
        message: errorMessage(error),
      })
      : { applies: false, expired: false };
    if (dreaminaResultRecovery.applies && dreaminaResultRecovery.expired) {
      return updateRunnableMediaGenerationJob({ jobId: current.id, patch: {
        status: "retry_required",
        providerStatus: "completed",
        providerErrorCode: "DREAMINA_RESULT_PENDING",
        progressPercent: 100,
        failedAt: "",
        nextPollAt: "",
        retryAllowed: true,
        resultRecoveryStartedAt: dreaminaResultRecovery.startedAt,
        resultRecoveryExpiresAt: dreaminaResultRecovery.expiresAt,
        resultRecoveryAttempts: dreaminaResultRecovery.attempts,
        failureCategory: "provider_result_pending",
        failureReason: "即梦已完成生成，但在自动取回时限内始终没有提供可下载文件。",
        failureResolution: "点击“找回结果”再次取回；系统将沿用原厂商任务 ID，不会重新提交或重复扣费。",
        error: `即梦厂商任务 ${current.providerTaskId} 已完成，但自动取回结果已达到安全时限。请点击“找回结果”再次下载；不会重新生成或重复扣费。原始错误：${errorMessage(error)}`,
        heartbeatAt: new Date().toISOString(),
      } });
    }
    const delayMs = failures > MAX_TRANSIENT_FAILURES
      ? Math.max(60_000, Number(error.retryAfterMs) || 0)
      : transientBackoffMs(failures, error.retryAfterMs);
    return updateRunnableMediaGenerationJob({ jobId: current.id, patch: {
      status: "downloading",
      transientFailures: failures > MAX_TRANSIENT_FAILURES ? 0 : failures,
      providerErrorCode: dreaminaResultRecovery.applies
        ? "DREAMINA_RESULT_PENDING"
        : String(error.providerErrorCode || error.code || "DREAMINA_QUERY_TRANSIENT"),
      nextPollAt: new Date(Date.now() + delayMs).toISOString(),
      ...(dreaminaResultRecovery.applies ? {
        resultRecoveryStartedAt: dreaminaResultRecovery.startedAt,
        resultRecoveryExpiresAt: dreaminaResultRecovery.expiresAt,
        resultRecoveryAttempts: dreaminaResultRecovery.attempts,
      } : {}),
      error: `厂商结果已经生成，但下载链路暂时不可用；原任务 ID 已保留，将在约 ${Math.ceil(delayMs / 1000)} 秒后继续抓取：${errorMessage(error)}`,
      heartbeatAt: new Date().toISOString(),
    } });
  }
  const sourcePaths = [...new Set([
    generated.path,
    ...(Array.isArray(generated.paths) ? generated.paths : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const sourcePath = sourcePaths[0] || "";
  const mimeType = generated.mimeType || (job.channel === "image"
    ? sourcePath.endsWith(".jpg") || sourcePath.endsWith(".jpeg") ? "image/jpeg" : sourcePath.endsWith(".webp") ? "image/webp" : "image/png"
    : job.channel === "audio"
      ? sourcePath.endsWith(".wav") ? "audio/wav" : sourcePath.endsWith(".m4a") ? "audio/mp4" : sourcePath.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg"
      : sourcePath.endsWith(".webm") ? "video/webm" : sourcePath.endsWith(".mov") ? "video/quicktime" : "video/mp4");
  if (job.channel === "image" && !mimeType.startsWith("image/")) throw new Error("图片厂商返回了非图片媒体");
  if (job.channel === "video" && !mimeType.startsWith("video/")) throw new Error("视频厂商返回了非视频媒体");
  if (job.channel === "audio" && !mimeType.startsWith("audio/")) throw new Error("音频厂商返回了非音频媒体");
  const extension = mimeType === "video/webm" ? "webm"
    : mimeType === "video/quicktime" ? "mov"
      : mimeType === "video/mp4" ? "mp4"
        : mimeType === "image/jpeg" ? "jpg"
          : mimeType === "image/webp" ? "webp"
            : mimeType === "audio/wav" ? "wav"
              : mimeType === "audio/mp4" ? "m4a"
                : mimeType === "audio/ogg" ? "ogg"
                  : mimeType.startsWith("audio/") ? "mp3" : "png";
  const attachmentName = (index = 0) => job.channel === "image"
    ? imageAttachmentName(job, index, extension)
        : job.channel === "audio" ? `神思音频-${job.id}.${extension}` : `神思视频-${job.id}.${extension}`;
  const attachments = [];
  try {
    if (sourcePaths.length) {
      for (let index = 0; index < sourcePaths.length; index += 1) {
        attachments.push(await saveWorkspaceAttachmentFromPath({
          appRoot,
          requestedPath: job.target.workspacePath,
          sourcePath: sourcePaths[index],
          name: attachmentName(index),
          mimeType,
          expectedDurationMs: current.channel === "video" ? Math.max(0, Number(current.request?.duration) || 0) * 1000 : 0,
          requirePlayableMedia: job.channel === "video",
          requireValidImage: job.channel === "image",
          stableName: true,
          ...workspaceMediaDestination(job),
        }));
      }
    } else {
      attachments.push(await saveWorkspaceAttachmentFromStream({
        appRoot,
        requestedPath: job.target.workspacePath,
        name: attachmentName(),
        mimeType,
        stream: generated.stream,
        expectedBytes: generated.expectedBytes || 0,
        expectedDurationMs: current.channel === "video" ? Math.max(0, Number(current.request?.duration) || 0) * 1000 : 0,
        requirePlayableMedia: job.channel === "video",
        requireValidImage: job.channel === "image",
        stableName: true,
        ...workspaceMediaDestination(job),
      }));
    }
  } catch (error) {
    if (!mediaDownloadIntegrityFailure(current, error) || !current.providerTaskId) throw error;
    const retries = Number(current.downloadRetryCount || 0) + 1;
    await rm(outputPath, { force: true }).catch(() => {});
    if (retries > MAX_MEDIA_DOWNLOAD_INTEGRITY_RETRIES) {
      return updateRunnableMediaGenerationJob({ jobId: current.id, patch: {
        status: "retry_required",
        providerStatus: "completed",
        providerErrorCode: String(error.code || "MEDIA_VALIDATION_FAILED"),
        progressPercent: 90,
        downloadRetryCount: retries,
        transientFailures: 0,
        nextPollAt: "",
        retryAllowed: true,
        billingRisk: current.billingRisk || "provider_task_completed",
        error: `厂商任务已完成，但结果文件连续 ${MAX_MEDIA_DOWNLOAD_INTEGRITY_RETRIES} 次未通过完整性校验；已停止自动下载，不会重新生成或重复扣费。可手动重试下载。${error.detail ? ` ${error.detail}` : ""}`.slice(0, 2000),
        heartbeatAt: new Date().toISOString(),
      } });
    }
    const delayMs = transientBackoffMs(retries);
    return updateRunnableMediaGenerationJob({ jobId: current.id, patch: {
      status: "downloading",
      providerStatus: "completed",
      providerErrorCode: String(error.code || "MEDIA_VALIDATION_FAILED"),
      progressPercent: 90,
      downloadRetryCount: retries,
      transientFailures: retries,
      nextPollAt: new Date(Date.now() + delayMs).toISOString(),
      retryAllowed: true,
      billingRisk: current.billingRisk || "provider_task_completed",
      error: `厂商任务已经生成，但下载文件未通过完整性校验；将强制重新下载原任务结果（${retries}/${MAX_MEDIA_DOWNLOAD_INTEGRITY_RETRIES}），不会重新提交收费任务。${error.detail ? ` ${error.detail}` : ""}`.slice(0, 2000),
      heartbeatAt: new Date().toISOString(),
    } });
  }
  const attachment = attachments[0];
  const mediaBatchIndex = await mediaJobAllowsTargetIndexWrite(job.id)
    ? await updateMediaLandingIndex(job, attachments)
    : {};
  const completedDreaminaProfileId = String(current.request?.settings?.dreaminaCliProfile || "").trim();
  if (["dreamina-image-cli", "dreamina-video-cli"].includes(driver.id)
    && completedDreaminaProfileId
    && Number.isFinite(Number(current.providerCreditCount))
    && Number(current.providerCreditCount) > 0) {
    // Calibrate only after the provider result has been downloaded and verified.
    // Dreamina exposes the task-specific deduction after the provider result
    // is complete. Calibrate here, where driver/current are defined, rather
    // than in the unrelated OpenAI image adapter completion path.
    await recordDreaminaProfileCreditEstimate({
      profileId: completedDreaminaProfileId,
      channel: current.channel,
      request: current.request,
      creditCount: Number(current.providerCreditCount),
      providerTaskId: current.providerTaskId,
    }).catch(() => null);
  }
  const verifiedAt = new Date().toISOString();
  const evidenceExpiresAt = mediaCapabilityEvidenceExpiry(verifiedAt);
  const completionPatch = {
    completedAt: new Date().toISOString(),
    providerTerminalAt: current.providerTerminalAt || new Date().toISOString(),
    assetSavedAt: new Date().toISOString(),
    appliedAt: job.target.targetType === "capability-smoke" ? new Date().toISOString() : job.appliedAt || "",
    ...(job.target.targetType === "capability-smoke" ? { evidenceCheckedAt: verifiedAt, evidenceExpiresAt } : {}),
    heartbeatAt: new Date().toISOString(),
    providerResultUrl: "",
    resultUrlExpiresAt: "",
    landingReceipt: {
      relativePath: attachment.relativePath,
      sha256: attachment.sha256,
      size: attachment.size,
      mimeType: attachment.mimeType,
      durationMs: attachment.durationMs ?? null,
      videoWidth: attachment.videoWidth ?? null,
      videoHeight: attachment.videoHeight ?? null,
      videoCodec: attachment.videoCodec || "",
      videoFrameCount: attachment.videoFrameCount ?? null,
      videoFrameCountDeclared: attachment.videoFrameCountDeclared ?? null,
      videoFrameCountRead: attachment.videoFrameCountRead ?? null,
      audioCodec: attachment.audioCodec || "",
      imageWidth: attachment.imageWidth ?? null,
      imageHeight: attachment.imageHeight ?? null,
      imageFormat: attachment.imageFormat || "",
      imageValidation: attachment.imageValidation || "",
      verifiedAt,
    },
    landingReceipts: attachments.map((item) => ({
      relativePath: item.relativePath,
      sha256: item.sha256,
      size: item.size,
      mimeType: item.mimeType,
      imageWidth: item.imageWidth ?? null,
      imageHeight: item.imageHeight ?? null,
      imageFormat: item.imageFormat || "",
      videoFrameCount: item.videoFrameCount ?? null,
      videoFrameCountDeclared: item.videoFrameCountDeclared ?? null,
      videoFrameCountRead: item.videoFrameCountRead ?? null,
      verifiedAt,
    })),
    capabilityEvidence: job.target.targetType === "capability-smoke" ? {
      channel: job.channel,
      provider: job.request?.settings?.provider || "",
      model: job.request?.settings?.model || "",
      driverId: driver.id,
      providerTaskId: job.providerTaskId,
      artifactSha256: attachment.sha256,
      artifactMimeType: attachment.mimeType,
      artifactBytes: attachment.size,
      durationMs: attachment.durationMs ?? null,
      videoWidth: attachment.videoWidth ?? null,
      videoHeight: attachment.videoHeight ?? null,
      videoCodec: attachment.videoCodec || "",
      videoFrameCount: attachment.videoFrameCount ?? null,
      videoFrameCountDeclared: attachment.videoFrameCountDeclared ?? null,
      videoFrameCountRead: attachment.videoFrameCountRead ?? null,
      audioCodec: attachment.audioCodec || "",
      imageWidth: attachment.imageWidth ?? null,
      imageHeight: attachment.imageHeight ?? null,
      imageFormat: attachment.imageFormat || "",
      imageValidation: attachment.imageValidation || "",
      landed: true,
      durableProfileSignature: job.executionProfileSignature || job.profileSignature || "",
      checkedAt: verifiedAt,
      evidenceExpiresAt,
      verifiedAt,
    } : null,
    downloadRetryCount: 0,
    result: { kind: job.channel, attachment, attachments, providerResponseId: job.providerTaskId, ...mediaBatchIndex },
  };
  let completed = await completeMediaGenerationJob({ jobId: job.id, patch: completionPatch });
  if (completed.status !== "complete") {
    if (completed.resultSuppressed && completionPatch.result?.attachment?.relativePath) {
      completed = await completeMediaGenerationJob({
        jobId: job.id,
        patch: completionPatch,
        allowProviderCompletionAfterCancel: true,
      });
    } else {
      const cancellation = await settleProviderCancellation({ job: completed, settings, driver, workRoot });
      if (cancellation.outcome === "completed") {
        completed = await completeMediaGenerationJob({
          jobId: job.id,
          patch: completionPatch,
          allowProviderCompletionAfterCancel: true,
        });
      } else {
        completed = cancellation.job;
      }
    }
  }
  if (["complete", "cancelled"].includes(completed.status)) await rm(workRoot, { recursive: true, force: true });
  return completed;
};

const processProviderJob = async (job, settings, driver = resolveMediaProviderDriver({ channel: job.channel, settings })) => {
  if (!driver) throw Object.assign(new Error("当前媒体连接暂不支持这种生成方式，请检查连接类型和模型"), { providerErrorCode: "DRIVER_NOT_REGISTERED" });
  const workRoot = join(generationJobsDirectory(), "work", job.id);
  await mkdir(workRoot, { recursive: true });
  const providerName = driver.id === "libtv-cli" ? "LibTV" : "即梦";

  if (job.status === "cancel_requested") {
    if (dreaminaCancellationReconciliationExpired(job)) {
      await update(job.id, {
        status: "retry_required",
        providerStatus: "unknown",
        desiredAction: "cancel",
        progressPercent: 100,
        cancelVerificationExpiredAt: new Date().toISOString(),
        profileSwitchReleasedAt: new Date().toISOString(),
        nextPollAt: "",
        retryAllowed: true,
        error: "厂商取消结果在限定时间内无法核验；神思已停止后台自动轮询并释放即梦配置切换，不会重新提交收费任务。原厂商任务 ID 和取消记录仍保留，可按需重新核对。",
        heartbeatAt: new Date().toISOString(),
      });
      return;
    }
    const cancellation = await settleProviderCancellation({ job, settings, driver, workRoot });
    if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
    return;
  }

  if (!job.providerTaskId
    && submissionOutcomeUnknown(job)
    && ["dreamina-image-cli", "dreamina-video-cli", "libtv-cli"].includes(driver.id)
    && typeof driver.reconcileSubmission === "function") {
    let reconciled;
    try {
      reconciled = await driver.reconcileSubmission({ job, settings, workRoot });
    } catch (error) {
      const delayMs = transientBackoffMs(Number(job.transientFailures || 0) + 1, error.retryAfterMs);
      await update(job.id, {
        status: "retry_required",
        providerStatus: "reconciling",
        providerErrorCode: String(error.providerErrorCode || error.code || `${providerName.toUpperCase()}_QUERY_TRANSIENT`),
        nextPollAt: new Date(Date.now() + delayMs).toISOString(),
        error: `正在从${providerName}任务记录找回已提交结果，当前查询暂时不可用；不会重新提交，将继续自动核对：${errorMessage(error)}`,
        heartbeatAt: new Date().toISOString(),
      });
      return;
    }
    if (!reconciled?.providerTaskId) {
      const delayMs = 20_000;
      await update(job.id, {
        status: "retry_required",
        providerStatus: "reconciling",
        providerErrorCode: String(reconciled?.errorCode || `${providerName.toUpperCase()}_SUBMISSION_NOT_VISIBLE`),
        nextPollAt: new Date(Date.now() + delayMs).toISOString(),
        error: `正在${providerName}任务记录中核对这次提交；尚未发现可认领记录，不会重新提交或重复扣费，稍后将自动继续查找。`,
        heartbeatAt: new Date().toISOString(),
      });
      return;
    }
    const reconciledStatus = assertProviderStatus(reconciled, `${providerName}提交结果找回`);
    const reconciledTerminal = ["failed", "cancelled"].includes(reconciledStatus);
    job = await update(job.id, {
      status: reconciledStatus === "completed" ? "downloading" : reconciledStatus,
      ...providerPatch(reconciled),
      providerTaskId: reconciled.providerTaskId,
      submissionState: "submitted",
      billingRisk: "",
      resubmitConfirmationRequired: false,
      reconciledProviderTaskAt: new Date().toISOString(),
      progressPercent: reconciledTerminal ? 100 : reconciledStatus === "completed" ? 90 : 24,
      nextPollAt: "",
      transientFailures: 0,
      failedAt: reconciledStatus === "failed" ? new Date().toISOString() : "",
      error: reconciledStatus === "failed" ? reconciled.error || `${providerName}任务已经明确失败` : "",
      heartbeatAt: new Date().toISOString(),
    });
    if (reconciledTerminal) return;
  }

  if (!job.providerTaskId) {
    const explicitRetry = Boolean(job.explicitRetryAt);
    const safeAutomaticResubmit = job.capacityRetrySafe === true || job.safeNoTaskRetry === true;
    if (!explicitRetry && !safeAutomaticResubmit && (recoveryScan || Number(job.attempt || 0) > 0 || job.status !== "queued")) {
      await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
        status: "retry_required",
        providerStatus: "unknown",
        progressPercent: 100,
        interruptedAt: new Date().toISOString(),
        error: "任务在厂商任务 ID 原子落盘前中断。已保留原提示词和幂等键，请重试；同一幂等键不得重复扣费。",
        retryAllowed: true,
      } });
      return;
    }
    if (job.channel === "video") {
      const validationRuntime = await probeVideoValidationRuntime({ appRoot });
      if (!validationRuntime.available) {
        throw Object.assign(
          new Error(`本机 FFprobe 完整文件校验器不可用；已在产生费用前阻止视频提交。${validationRuntime.message ? ` ${validationRuntime.message}` : ""}`),
          { providerErrorCode: "VIDEO_VALIDATOR_UNAVAILABLE" },
        );
      }
    }
    const capability = await driver.probeCapabilities({
      settings: { ...settings, channel: job.channel, [`${job.channel}Channel`]: true },
      paid: false,
      // A settings-page connection probe may be cached briefly for responsive
      // UI. The last non-billing gate before a Dreamina submission must not
      // reuse that cache: task-resource sessions can expire independently of
      // the account/credit session.
      forceFresh: dreaminaCliMediaJob(job),
    });
    if (dreaminaCliMediaJob(job) && capability.taskResourceChecked !== true) {
      const capabilityCode = String(capability.taskResourceErrorCode || "DREAMINA_TASK_RESOURCE_UNVERIFIED").toUpperCase();
      const retryableCodes = new Set([
        "DREAMINA_PROFILE_BROKER_BUSY",
        "DREAMINA_CONTROL_PLANE_TRANSIENT",
        "DREAMINA_CREDIT_QUERY_TIMEOUT",
        "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED",
        "DRIVER_TIMEOUT",
      ]);
      throw Object.assign(
        new Error(capability.controlPlaneWarning || "即梦任务资源会话尚未完成核验，已在产生费用前暂停提交"),
        {
          providerErrorCode: capabilityCode,
          submissionOutcomeKnown: true,
          ...(retryableCodes.has(capabilityCode) ? { retryAfterMs: 1_500 } : {}),
        },
      );
    }
    if (capability.available !== true) {
      const code = capability.reason === "missing_credentials" ? "MISSING_CREDENTIALS" : "CAPABILITY_PROBE_FAILED";
      throw Object.assign(new Error(capability.message || "当前媒体驱动、凭证或项目权限未通过能力探测，已阻止计费提交"), { providerErrorCode: code });
    }
    job = await update(job.id, {
      capabilityProbe: {
        driverId: driver.id,
        verificationLevel: capability.verificationLevel || "connection",
        visibilityChecked: capability.visibilityChecked === true,
        models: Array.isArray(capability.models) ? capability.models.slice(0, 200) : [],
        checkedAt: new Date().toISOString(),
      },
      heartbeatAt: new Date().toISOString(),
      explicitRetryAt: "",
    });
    const selectedModel = String(settings.model || job.request.settings?.model || "").trim();
    if (capability.visibilityChecked === true && selectedModel && !capability.models?.includes(selectedModel)) {
      throw Object.assign(new Error(`当前凭证不可见${job.channel === "image" ? "图片" : "视频"}模型 ${selectedModel}，已阻止提交`), {
        providerErrorCode: "MODEL_NOT_AVAILABLE",
        submissionOutcomeKnown: true,
      });
    }
    const attempt = Number(job.attempt || 0) + 1;
    const submitting = await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
      status: "submitting",
      providerStatus: "submitting",
      submissionState: "submitting",
      progressPercent: 12,
      attempt,
      startedAt: job.startedAt || new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    } });
    if (submitting.status !== "submitting" || submitting.desiredAction === "cancel") return;
    job = submitting;
    const references = await loadReferences(job);
    const submitted = await driver.submit({ job, settings, references, workRoot });
    if (!submitted.providerTaskId) throw new Error("媒体厂商提交成功响应缺少任务 ID，已停止轮询以防重复扣费");
    const submittedStatus = assertProviderStatus(submitted, "媒体厂商提交");
    if (submittedStatus === "failed" && providerCapacityLimited(submitted)) {
      const failures = Number(job.transientFailures || 0) + 1;
      const delayMs = capacityBackoffMs(failures, submitted.retryAfterMs);
      await update(job.id, {
        status: "queued",
        ...providerPatch(submitted),
        providerTaskId: null,
        rejectedProviderTaskId: submitted.providerTaskId,
        providerStatus: "queued",
        providerErrorCode: "DREAMINA_CONCURRENCY_LIMIT",
        submissionState: "not_submitted",
        capacityRetrySafe: true,
        transientFailures: failures,
        progressPercent: 8,
        billingRisk: "",
        resubmitConfirmationRequired: false,
        failedAt: "",
        nextPollAt: new Date(Date.now() + delayMs).toISOString(),
        heartbeatAt: new Date().toISOString(),
        error: `即梦并发名额已满，本次未创建收费项目；任务已在本地排队，将在约 ${Math.ceil(delayMs / 1000)} 秒后自动重试。`,
      });
      return;
    }
    const submittedTerminal = ["failed", "cancelled"].includes(submittedStatus);
    job = await update(job.id, {
      status: submittedStatus === "completed" ? "downloading" : submittedStatus,
      ...providerPatch(submitted),
      progressPercent: submittedTerminal ? 100 : submittedStatus === "completed" ? 90 : 24,
      providerTaskId: submitted.providerTaskId,
      submissionState: "submitted",
      billingRisk: "",
      resubmitConfirmationRequired: false,
      capacityRetrySafe: false,
      nextPollAt: "",
      transientFailures: 0,
      safeNoTaskRetry: false,
      submittedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      error: submittedStatus === "failed" ? submitted.error || "媒体厂商拒绝创建任务" : "",
      ...(submittedStatus === "failed" ? { failedAt: new Date().toISOString(), retryAllowed: true } : {}),
      ...(submittedStatus === "cancelled" ? { cancelledAt: new Date().toISOString() } : {}),
    });
    if (submittedStatus === "failed" || submittedStatus === "cancelled") return;
    if (submittedStatus === "completed") {
      await downloadProviderResult({ job, settings, driver, workRoot });
      return;
    }
    if (job.desiredAction === "cancel") {
      const cancellation = await settleProviderCancellation({ job, settings, driver, workRoot });
      if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
      return;
    }
  } else {
    const resumed = await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
      status: job.status === "downloading" || job.status === "waiting_storage" ? job.status : "polling",
      progressPercent: Math.max(Number(job.progressPercent) || 0, 24),
      resumedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      explicitRetryAt: "",
    } });
    if (resumed.status === "cancel_requested" || resumed.desiredAction === "cancel") {
      const cancellation = await settleProviderCancellation({ job: resumed, settings, driver, workRoot });
      if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
      return;
    }
    if (["complete", "cancelled", "superseded"].includes(resumed.status)) return;
    job = resumed;
  }

  if (job.status === "downloading" || job.status === "waiting_storage" || job.providerStatus === "completed") {
    await downloadProviderResult({ job, settings, driver, workRoot });
    return;
  }

  // One durable provider observation per worker invocation. The watchdog will
  // start the next observation after nextPollAt. This keeps tasks pollable for
  // hours or days without tying their lifetime to one Node process or one CLI
  // timeout, and application restarts continue from the same providerTaskId.
  while (true) {
    job = await readGenerationJobForWorker({ jobId: job.id });
    if (job.status === "cancel_requested" || job.desiredAction === "cancel") {
      const cancellation = await settleProviderCancellation({ job, settings, driver, workRoot });
      if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
      return;
    }
    let status;
    try {
      status = await driver.resume({ job, settings, workRoot });
    } catch (error) {
      const failures = Number(job.transientFailures || 0) + 1;
      // An explicit login rejection is a terminal credential state, even when
      // an older bridge wrapped it as DRIVER_EXIT_FAILED. Do not spend twelve
      // transport retries on a session that requires user verification.
      if (explicitDreaminaAccountVerificationFailure(job, error)) throw error;
      if (!transientProviderFailure(error)) throw error;
      if (failures > MAX_TRANSIENT_FAILURES) {
        const cooldownMs = Math.max(60_000, Number(error.retryAfterMs) || 0);
        const deferred = await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
          status: "polling",
          transientFailures: 0,
          nextPollAt: new Date(Date.now() + cooldownMs).toISOString(),
          error: `厂商状态服务持续不可用；原任务 ID 已保留，将在 ${Math.ceil(cooldownMs / 1000)} 秒后自动续查：${errorMessage(error)}`,
          heartbeatAt: new Date().toISOString(),
        } });
        if (deferred.status === "cancel_requested" || deferred.desiredAction === "cancel") {
          const cancellation = await settleProviderCancellation({ job: deferred, settings, driver, workRoot });
          if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
        }
        return;
      }
      const delayMs = transientBackoffMs(failures, error.retryAfterMs);
      const deferred = await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
        status: "polling",
        transientFailures: failures,
        nextPollAt: new Date(Date.now() + delayMs).toISOString(),
        error: `厂商状态查询暂时失败，正在自动重试（${failures}/${MAX_TRANSIENT_FAILURES}）：${errorMessage(error)}`,
        heartbeatAt: new Date().toISOString(),
      } });
      if (deferred.status === "cancel_requested" || deferred.desiredAction === "cancel") {
        const cancellation = await settleProviderCancellation({ job: deferred, settings, driver, workRoot });
        if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
        return;
      }
      if (["complete", "cancelled", "superseded"].includes(deferred.status)) return;
      return;
    }
    assertProviderStatus(status, "媒体厂商状态查询");
    if (status.providerStatus === "failed" && providerCapacityLimited(status)) {
      const failures = Number(job.transientFailures || 0) + 1;
      const delayMs = capacityBackoffMs(failures, status.retryAfterMs);
      await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
        status: "polling",
        ...providerPatch(status),
        providerTaskId: job.providerTaskId,
        providerStatus: "queued",
        providerErrorCode: "DREAMINA_CONCURRENCY_LIMIT",
        transientFailures: failures,
        nextPollAt: new Date(Date.now() + delayMs).toISOString(),
        error: `即梦状态服务返回并发拥堵；已保留原厂商任务 ${job.providerTaskId}，将在约 ${Math.ceil(delayMs / 1000)} 秒后继续查询，不会重复提交。`,
        heartbeatAt: new Date().toISOString(),
      } });
      return;
    }
    const polls = Number(job.pollCount || 0) + 1;
    const providerProgress = providerProgressNumber(providerResultProgress(status));
    const providerStateSignature = JSON.stringify([
      String(status.providerStatus || ""),
      String(status.rawStatus || ""),
      providerQueueNumber(status.providerQueuePosition),
      providerQueueNumber(status.providerQueueLength),
      providerProgress,
    ]);
    const providerStateChanged = providerStateSignature !== String(job.providerStateSignature || "");
    const dreaminaSessionFailure = dreaminaCliMediaJob(job) && [
      "DREAMINA_AUTH_REQUIRED",
      "DREAMINA_PROVIDER_SESSION_EXPIRED",
      "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
    ].includes(String(status.errorCode || "").toUpperCase());
    const polled = await updateRunnableMediaGenerationJob({ jobId: job.id, patch: {
      status: "polling",
      ...providerPatch(status),
      ...(providerTerminalStatus(status.providerStatus) ? {
        providerTerminalAt: job.providerTerminalAt || new Date().toISOString(),
      } : {}),
      pollCount: polls,
      transientFailures: 0,
      ...(dreaminaSessionFailure ? {} : {
        dreaminaSessionRecoveryStartedAt: "",
        dreaminaSessionRecoveryAttempts: 0,
        dreaminaSessionRecoveryDeadlineAt: "",
      }),
      providerStateSignature,
      providerStateChangedAt: providerStateChanged || !job.providerStateChangedAt
        ? new Date().toISOString()
        : job.providerStateChangedAt,
      nextPollAt: providerTerminalStatus(status.providerStatus)
        ? ""
        : new Date(Date.now() + durableProviderPollDelayMs(job, status.providerStatus)).toISOString(),
      error: "",
      // Keep stage progress stable unless the provider returned a real
      // percentage. Poll count and elapsed time are not evidence of progress.
      progressPercent: providerProgress === null ? 24 : Math.min(89, Math.max(24, providerProgress)),
      heartbeatAt: new Date().toISOString(),
    } });
    if (polled.status === "cancel_requested" || polled.desiredAction === "cancel") {
      const cancellation = await settleProviderCancellation({ job: polled, settings, driver, workRoot });
      if (cancellation.outcome === "completed") await downloadProviderResult({ job: cancellation.job, settings, driver, workRoot });
      return;
    }
    if (["complete", "cancelled", "superseded"].includes(polled.status)) return;
    job = polled;
    if (status.providerStatus === "failed") throw Object.assign(new Error(status.error || "媒体厂商任务失败"), { providerErrorCode: status.errorCode || "PROVIDER_FAILED" });
    if (status.providerStatus === "cancelled") {
      await confirmMediaGenerationCancelled({ jobId: job.id, patch: { cancelledAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() } });
      return;
    }
    if (status.providerStatus === "completed") {
      await downloadProviderResult({ job, settings, driver, workRoot });
      return;
    }
    return;
  }
};

const processJob = async (candidate) => {
  if (recoveryScan && freshUnsubmittedJob(candidate)) return false;
  const nextPollAt = Date.parse(candidate.nextPollAt || "");
  if (Number.isFinite(nextPollAt) && nextPollAt > Date.now()) return false;
  const release = await acquireJobLock(candidate.id);
  if (!release) return false;
  let heartbeat = null;
  try {
    let job = await readGenerationJobForWorker({ jobId: candidate.id });
    if (job.status === "waiting_credentials" && String(job.providerErrorCode || "") === "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED") {
      const uncertain = submissionOutcomeUnknown(job);
      job = await update(job.id, {
        status: job.providerTaskId ? "polling" : uncertain ? "retry_required" : "queued",
        ...(job.providerTaskId || uncertain ? {} : { safeNoTaskRetry: true, submissionState: "not_submitted" }),
        nextPollAt: "",
        error: job.providerTaskId
          ? "即梦登录刷新网络已恢复，将继续查询原厂商任务，不会重复提交。"
          : uncertain
            ? "即梦登录刷新曾中断，正在按幂等键核对厂商任务记录；确认前不会重新提交。"
            : "即梦登录刷新网络已恢复，将重新执行提交前探测。",
        heartbeatAt: new Date().toISOString(),
      });
    }
    if (job.status === "retry_required" && dreaminaCliMediaJob(job) && submissionOutcomeUnknown(job)) {
      const lease = dreaminaSubmissionReconciliationLease(job, { leaseMs: DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS });
      if (lease.expired) {
        const stoppedAt = new Date().toISOString();
        await update(job.id, {
          status: "retry_required",
          providerStatus: "unknown",
          providerErrorCode: "DREAMINA_SUBMISSION_RECONCILIATION_LEASE_EXPIRED",
          submissionState: "unknown",
          progressPercent: 100,
          billingRisk: "submission_outcome_unknown",
          resubmitConfirmationRequired: true,
          automaticRecoveryStoppedAt: stoppedAt,
          nextPollAt: "",
          retryAllowed: true,
          error: "即梦提交结果已自动核对 30 分钟，仍未找到可认领记录；后台找回已停止并释放凭证槽，没有重新提交或重复扣费。可点击“自动找回”再启动一轮核对。",
          heartbeatAt: stoppedAt,
        });
        return false;
      }
    }
    const automaticSubmissionReconciliation = job.status === "retry_required"
      && automaticSubmissionRecoveryJob(job);
    if (["complete", "failed", "retry_required", "cancelled", "superseded"].includes(job.status) && !automaticSubmissionReconciliation) return false;
    heartbeat = setInterval(() => update(job.id, { heartbeatAt: new Date().toISOString() }).catch(() => {}), 2_000);
    heartbeat.unref?.();
    const settings = await resolvedSettings(job);
    // The Windows profile runner owns the one real credential mutex and wraps
    // exactly one official CLI command. Do not add a task-lifecycle lock here:
    // one worker pass may query, refresh a result URL and download, while each
    // command must be free to release the slot independently in its finally.
    const verifiedExecutionProfileSignature = executionProfileSignature(job, settings);
    if (verifiedExecutionProfileSignature) {
      job = await update(job.id, {
        executionProfileSignature: verifiedExecutionProfileSignature,
        heartbeatAt: new Date().toISOString(),
      });
    }
    if (job.channel === "image") {
      const providerDriver = resolveMediaProviderDriver({ channel: "image", settings });
      if (providerDriver) {
        await processProviderJob(job, settings, providerDriver);
      } else if (recoveryScan && !job.providerTaskId && !openAiImageCliJob(job) && !builtInAggregateImageRecoveryJob(job)) {
        await updateRunnableMediaGenerationJob({ jobId: job.id, patch: { status: "retry_required", progressPercent: 100, error: "图片任务在结果落盘前中断，请使用保留的提示词重试。", retryAllowed: true } });
      } else {
        await processImageJob(job, settings);
      }
    } else {
      await processProviderJob(job, settings);
    }
    return true;
  } catch (error) {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const current = await readGenerationJobForWorker({ jobId: candidate.id }).catch(() => candidate);
    if (["complete", "cancelled", "superseded"].includes(current.status)) return false;
    const providerCode = String(error.providerErrorCode || error.code || "");
    const surfacedProviderCode = providerCode || (dreaminaCliMediaJob(current)
      ? "DREAMINA_UNCLASSIFIED_FAILURE"
      : "MEDIA_PROVIDER_FAILURE");
    const errorProviderTaskId = String(error?.providerTaskId || error?.provider_task_id || "").trim();
    const usableErrorProviderTaskId = errorProviderTaskId
      && !/^(?:0|-|none|null|undefined|unknown|missing|n\/?a|na)$/iu.test(errorProviderTaskId);
    if (dreaminaCliMediaJob(current)
      && current.channel === "video"
      && current.status === "submitting"
      && current.submissionState === "submitting"
      && !current.providerTaskId
      && usableErrorProviderTaskId) {
      const taskAuthFailure = /authsdk|未检测到(?:有效)?登录态|dreamina\s+login/i.test(errorMessage(error))
        || providerCode.toUpperCase() === "DREAMINA_AUTH_REQUIRED";
      await updateActiveMediaGenerationJob({
        jobId: candidate.id,
        expectedDesiredAction: current.desiredAction || "run",
        expectedStatuses: [current.status],
        patch: {
          status: "polling",
          providerTaskId: errorProviderTaskId,
          providerStatus: "running",
          providerRawStatus: "submission_response_with_error",
          providerErrorCode: taskAuthFailure
            ? "DREAMINA_PROVIDER_TASK_AUTH_FAILURE"
            : providerCode || "DREAMINA_SUBMISSION_RESPONSE_WITH_ERROR",
          submissionState: "submitted",
          billingRisk: "",
          resubmitConfirmationRequired: false,
          safeNoTaskRetry: false,
          nextPollAt: new Date().toISOString(),
          retryAllowed: true,
          error: taskAuthFailure
            ? `即梦已返回原厂商任务 ${errorProviderTaskId}，但同时报告生成阶段会话异常；已保留任务号并改为只读续查，不会重新提交。`
            : `即梦已返回原厂商任务 ${errorProviderTaskId}，但提交响应同时包含错误；已保留任务号并改为只读续查，不会重新提交。${providerCode ? ` 原始错误码：${providerCode}` : ""}`,
          heartbeatAt: new Date().toISOString(),
        },
      });
      return false;
    }
    const explicitDreaminaAccountVerification = explicitDreaminaAccountVerificationFailure(current, error);
    const providerControlPlaneTransient = transientProviderFailure(error)
      && Boolean(current.providerTaskId)
      && !explicitDreaminaAccountVerification;
    const capabilityFailure = classifyCustomApiCapabilityFailure({
      code: providerCode,
      statusCode: Number(error.statusCode) || 0,
      message: errorMessage(error),
    });
    const dreaminaFailure = dreaminaCliMediaJob(current) ? dreaminaFailureDiagnosis({
      code: providerCode,
      message: errorMessage(error),
      providerTaskId: current.providerTaskId,
      submissionState: current.submissionState,
    }) : null;
    const dreaminaFailurePatch = dreaminaFailure ? {
      failureCategory: dreaminaFailure.category,
      failureReason: dreaminaFailure.cause,
      failureResolution: dreaminaFailure.resolution,
    } : {};
    const dreaminaTaskSessionRecovery = dreaminaCliMediaJob(current)
      ? dreaminaTaskSessionRecoveryPolicy({
        job: current,
        // A semantic auth failure is not a transport hiccup. Stop the old
        // restore loop immediately so the UI can verify the exact profile and
        // then resume only the preserved provider task.
        code: explicitDreaminaAccountVerification ? "" : providerCode,
      })
      : { applies: false, expired: false };
    const missingCredentials = providerCode === "MISSING_CREDENTIALS"
      || (dreaminaCliMediaJob(current) && dreaminaFailureRequiresAccountVerification({
        code: providerCode,
        message: errorMessage(error),
        providerTaskId: current.providerTaskId,
        submissionState: current.submissionState,
      }))
      || providerCode === "LOCAL_RUNTIME_BINDING_REQUIRED"
      || providerCode === "MEDIA_JOB_CANONICAL_PROFILE_MISMATCH"
      || capabilityFailure.invalidatesCredential;
    const storageBlocked = ["MEDIA_QUOTA_EXCEEDED", "MEDIA_DISK_FULL", "ENOSPC"].includes(error.code);
    const failureText = errorMessage(error);
    const localImageRecoveryMissing = openAiImageCliJob(current) && /OPENAI_IMAGE_RECOVERY_MISSING/.test(failureText);
    const localLandingBlocked = Boolean(current.providerTaskId)
      && String(current.providerStatus || "").toLowerCase() === "completed"
      && (/WORKSPACE_STATE_CONFLICT|WORKSPACE_BUSY|\b(?:EBUSY|EPERM)\b/i.test(`${providerCode} ${failureText}`)
        || /正在被另一个神思任务写入|另一个窗口或任务中更新/.test(failureText));
    const { submissionUnknown, safeAutomaticRetry, retryDelayMs, failureCount, upstreamStreamOpenTimeout } = classifyMediaSubmissionFailure({ job: current, error });
    const dreaminaSubmissionRecoveryPending = dreaminaCliMediaJob(current) && submissionUnknown;
    const dreaminaProfileBrokerBusy = providerCode === "DREAMINA_PROFILE_BROKER_BUSY";
    const localImageRecoveryPending = openAiImageCliJob(current)
      && (submissionUnknown || /OPENAI_IMAGE_RECOVERY_PENDING/.test(failureText));
    const localImageRecoveryPolicy = localImageRecoveryPending
      ? openAiImageRecoveryPolicy(current, {
        pollMs: OPENAI_IMAGE_RECOVERY_POLL_MS,
        windowMs: OPENAI_IMAGE_RECOVERY_WINDOW_MS,
      })
      : null;
    const aggregateImageRecoveryPending = builtInAggregateImageRecoveryJob(current) && submissionUnknown;
    const aggregateRecoveryPolicy = aggregateImageRecoveryPending
      ? aggregateImageRecoveryPolicy(current, {
        pollMs: AGGREGATE_IMAGE_RECOVERY_POLL_MS,
        windowMs: AGGREGATE_IMAGE_RECOVERY_WINDOW_MS,
        maxAttempts: AGGREGATE_IMAGE_RECOVERY_ATTEMPTS,
      })
      : null;
    const cancelPending = current.desiredAction === "cancel";
    const failurePatch = cancelPending ? {
      providerErrorCode: surfacedProviderCode,
      ...dreaminaFailurePatch,
      error: missingCredentials
        ? "取消意图和原厂商任务 ID 已保留；恢复同一连接凭证后将自动继续核对取消结果。"
        : `取消确认暂时失败，将保留取消状态继续核对：${errorMessage(error)}`,
      nextPollAt: new Date(Date.now() + (missingCredentials ? 60_000 : transientBackoffMs(1, error.retryAfterMs))).toISOString(),
      retryAllowed: true,
      heartbeatAt: new Date().toISOString(),
    } : dreaminaSubmissionRecoveryPending ? {
      status: "retry_required",
      providerStatus: "reconciling",
      providerErrorCode: "DREAMINA_SUBMISSION_UNCERTAIN",
      submissionState: "uncertain",
      progressPercent: Math.max(24, Number(current.progressPercent) || 0),
      failedAt: "",
      billingRisk: "submission_outcome_unknown",
      resubmitConfirmationRequired: false,
      retryAllowed: true,
      nextPollAt: new Date(Date.now() + 2_000).toISOString(),
      automaticRecoveryStartedAt: current.automaticRecoveryStartedAt || new Date().toISOString(),
      automaticRecoveryStoppedAt: "",
      error: "即梦提交响应中断，正在按当前任务保存的原始配置和幂等键核对厂商任务；不会重新提交或重复扣费。",
      heartbeatAt: new Date().toISOString(),
    } : providerControlPlaneTransient ? {
      status: "polling",
      providerStatus: ["queued", "running"].includes(String(current.providerStatus || "")) ? current.providerStatus : "queued",
      providerErrorCode: providerCode || "DREAMINA_QUERY_TRANSIENT",
      progressPercent: Math.max(24, Number(current.progressPercent) || 0),
      transientFailures: failureCount,
      failedAt: "",
      retryAllowed: true,
      nextPollAt: new Date(Date.now() + Math.max(durableProviderPollDelayMs(current), transientBackoffMs(failureCount, error.retryAfterMs))).toISOString(),
        error: `暂时无法取得厂商最新进度；原任务已保留，神思会继续查询，只有厂商明确返回失败才会结束：${failureText}`,
      heartbeatAt: new Date().toISOString(),
    } : aggregateImageRecoveryPending && aggregateRecoveryPolicy.expired ? {
      status: "retry_required",
      providerStatus: "unknown",
      providerErrorCode: "AGGREGATE_IMAGE_RECOVERY_EXPIRED",
      submissionState: "uncertain",
      progressPercent: 100,
      failedAt: "",
      billingRisk: "submission_outcome_unknown",
      resubmitConfirmationRequired: true,
      retryAllowed: true,
      nextPollAt: "",
      automaticRecoveryStartedAt: aggregateRecoveryPolicy.recoveryStartedAt,
      automaticRecoveryStoppedAt: new Date().toISOString(),
      recoveryDeadlineAt: aggregateRecoveryPolicy.recoveryDeadlineAt,
      recoveryLastCheckedAt: aggregateRecoveryPolicy.recoveryLastCheckedAt,
      error: `聚合 API 原任务已使用同一幂等键自动续接 ${aggregateRecoveryPolicy.attempts} 次，仍未取得可验证结果；自动续接已停止。生成提示词、引用和任务记录均已保留，可手动确认后继续找回。`,
      heartbeatAt: new Date().toISOString(),
    } : aggregateImageRecoveryPending ? {
      status: "retry_required",
      providerStatus: "reconciling",
      providerErrorCode: "AGGREGATE_IMAGE_RECOVERY_PENDING",
      submissionState: "uncertain",
      progressPercent: Math.max(24, Number(current.progressPercent) || 0),
      failedAt: "",
      billingRisk: "submission_outcome_unknown",
      resubmitConfirmationRequired: false,
      retryAllowed: true,
      nextPollAt: aggregateRecoveryPolicy.nextPollAt,
      automaticRecoveryStartedAt: aggregateRecoveryPolicy.recoveryStartedAt,
      automaticRecoveryStoppedAt: "",
      recoveryDeadlineAt: aggregateRecoveryPolicy.recoveryDeadlineAt,
      recoveryLastCheckedAt: aggregateRecoveryPolicy.recoveryLastCheckedAt,
      error: upstreamStreamOpenTimeout
        ? `聚合 API 上游流打开超时，正在沿用同一神思任务与幂等键自动续接原结果（${aggregateRecoveryPolicy.attempts}/${aggregateRecoveryPolicy.maxAttempts}）；不会创建第二张卡片任务或重复扣费。`
        : `聚合 API 返回连接中断，正在沿用同一神思任务与幂等键自动续接原结果（${aggregateRecoveryPolicy.attempts}/${aggregateRecoveryPolicy.maxAttempts}）；不会创建第二张卡片任务。`,
      heartbeatAt: new Date().toISOString(),
    } : localImageRecoveryPending && localImageRecoveryPolicy.expired ? {
      status: "failed",
      providerStatus: "failed",
      providerErrorCode: "OPENAI_IMAGE_RECOVERY_EXPIRED",
      submissionState: "recovery_unavailable",
      progressPercent: 100,
      failedAt: new Date().toISOString(),
      billingRisk: "submission_outcome_unknown",
      resubmitConfirmationRequired: true,
      retryAllowed: true,
      nextPollAt: "",
      recoveryStartedAt: localImageRecoveryPolicy.recoveryStartedAt,
      recoveryDeadlineAt: localImageRecoveryPolicy.recoveryDeadlineAt,
      recoveryLastCheckedAt: localImageRecoveryPolicy.recoveryLastCheckedAt,
      error: "已在五分钟快速核对窗口内持续查找原生成会话和本地结果，但仍未找到可校验文件；任务已停止找回并标记为生成失败，系统没有自动重新提交付费任务。",
      heartbeatAt: new Date().toISOString(),
    } : localImageRecoveryPending ? {
      status: "retry_required",
      providerStatus: "reconciling",
      providerErrorCode: "OPENAI_IMAGE_RECOVERY_PENDING",
      progressPercent: Math.max(24, Number(current.progressPercent) || 0),
      failedAt: "",
      billingRisk: "submission_outcome_unknown",
      resubmitConfirmationRequired: false,
      retryAllowed: true,
      nextPollAt: localImageRecoveryPolicy.nextPollAt,
      recoveryStartedAt: localImageRecoveryPolicy.recoveryStartedAt,
      recoveryDeadlineAt: localImageRecoveryPolicy.recoveryDeadlineAt,
      recoveryLastCheckedAt: localImageRecoveryPolicy.recoveryLastCheckedAt,
      error: "图片已进入自动结果核对；神思会每约 2.5 秒认领一次原生图会话，发现文件后自动校验、落盘并回填卡片，最多持续五分钟，不会重新提交付费任务。",
      heartbeatAt: new Date().toISOString(),
    } : localImageRecoveryMissing ? {
      status: "failed",
      providerStatus: "failed",
      providerErrorCode: "OPENAI_IMAGE_RECOVERY_MISSING",
      submissionState: "recovery_unavailable",
      progressPercent: 100,
      failedAt: new Date().toISOString(),
      billingRisk: "",
      resubmitConfirmationRequired: false,
      retryAllowed: true,
      nextPollAt: "",
      error: "旧任务没有留下可安全认领的本地生图会话，系统未自动重投；可重新生成，之后的任务会自动恢复成功结果。",
      heartbeatAt: new Date().toISOString(),
    } : localLandingBlocked ? {
      status: "downloading",
      providerStatus: "completed",
      providerErrorCode: String(error.providerErrorCode || error.code || "WORKSPACE_STATE_CONFLICT"),
      progressPercent: Math.max(90, Number(current.progressPercent) || 0),
      transientFailures: failureCount,
      failedAt: "",
      retryAllowed: true,
      nextPollAt: new Date(Date.now() + transientBackoffMs(failureCount, error.retryAfterMs)).toISOString(),
      error: "厂商结果已经成功生成；本地工作区正在写入，神思会继续使用原任务结果自动落盘，不会重新提交。",
      heartbeatAt: new Date().toISOString(),
    } : dreaminaTaskSessionRecovery.applies && !dreaminaTaskSessionRecovery.expired ? {
      // A provider task ID proves that a paid request already exists. Keep the
      // task pollable while the profile runner restores its saved OAuth
      // session; never turn this short-lived failure into a second OAuth prompt
      // or a second provider submission.
      status: "polling",
      providerStatus: current.providerStatus || "running",
      providerErrorCode: "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
      ...dreaminaFailurePatch,
      progressPercent: Math.max(24, Number(current.progressPercent) || 0),
      failedAt: "",
      retryAllowed: true,
      nextPollAt: new Date(Date.now() + dreaminaTaskSessionRecovery.delayMs).toISOString(),
      dreaminaSessionRecoveryStartedAt: dreaminaTaskSessionRecovery.startedAt,
      dreaminaSessionRecoveryAttempts: dreaminaTaskSessionRecovery.attempts,
      dreaminaSessionRecoveryDeadlineAt: dreaminaTaskSessionRecovery.deadlineAt,
      error: `即梦原任务 ${current.providerTaskId} 的临时会话正在恢复（第 ${dreaminaTaskSessionRecovery.attempts} 次）；将使用原配置自动续查，不会重新核验、重新提交或切换账号。`,
      heartbeatAt: new Date().toISOString(),
    } : safeAutomaticRetry ? {
      status: "queued",
      providerStatus: "queued",
      providerErrorCode: providerCode,
      submissionState: "not_submitted",
      progressPercent: 8,
      transientFailures: failureCount,
      nextPollAt: new Date(Date.now() + retryDelayMs).toISOString(),
      failedAt: "",
      billingRisk: "",
      resubmitConfirmationRequired: false,
      safeNoTaskRetry: true,
      retryAllowed: true,
      error: dreaminaProfileBrokerBusy
        ? `另一个即梦任务正在与厂商通信；本任务尚未提交、不会扣积分，将在约 ${Math.ceil(retryDelayMs / 1000)} 秒后自动继续。`
        : `媒体服务已明确本次没有创建计费任务；将在约 ${Math.ceil(retryDelayMs / 1000)} 秒后自动重试（${failureCount}/3）：${errorMessage(error)}`,
      heartbeatAt: new Date().toISOString(),
    } : {
      status: missingCredentials
        ? "waiting_credentials"
        : storageBlocked && current.providerTaskId
          ? "waiting_storage"
          : submissionUnknown ? "retry_required" : "failed",
      providerStatus: providerCode.toUpperCase() === "DREAMINA_PROVIDER_TASK_AUTH_FAILURE"
        ? "failed"
        : current.providerStatus || "failed",
      providerErrorCode: surfacedProviderCode,
      ...dreaminaFailurePatch,
      progressPercent: storageBlocked ? 92 : missingCredentials ? Math.max(24, Number(current.progressPercent) || 0) : 100,
      failedAt: missingCredentials || storageBlocked || submissionUnknown ? "" : new Date().toISOString(),
      nextPollAt: missingCredentials ? "" : current.nextPollAt || "",
      error: explicitDreaminaAccountVerification && current.providerTaskId
        ? `即梦明确返回当前配置未登录。原厂商任务 ${current.providerTaskId} 和原账号配置均已保留；请核验该配置，核验成功后只续查原任务，不会重新提交或重复扣费。`
        : dreaminaTaskSessionRecovery.applies && dreaminaTaskSessionRecovery.expired
        ? `即梦原任务 ${current.providerTaskId} 已使用原配置自动恢复会话至安全时限，仍收到明确未登录响应。请仅核验该任务原来使用的即梦配置；任务号已保留，不会重新提交或扣费。`
        : submissionUnknown
          ? "提交期间连接中断，未取得厂商任务 ID。为防重复计费，已禁止自动重投；请先在厂商后台核查任务。原始幂等键已保留。"
          : errorMessage(error),
      billingRisk: submissionUnknown ? "submission_outcome_unknown" : current.billingRisk || "",
      ...(submissionUnknown ? {
        automaticRecoveryStartedAt: current.automaticRecoveryStartedAt || new Date().toISOString(),
        automaticRecoveryStoppedAt: "",
      } : {}),
      resubmitConfirmationRequired: submissionUnknown,
      ...(dreaminaTaskSessionRecovery.applies ? {
        dreaminaSessionRecoveryStartedAt: dreaminaTaskSessionRecovery.startedAt,
        dreaminaSessionRecoveryAttempts: dreaminaTaskSessionRecovery.attempts,
        dreaminaSessionRecoveryDeadlineAt: dreaminaTaskSessionRecovery.deadlineAt,
      } : {}),
      retryAllowed: true,
      heartbeatAt: new Date().toISOString(),
    };
    await updateActiveMediaGenerationJob({
      jobId: candidate.id,
      expectedDesiredAction: current.desiredAction || "run",
      expectedStatuses: [current.status],
      patch: failurePatch,
    });
    return false;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await release();
  }
};

const main = async () => {
  await initializeConfiguredDataRoot();
  const updateBarrier = createUpdateWriteBarrier({ coordinationRoot: appDataRoot() });
  const releaseMutation = updateBarrier.beginMutation();
  try {
    if (targetJobId) {
      await processJob(await readGenerationJobForWorker({ jobId: targetJobId }));
      return;
    }
    const jobs = await listMediaGenerationJobsForWorker();
    const dreaminaJobs = jobs.filter((job) => String(job.request?.settings?.provider || "") === "即梦"
      && String(job.request?.settings?.adapter || "") === "cli");
    const otherJobs = jobs.filter((job) => !dreaminaJobs.includes(job));
    // The official Dreamina CLI has a single Windows credential slot. Process
    // those jobs in stable order while leaving unrelated providers concurrent.
    const priority = (job) => {
      if (job.status === "cancel_requested" || job.desiredAction === "cancel") return 0;
      if (job.providerTaskId) return 1;
      if (job.status === "queued" && job.submissionState === "not_submitted") return 2;
      if (automaticSubmissionRecoveryJob(job)) return 4;
      return 3;
    };
    dreaminaJobs.sort((left, right) => priority(left) - priority(right)
      || Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
    for (const job of dreaminaJobs) await processJob(job);
    await Promise.allSettled(otherJobs.map((job) => processJob(job)));
  } finally {
    releaseMutation();
  }
};

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
