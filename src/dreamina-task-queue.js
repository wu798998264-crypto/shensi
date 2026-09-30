import { isDreaminaCliSettings } from './dreamina-manual-profile-policy.js';

export const isDreaminaQueueJob = (job = {}) => job.mode === 'server'
  && ['image', 'video'].includes(job.channel)
  && isDreaminaCliSettings(job.request?.settings || {});

export const isDreaminaCredentialBusy = (error = {}) => [
  'DREAMINA_PROFILE_BROKER_BUSY', 'DREAMINA_PROFILE_SWITCH_BLOCKED',
].includes(String(error.providerErrorCode || error.code || '').toUpperCase());

// A slot collision is scheduling, not a provider failure. In particular, a
// read-side collision must never erase an earlier uncertain submission.
export const dreaminaCredentialWaitState = (job = {}, error = {}) => {
  if (!isDreaminaQueueJob(job) || !isDreaminaCredentialBusy(error)) return '';
  if (job.providerTaskId) return 'polling';
  if (job.billingRisk === 'submission_outcome_unknown' || job.resubmitConfirmationRequired
    || ['uncertain', 'unknown', 'submitted'].includes(job.submissionState)
    || (job.submissionState === 'submitting' && error.submissionOutcomeKnown !== true)) return 'reconciling';
  return 'queued';
};

export const isDreaminaQueueReorderable = (job = {}) => isDreaminaQueueJob(job)
  && job.dreaminaQueuePolicy === 'command-lease-v1'
  && job.status === 'queued' && job.submissionState === 'not_submitted'
  // A queued record that survived a server restart stays visible, but must
  // not claim the first dispatch turn until the user explicitly resumes the
  // persisted queue.  This keeps startup observation-only and lets a new
  // user submission make progress immediately.
  && !job.dreaminaQueueDeferredAt
  && !job.capacityRetrySafe && job.providerErrorCode !== 'DREAMINA_CONCURRENCY_LIMIT'
  && !job.billingRisk && !job.resubmitConfirmationRequired
  && !job.providerTaskId && !job.userStoppedAt && job.desiredAction !== 'cancel'
  && !job.supersededBy && !job.dreaminaDispatchToken && !job.dreaminaDispatching;

// Card candidates are compact snapshots, not complete server job records.
// Carry scheduling/cancellation evidence through every progress update.
export const dreaminaQueueCandidateState = (job = {}) => ({
  dreaminaQueuePolicy: job.dreaminaQueuePolicy || '',
  dreaminaDispatching: job.dreaminaDispatching === true,
  providerErrorCode: job.providerErrorCode || '',
  safeNoTaskRetry: job.safeNoTaskRetry === true,
  billingRisk: job.billingRisk || '',
  nextPollAt: job.nextPollAt || '',
  updatedAt: job.updatedAt || '',
  cancelOutcome: job.cancelOutcome || '',
  userStoppedAt: job.userStoppedAt || '',
  resultSuppressed: job.resultSuppressed === true,
});

export const dreaminaQueueVisible = (job = {}) => isDreaminaQueueJob(job)
  && (Boolean(job.forceReleasePendingAt && !job.forceReleaseCompletedAt)
    || (!job.appliedAt && !job.resultSuppressed && !job.supersededBy
      && !['cancelled', 'superseded'].includes(job.status)));

const timingDurationLabel = (milliseconds) => {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${seconds % 60 ? `${seconds % 60}秒` : ''}`;
};

export const dreaminaPreSubmitTimingLabel = (job = {}, nowMs = Date.now()) => {
  const timing = job.preSubmitTiming && typeof job.preSubmitTiming === 'object' ? job.preSubmitTiming : {};
  const started = Date.parse(String(timing.preSubmitStartedAt || ''));
  if (!Number.isFinite(started)) return '';
  const ended = Date.parse(String(timing.providerTaskAcceptedAt || timing.providerResponseAt || ''));
  if (Number.isFinite(ended) && ended >= started) return `提交前耗时：${timingDurationLabel(ended - started)}`;
  return `提交前计时：${timingDurationLabel(Math.max(0, nowMs - started))}`;
};

export const dreaminaQueueView = (job = {}, { position = 0, nowMs = Date.now() } = {}) => {
  const localQueued = isDreaminaQueueReorderable(job);
  const deferred = Boolean(job.dreaminaQueueDeferredAt)
    && !job.providerTaskId
    && job.status === 'queued'
    && job.submissionState === 'not_submitted';
  const complete = job.status === 'complete';
  const legacyQueued = job.status === 'queued' && !job.providerTaskId && job.dreaminaQueuePolicy !== 'command-lease-v1';
  const activity = [job.nextPollAt, job.heartbeatAt, job.updatedAt, job.createdAt]
    .map((value) => Date.parse(value || '')).filter(Number.isFinite);
  const due = activity.length ? Math.max(...activity) : NaN;
  const stale = Number.isFinite(due) && nowMs - due > 120_000;
  const uncertain = ['waiting_credentials', 'waiting_storage', 'retry_required', 'reconciliation_required', 'failed'].includes(job.status)
    || complete || legacyQueued || job.runtimeNeedsAttention === true || (!localQueued && stale)
    || job.billingRisk === 'submission_outcome_unknown' || job.providerErrorCode === 'DREAMINA_CONCURRENCY_LIMIT'
    || Boolean(job.forceReleasePendingAt && !job.forceReleaseCompletedAt);
  const state = complete ? 'result_pending_apply' : deferred ? 'queued_paused' : localQueued ? 'queued' : uncertain ? 'attention' : 'active';
  const settings = job.request?.settings || {};
  // Some Dreamina responses keep queue_position=1 while queue_status has
  // already changed to Generating. Prefer that explicit provider state when
  // rendering the queue so an active task is never shown as permanently
  // queued. The worker normally normalizes this to providerStatus=running,
  // but the fallback also covers older durable records.
  const providerQueueStatus = String(job.providerQueueStatus || '').trim().toLowerCase();
  const providerGenerating = String(job.providerStatus || '').trim().toLowerCase() === 'running'
    || ['generating', 'running', 'processing', 'in_progress', 'in-progress', 'started', 'executing'].includes(providerQueueStatus);
  const stage = complete ? '结果待回写' : deferred ? '重启后自动恢复中' : localQueued ? '本地排队，尚未提交' : (job.dreaminaDispatchToken || job.dreaminaDispatching) && !job.providerTaskId ? '准备提交' : providerGenerating ? '厂商生成中' : ({
    submitting: '正在提交', running: '厂商生成中', polling: '查询生成进度', downloading: '下载及验收',
    waiting_credentials: '需要核验账号', waiting_storage: '需要处理存储', retry_required: '需要核对结果',
    reconciliation_required: '需要核对提交', failed: '生成失败', cancel_requested: '正在停止',
  }[job.status] || job.status);
  return {
    ...job,
    queuePosition: localQueued ? position : 0,
    queueState: state,
    queueTone: localQueued || deferred ? 'blue' : uncertain ? 'red' : 'green',
    queueReorderable: localQueued,
    queueProfileName: String(settings.remarkName || job.request?.generationProfile?.connectionName || settings.connectionName || settings.name || settings.dreaminaCliProfile || job.profileId || ''),
    queueAccount: String(settings.verifiedUserId || settings.userId || (String(job.profileIdentityKey || '').startsWith('user:') ? job.profileIdentityKey.slice(5) : '')),
    // Keep the selected model visible in the shared queue.  This is display
    // metadata only; scheduling and provider isolation continue to use the
    // original request settings unchanged.
    queueModel: String(settings.model || job.request?.generationProfile?.model || ''),
    queueStage: legacyQueued && !providerGenerating ? '历史任务，未自动重新提交' : stage,
  };
};

// Persist the order with one atomic rename; older records join by creation time.
export const orderDreaminaQueueJobs = (jobs = [], ids = []) => {
  const ranks = new Map(ids.map((id, i) => [id, i]));
  return [...jobs].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)
    || Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0) || a.id.localeCompare(b.id));
};
