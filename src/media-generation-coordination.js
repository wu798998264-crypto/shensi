import { appendGenerationAsset } from "./whiteboard.js";
import { mediaGenerationHasTerminalProviderFailure } from "./media-execution-policy.js";

const defaultWorkspaceConflict = (error) => Number(error?.status) === 409
  || error?.code === "WORKSPACE_STATE_CONFLICT";

export const mediaGenerationPollDelayMs = ({
  transientFailures = 0,
  activePolls = 1,
  pageHidden = false,
} = {}) => {
  const failures = Math.max(0, Number(transientFailures) || 0);
  const polls = Math.max(1, Number(activePolls) || 1);
  const loadAwareDelay = 700 * Math.max(1, Math.ceil(polls / 8));
  const failureDelay = failures
    ? Math.min(60_000, 700 * (2 ** Math.min(7, failures - 1)))
    : 0;
  const visibilityDelay = pageHidden ? 15_000 : 0;
  return Math.min(60_000, Math.max(loadAwareDelay, failureDelay, visibilityDelay));
};

export const mediaGenerationPollErrorIsTerminal = (error, transientFailures = 0) => {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500 && ![408, 429].includes(status)) return true;
  if (error?.code === "INVALID_GENERATION_JOB_PAYLOAD" && Number(transientFailures) >= 3) return true;
  return error?.code === "GENERATION_JOB_ID_MISMATCH";
};

export const mediaSubmissionOutcomeIsUncertain = (error = {}) => {
  const code = String(error?.code || "").toUpperCase();
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || "");
  if (["GENERATION_JOB_RESPONSE_INVALID", "INVALID_GENERATION_JOB_PAYLOAD"].includes(code)) return true;
  if (error instanceof TypeError || error instanceof SyntaxError || name === "aborterror") return true;
  if (/fetch|network|socket|connection|连接(?:中断|失败|重置)|网络(?:中断|错误|异常)|响应无法解析/i.test(message)) return true;
  const status = Number(error?.status);
  return error?.responseReceived !== true && [408, 425, 429, 502, 503, 504].includes(status);
};

export const recoverUnknownMediaSubmission = async (submit, {
  onUncertain = null,
  onRecovered = null,
  wait = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
  maxAttempts = Infinity,
  baseDelayMs = 650,
  maximumDelayMs = 15_000,
} = {}) => {
  let uncertainFailures = 0;
  while (true) {
    try {
      const result = await submit();
      if (uncertainFailures) onRecovered?.({ result, uncertainFailures });
      return result;
    } catch (error) {
      if (!mediaSubmissionOutcomeIsUncertain(error)) throw error;
      uncertainFailures += 1;
      error.submissionOutcomeUnknown = true;
      onUncertain?.({ error, uncertainFailures });
      if (uncertainFailures >= maxAttempts) throw error;
      const delayMs = Math.min(
        Math.max(0, Number(maximumDelayMs) || 0),
        Math.max(0, Number(baseDelayMs) || 0) * (2 ** Math.min(5, uncertainFailures - 1)),
      );
      await wait(delayMs);
    }
  }
};

const WHITEBOARD_MEDIA_ACTIVE_STATUSES = new Set(["queued", "submitting", "running", "polling", "downloading", "cancel_requested"]);
const MEDIA_RECOVERY_BLOCKING_STATUSES = new Set([
  "waiting_credentials",
  "waiting_storage",
  "retry_required",
  "reconciliation_required",
]);

export const mediaGenerationResultSuppressed = (job = {}) => {
  const current = job && typeof job === "object" ? job : {};
  return Boolean(
    current.userStoppedAt
    || current.resultSuppressed
    || current.userStopped
  );
};

export const mediaGenerationFailureNeedsCard = (job = {}) => (
  String(job?.status || "") === "failed"
  && (!mediaGenerationResultSuppressed(job) || mediaGenerationHasTerminalProviderFailure(job))
  && !job?.supersededBy
);

export const mediaGenerationActionPresentation = ({ status = "", availableActions = {} } = {}) => {
  const normalizedStatus = String(status || "");
  const actions = availableActions && typeof availableActions === "object" ? availableActions : {};
  if (actions.autoReconcileProviderTask) {
    return { action: "reconcile", label: "自动找回", confirmNewSubmission: false, recovery: true };
  }
  if (actions.resumeOriginal) {
    return { action: "resume", label: "找回结果", confirmNewSubmission: false, recovery: true };
  }
  if (actions.safeResubmit) {
    return { action: "resume", label: "重新生成", confirmNewSubmission: false, recovery: false };
  }
  if (actions.confirmedResubmit || actions.replaceLegacy) {
    const failed = normalizedStatus === "failed";
    return {
      action: "resume",
      label: failed ? "重新生成" : "找回结果",
      confirmNewSubmission: true,
      recovery: !failed,
    };
  }
  return null;
};

export const whiteboardMediaJobHoldsCard = (job = {}) => {
  if (mediaGenerationResultSuppressed(job)) return false;
  const status = String(job?.status || "");
  if (WHITEBOARD_MEDIA_ACTIVE_STATUSES.has(status)) return true;
  if (["failed", "cancelled", "complete", "superseded"].includes(status)) return false;
  if (status === "waiting_storage" || status === "reconciliation_required") return true;
  if (["waiting_credentials", "retry_required"].includes(status)) {
    return Boolean(job?.providerTaskId || job?.billingRisk || job?.resubmitConfirmationRequired);
  }
  return false;
};

export const mediaRecoveryJobBlocksOperation = (job = {}) => {
  if (!job || job.appliedAt || job.supersededBy || mediaGenerationResultSuppressed(job)) return false;
  const status = String(job.status || "");
  if (["failed", "cancelled", "complete", "superseded"].includes(status)) return false;
  if (job.mode !== "server" || !["image", "video"].includes(String(job.channel || ""))) return false;
  if (job.target?.targetType === "capability-smoke") return false;
  if (job.forceReleasePendingAt && !job.forceReleaseCompletedAt) return true;
  // A healthy provider task can legitimately queue or generate for many
  // minutes. It still owns the Dreamina profile-switch gate, but it is not a
  // recovery problem and must stay on its originating card instead of being
  // presented as a global "pending action". Cross-profile attempts use the
  // dedicated Dreamina lock-occupant dialog.
  if (["queued", "submitting", "running", "polling", "downloading", "cancel_requested"].includes(status)) return false;
  if (!MEDIA_RECOVERY_BLOCKING_STATUSES.has(status)) return false;
  // A bounded automatic reconciliation is still normal execution. Only show
  // the task after automation stops and a user decision is genuinely needed.
  if (status === "retry_required"
    && (job.automaticRecoveryInProgress === true || String(job.providerStatus || "") === "reconciling")
    && String(job.nextPollAt || "").trim()) return false;
  if (whiteboardMediaJobHoldsCard(job) || ["waiting_credentials", "waiting_storage", "retry_required", "reconciliation_required"].includes(status)) return true;
  return job.availableActions?.dismissUncertain === true;
};

// "Pending action" is reserved for an abnormal task that is actually blocking
// subsequent work. Terminal failures remain visible on their originating card
// and in durable history, but neither hold the Dreamina lock nor pollute the
// global recovery queue.
export const mediaRecoveryJobNeedsAttention = (job = {}) => mediaRecoveryJobBlocksOperation(job);

export const whiteboardMediaJobIsSupersededByNodeGeneration = (job = {}, node = {}) => {
  const failedJobId = String(job?.id || "");
  const currentJobId = String(node?.generation?.jobId || "");
  if (!failedJobId || !currentJobId || failedJobId === currentJobId) return false;
  if (!["image", "video", "audio"].includes(String(node?.kind || "")) || !node?.file) return false;
  const failedAt = Date.parse(job?.updatedAt || job?.failedAt || job?.createdAt || "");
  const currentAt = Date.parse(node?.generation?.createdAt || "");
  return Number.isFinite(failedAt) && Number.isFinite(currentAt) && currentAt > failedAt;
};

export const shouldPromoteMediaGenerationResult = ({
  activeCandidatePresent = false,
  activeCandidateJobId = "",
  completedJobId = "",
  completedCreatedAt = "",
  currentGenerationJobId = "",
  currentGenerationCreatedAt = "",
} = {}) => {
  const completedId = String(completedJobId || "");
  if (!completedId) return true;
  if (activeCandidatePresent && String(activeCandidateJobId || "") !== completedId) return false;

  const currentId = String(currentGenerationJobId || "");
  if (!currentId || currentId === completedId) return true;
  const completedTime = Date.parse(completedCreatedAt || "");
  const currentTime = Date.parse(currentGenerationCreatedAt || "");
  if (!Number.isFinite(completedTime) || !Number.isFinite(currentTime)) return false;
  return completedTime > currentTime;
};

const conversationMediaField = (channel) => channel === "audio"
  ? "generatedAudios"
  : channel === "video"
    ? "generatedVideos"
    : "generatedImages";

const conversationMediaLabel = (channel) => channel === "audio" ? "音频" : channel === "video" ? "视频" : "图片";

const conversationTargetInWorkspace = (workspaceState, job) => {
  const conversationId = String(job?.target?.conversationId || "");
  const conversation = (workspaceState?.conversations ?? []).find((item) => item?.id === conversationId);
  if (!conversation) return null;
  const messages = conversation.id === workspaceState.activeConversationId
    ? (Array.isArray(workspaceState.messages) ? workspaceState.messages : conversation.messages ?? [])
    : (Array.isArray(conversation.messages) ? conversation.messages : []);
  const messageId = String(job?.target?.messageId || "");
  return { conversation, messages, index: messages.findIndex((message) => message?.id === messageId), messageId };
};

const conversationMediaTargetWasRolledBack = (target) => (
  Boolean(target?.messageId)
  && target.index < 0
  && (target.conversation?.isolatedBranches ?? []).some((branch) => (
    branch?.type === "rollback"
    && (branch.messages ?? []).some((message) => message?.id === target.messageId)
  ))
);

const attachmentIdentity = (attachment = {}) => String(attachment?.relativePath || attachment?.name || "").replace(/\\/g, "/").toLowerCase();

const generationTimestamp = (...values) => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const durableEventIso = (...values) => {
  const timestamp = generationTimestamp(...values);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
};

const lockGeneratedAttachmentTime = (attachment, job, eventAt) => {
  const source = attachment && typeof attachment === "object" ? attachment : {};
  const createdAt = durableEventIso(source.createdAt, eventAt, job?.completedAt, job?.assetSavedAt, job?.submittedAt, job?.startedAt, job?.createdAt);
  const completedAt = durableEventIso(source.completedAt, job?.completedAt, eventAt);
  const sourceEventAt = durableEventIso(source.sourceEventAt, completedAt, createdAt, eventAt);
  return {
    ...source,
    ...(createdAt ? { createdAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(sourceEventAt ? { sourceEventAt } : {}),
  };
};

const conversationMediaExecutionTiming = (job = {}, previousExecution = {}) => {
  const endedAt = generationTimestamp(job.completedAt, job.updatedAt, previousExecution.endedAt) || Date.now();
  const reportedElapsedMs = Math.max(0, Number(job.result?.elapsedMs ?? job.elapsedMs) || 0);
  const previousElapsedMs = Math.max(0, Number(previousExecution.elapsedMs) || 0);
  const startedAt = generationTimestamp(previousExecution.startedAt, job.startedAt, job.createdAt)
    || Math.max(1, endedAt - (reportedElapsedMs || previousElapsedMs));
  return {
    startedAt,
    endedAt,
    elapsedMs: reportedElapsedMs || Math.max(0, endedAt - startedAt) || previousElapsedMs,
  };
};

export const conversationMediaResultPresent = (workspaceState, job) => {
  if (!job?.id) return false;
  const target = conversationTargetInWorkspace(workspaceState, job);
  if (!target) return false;
  if (mediaGenerationResultSuppressed(job)) return true;
  if (!job?.result?.attachment) return false;
  if (conversationMediaTargetWasRolledBack(target)) return true;
  if (target.index < 0) return false;
  const field = conversationMediaField(job.channel);
  const expectedAttachment = attachmentIdentity(job.result.attachment);
  const message = target.messages[target.index];
  const messageHasAttachment = (message?.[field] ?? []).some((attachment) => attachmentIdentity(attachment) === expectedAttachment);
  const assetHasAttachment = (workspaceState.workspaceAssets ?? []).some((asset) => asset?.generationJobId === job.id
    && attachmentIdentity(asset.attachment) === expectedAttachment);
  return messageHasAttachment && assetHasAttachment;
};

export const conversationMediaTimingNeedsRepair = (workspaceState, job) => {
  if (!job?.id || !job?.result?.attachment) return false;
  const target = conversationTargetInWorkspace(workspaceState, job);
  if (!target || target.index < 0 || conversationMediaTargetWasRolledBack(target)) return false;
  const execution = target.messages[target.index]?.execution ?? {};
  return generationTimestamp(execution.startedAt) <= 0
    || generationTimestamp(execution.endedAt) <= 0
    || !(Number(execution.elapsedMs) > 0);
};

export const applyConversationMediaResultToWorkspace = (workspaceState, job, { timeLabel = "" } = {}) => {
  if (!workspaceState || typeof workspaceState !== "object") throw new Error("对话媒体回填缺少工作区状态");
  if (!job?.id || job.status !== "complete") throw new Error("对话媒体任务尚未产生可落盘结果");
  const target = conversationTargetInWorkspace(workspaceState, job);
  if (!target) throw new Error("发起媒体任务的对话已经不存在");
  if (mediaGenerationResultSuppressed(job)) {
    return { ...target, duplicate: true, recreatedMessage: false, suppressed: true };
  }
  if (!job.result?.attachment) throw new Error("对话媒体任务尚未产生可落盘结果");
  if (conversationMediaTargetWasRolledBack(target)) {
    return { ...target, duplicate: true, recreatedMessage: false, suppressed: true };
  }
  const resultAssetId = `conversation-asset-${target.conversation.id}-${target.messageId || "message"}-${job.channel}-1`;
  const duplicate = conversationMediaResultPresent(workspaceState, job);
  if (duplicate) {
    const message = target.messages[target.index];
    const metadataRepaired = conversationMediaTimingNeedsRepair(workspaceState, job);
    if (metadataRepaired) {
      message.execution = {
        ...(message.execution ?? {}),
        ...conversationMediaExecutionTiming(job, message.execution ?? {}),
      };
      target.conversation.messages = structuredClone(target.messages);
      if (target.conversation.id === workspaceState.activeConversationId) workspaceState.messages = structuredClone(target.messages);
    }
    return { ...target, duplicate: true, recreatedMessage: false, metadataRepaired, assetId: resultAssetId };
  }

  const field = conversationMediaField(job.channel);
  const label = conversationMediaLabel(job.channel);
  const generationEventAt = durableEventIso(
    job.completedAt,
    job.assetSavedAt,
    job.providerTerminalAt,
    job.submittedAt,
    job.startedAt,
    job.createdAt,
    job.result?.attachment?.completedAt,
    job.result?.attachment?.createdAt,
  );
  const resultAttachment = lockGeneratedAttachmentTime(job.result.attachment, job, generationEventAt);
  const previousMessage = target.index >= 0 ? target.messages[target.index] : null;
  const previousExecution = previousMessage?.execution ?? {};
  const executionTiming = conversationMediaExecutionTiming(job, previousExecution);
  const mediaBatch = {
    id: String(job.target?.mediaBatchId || previousMessage?.mediaBatch?.id || ""),
    index: Math.max(1, Number(job.target?.mediaBatchIndex || previousMessage?.mediaBatch?.index) || 1),
    total: Math.max(1, Number(job.target?.mediaBatchTotal || previousMessage?.mediaBatch?.total) || 1),
    label: String(job.target?.mediaBatchLabel || previousMessage?.mediaBatch?.label || "").trim(),
    directory: String(job.result?.mediaBatchDirectory || previousMessage?.mediaBatch?.directory || ""),
    indexPath: String(job.result?.mediaBatchIndexPath || previousMessage?.mediaBatch?.indexPath || ""),
    indexError: String(job.result?.mediaBatchIndexError || ""),
  };
  const batchUnit = job.channel === "image" ? "张" : job.channel === "video" ? "个" : "项";
  const batchPrefix = mediaBatch.total > 1
    ? `第 ${mediaBatch.index}/${mediaBatch.total} ${batchUnit}${mediaBatch.label ? `「${mediaBatch.label}」` : ""}`
    : "";
  const message = {
    id: target.messageId,
    role: "assistant",
    ...(durableEventIso(generationEventAt, previousMessage?.createdAt) ? {
      createdAt: durableEventIso(generationEventAt, previousMessage?.createdAt),
    } : {}),
    time: String(timeLabel || ""),
    content: mediaBatch.indexError
      ? `${batchPrefix || label}已生成并保存，但批次索引写入失败：${mediaBatch.indexError}`
      : job.channel === "image" && job.result.revisedPrompt
      ? `${batchPrefix || "图片"}已生成。模型优化后的画面描述：${job.result.revisedPrompt}`
      : `${batchPrefix || label}已生成。`,
    [field]: [resultAttachment],
    generationPrompt: String(job.request?.prompt || ""),
    novelCover: job.request?.novelCover || null,
    ...(mediaBatch.id ? { mediaBatch } : {}),
    execution: {
      ...previousExecution,
      status: "complete",
      strength: job.channel,
      progressPercent: 100,
      generationJobId: job.id,
      sourceMessageId: previousExecution.sourceMessageId || job.target?.sourceMessageId || "",
      conversationBranchScope: previousExecution.conversationBranchScope || job.target?.conversationBranchScope || "",
      ...executionTiming,
      ...(mediaBatch.id ? { mediaBatch } : {}),
      targetLabel: batchPrefix || `本地生成${label}附件`,
      result: mediaBatch.indexError
        ? `${batchPrefix || label}已保存，批次索引待修复`
        : `${batchPrefix || label}已生成并保存到本地资料库`,
    },
  };
  const recreatedMessage = target.index < 0;
  if (recreatedMessage) {
    target.messages.push(message);
    target.index = target.messages.length - 1;
  } else {
    target.messages[target.index] = message;
  }
  target.conversation.messages = structuredClone(target.messages);
  if (target.conversation.id === workspaceState.activeConversationId) workspaceState.messages = structuredClone(target.messages);
  target.conversation.updatedAt = String(timeLabel || target.conversation.updatedAt || "");
  workspaceState.workspaceAssets = appendGenerationAsset(workspaceState.workspaceAssets, {
    id: resultAssetId,
    kind: job.channel,
    origin: "generated",
    source: "conversation",
    conversationId: target.conversation.id,
    messageId: target.messageId,
    sourceMessageId: previousExecution.sourceMessageId || job.target?.sourceMessageId || "",
    sourceDocumentId: job.target?.documentId || target.conversation.boundDocumentId || "",
    generationJobId: job.id,
    ...(mediaBatch.id ? {
      mediaBatchId: mediaBatch.id,
      mediaBatchIndex: mediaBatch.index,
      mediaBatchTotal: mediaBatch.total,
      mediaBatchLabel: mediaBatch.label,
      mediaBatchDirectory: mediaBatch.directory,
      mediaBatchIndexPath: mediaBatch.indexPath,
    } : {}),
    prompt: String(job.request?.prompt || ""),
    novelCover: job.request?.novelCover || null,
    attachment: resultAttachment,
    ...(generationEventAt ? { createdAt: generationEventAt, completedAt: generationEventAt, sourceEventAt: generationEventAt } : {}),
  });
  return { ...target, duplicate: false, recreatedMessage, message: target.messages[target.index], assetId: resultAssetId };
};

export const createSerializedWorkspaceGenerationWriter = ({
  maxConflictRetries = 3,
  isConflict = defaultWorkspaceConflict,
} = {}) => {
  const queues = new Map();

  return ({ key, loadLatest, merge, save }) => {
    const queueKey = String(key || "");
    if (!queueKey) return Promise.reject(new Error("后台工作区回写缺少串行键"));
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let lastConflict = null;
      for (let attempt = 0; attempt <= Math.max(0, Number(maxConflictRetries) || 0); attempt += 1) {
        const latest = await loadLatest();
        const merged = await merge(latest);
        try {
          return await save(merged, latest);
        } catch (error) {
          if (!isConflict(error) || attempt >= maxConflictRetries) throw error;
          lastConflict = error;
        }
      }
      throw lastConflict ?? new Error("后台工作区回写冲突无法合并");
    });
    let tracked;
    tracked = operation.finally(() => {
      if (queues.get(queueKey) === tracked) queues.delete(queueKey);
    });
    queues.set(queueKey, tracked);
    return tracked;
  };
};
