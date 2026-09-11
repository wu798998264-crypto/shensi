import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaRecoveryJobBlocksOperation } from "../src/media-generation-coordination.js";

const [app, server, mediaWorker] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
]);

assert.match(app, /whiteboardMediaSubmissionLocks/u, "前端必须有白板媒体单飞锁");
assert.match(app, /const submissionLockToken = acquireWhiteboardMediaSubmissionLock\(submissionLockKey, "image"\)/u, "图片提交必须使用本次点击专属锁令牌");
assert.match(app, /const submissionLockToken = acquireWhiteboardMediaSubmissionLock\(submissionLockKey, "video"\)/u, "视频提交必须使用本次点击专属锁令牌");
assert.match(app, /const submissionLockToken = acquireWhiteboardMediaSubmissionLock\(submissionLockKey, "audio"\)/u, "音频提交必须使用本次点击专属锁令牌");
assert.match(app, /本次图片提交正在创建后台任务，请勿重复点击/u, "图片只应阻止同一次提交握手的重复点击");
assert.match(app, /本次视频提交正在创建后台任务，请勿重复点击/u, "视频只应阻止同一次提交握手的重复点击");
assert.match(app, /current\.token !== token/u, "旧请求结束时不得释放新请求的提交锁");
assert.match(app, /const submissionAttemptId = uid\("media-submission-attempt"\)/u, "每次点击必须建立唯一候选身份");
assert.doesNotMatch(app, /!candidate\.jobId && \["connecting", "queued", "submitting"/u, "新点击不得沿用旧任务的计时和候选身份");
const imageSubmitSource = app.slice(
  app.indexOf('elements.whiteboardImageForm.addEventListener("submit"'),
  app.indexOf('elements.whiteboardVideoSettingsTrigger.addEventListener'),
);
const videoSubmitSource = app.slice(
  app.indexOf('elements.whiteboardVideoForm.addEventListener("submit"'),
  app.indexOf('elements.whiteboardImageInput.addEventListener'),
);
const audioSubmitSource = app.slice(
  app.indexOf('elements.whiteboardAudioForm.addEventListener("submit"'),
  app.indexOf('elements.whiteboardImageInput.addEventListener'),
);
assert.match(imageSubmitSource, /图片生成未开始：/u, "图片提交前异常必须有统一提示，不能静默卡死按钮");
assert.match(videoSubmitSource, /视频生成未开始：/u, "视频提交前异常必须有统一提示，不能静默卡死按钮");
assert.match(audioSubmitSource, /音频生成未开始：/u, "音频提交前异常必须有统一提示，不能静默卡死按钮");
assert.match(imageSubmitSource, /finishWhiteboardMediaSubmissionAttempt\([^\n]+channel: "image"[^\n]+\);[\s\S]{0,180}图片生成未开始：/u, "图片提交前异常必须释放本次锁令牌和按钮忙碌态");
assert.match(videoSubmitSource, /finishWhiteboardMediaSubmissionAttempt\([^\n]+channel: "video"[^\n]+\);[\s\S]{0,180}视频生成未开始：/u, "视频提交前异常必须释放本次锁令牌和按钮忙碌态");
assert.match(audioSubmitSource, /finishWhiteboardMediaSubmissionAttempt\([^\n]+channel: "audio"[^\n]+\);[\s\S]{0,120}音频生成未开始：/u, "音频提交前异常必须释放本次锁令牌和按钮忙碌态");
assert.match(app, /A later deliberate click is a replacement request[\s\S]{0,240}finishWhiteboardMediaSubmissionAttempt/u, "后台任务创建成功后必须立即释放短时提交锁");
assert.match(app, /A late terminal update from an older job must never release a newer[\s\S]{0,180}whiteboardMediaSubmissionLocks\.has\(key\)/u, "旧任务迟到结束不得解除新请求锁");
assert.match(app, /生成文件已落盘，但目标卡片尚未确认写入/u, "后台结果未进入卡片时不能标记任务完成");
assert.match(app, /用户已停止 · 正在后台核验厂商取消结果/u, "取消后必须显示后台取消核验状态");
assert.match(app, /神思任务/u, "媒体各阶段必须显示本地任务编号");
assert.match(app, /费用风险待核验|已提交厂商，可能已收费/u, "媒体各阶段必须提示收费风险");
assert.match(app, /job\.mode === "server" && !stopped[\s\S]{0,220}!whiteboardCandidateBelongsToJob/u, "旧任务完成后必须先核对当前卡片候选身份再回填");
assert.match(mediaWorker, /mediaJobAllowsTargetIndexWrite[\s\S]{0,280}resultSuppressed[\s\S]{0,280}desiredAction !== "cancel"/u, "旧 worker 保存文件后必须再次核对任务是否仍可更新目标索引");
assert.match(mediaWorker, /completed\.resultSuppressed && completionPatch\.result\?\.attachment\?\.relativePath[\s\S]{0,260}allowProviderCompletionAfterCancel: true/u, "旧 worker 已下载的迟到结果必须保留记录但继续保持回填抑制");
assert.match(app, /data-media-job-action="dismiss"/u, "租约到期任务必须提供可见的忽略旧任务动作");
assert.match(app, /mediaGenerationActionMarkup\(documentArtifactJobSnapshot\(task\)/u, "正文配图任务必须复用可停止的媒体任务控件");
assert.match(app, /mediaGenerationActionMarkup\(\{ jobId: execution\.generationJobId/u, "对话区媒体任务必须复用可停止的媒体任务控件");
assert.match(app, /candidate \? mediaGenerationActionMarkup\(\{ jobId: candidate\.jobId/u, "白板媒体任务必须复用可停止的媒体任务控件");
assert.match(app, /旧任务已忽略，当前卡片和配置选择已恢复/u, "忽略旧任务后必须明确告知卡片与配置选择已经恢复");
assert.match(app, /filter\(mediaRecoveryJobBlocksOperation\)/u, "待处理页面必须只显示真实阻塞软件操作的媒体任务");
assert.match(app, /当前没有阻塞软件运行的媒体任务，软件可正常使用/u, "阻塞任务处理完后必须明确恢复正常使用状态");
assert.match(app, /const pendingManualRecoveryJobs = new Map\(jobs[\s\S]{0,260}filter\(mediaRecoveryJobIsActionable\)/u,
  "恢复扫描必须独立记录仍需用户处理的阻塞任务，不能只记录恢复过程异常");
assert.match(app, /pendingManualRecoveryJobs\.set\(job\.id, \{ job, detail: error\.message \}\)/u,
  "自动恢复失败的任务必须继续保留在待处理入口");
assert.match(app, /if \(pendingManualRecoveryJobs\.size\)[\s\S]{0,520}showMediaRecoveryBanner/u,
  "任务恢复到失败卡片后，只要仍然阻塞就必须显示全局待处理提示");
assert.match(app, /const remaining = await readMediaRecoveryJobsForDialog\(\);[\s\S]{0,100}clearMediaRecoveryBanner\(\)/u, "处理完成后必须立即刷新列表并清除阻塞横幅");
assert.match(app, /addCanvasGenerationRecoveryTombstone\(removed\.canvas, \{ nodeId, generationJobId \}\)/u, "单卡片删除必须持久化生成目标删除墓碑");
assert.match(app, /targetWasDeleted = canvasGenerationRecoveryTargetDeleted/u, "恢复扫描必须识别用户已经删除的生成目标");
assert.match(app, /if \(userStopped \|\| targetWasDeleted\)/u, "已停止或已删除的任务不得重建卡片");
assert.match(app, /preserveAssetOnly: true,[\s\S]{0,500}保留已停止任务的图片资产/u, "厂商迟到结果必须只进入全部资产而不重建已删除卡片");
assert.match(server, /WHITEBOARD_HISTORY_CONTEXT_FORBIDDEN/u, "白板卡片请求必须拒绝历史对话上下文");
assert.match(server, /dismissMediaGenerationJob/u, "服务端必须提供持久化的旧任务释放动作");
assert.match(server, /const abandonedJobIds = Array\.isArray\(job\.abandonedJobIds\)[\s\S]{0,420}terminateMediaGenerationWorker/u, "新任务创建后服务端必须停止旧任务的本机 worker");
const storeSource = await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8");
assert.match(storeSource, /const targetKey = mediaTargetKey\(channel, normalized\);[\s\S]{0,260}enqueueMediaCreation\(`target:\$\{targetKey\}`[\s\S]{0,260}acquireCapabilitySmokeLock\(`media-target:\$\{targetKey\}`\)/u, "服务端必须先以进程内队列串行化同卡片创建，再使用跨进程目标锁");
assert.match(storeSource, /MEDIA_ACTIVE_STATUSES = new Set\([^\n]+"cancel_requested"/u, "普通传输重试仍必须识别取消待确认的活动任务");
assert.match(storeSource, /forceNewGeneration === true[\s\S]{0,520}findPendingMediaJobsByTarget[\s\S]{0,260}abandonMediaGenerationJobForReplacement/u, "用户明确新提交时必须先放弃同一卡片旧任务");

const blockingJob = {
  id: "generation-blocking",
  mode: "server",
  channel: "video",
  status: "failed",
  target: { targetType: "whiteboard-node", nodeId: "card-blocked" },
  billingRisk: "submission_outcome_unknown",
  availableActions: { autoReconcileProviderTask: true, dismissUncertain: true },
};
assert.equal(mediaRecoveryJobBlocksOperation(blockingJob), true, "仍锁定卡片且提交结果未知的任务必须显示");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, status: "running" }), false, "正常生成中的任务不属于待处理阻塞项目");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, billingRisk: "", availableActions: {} }), false, "没有卡片锁或收费不确定性的历史失败不得污染待处理页面");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, resultSuppressed: true }), false, "用户已处理并放弃的任务必须立即隐藏");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, status: "complete", billingRisk: "", availableActions: {} }), true, "已生成但尚未回填卡片的结果仍需显示");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, status: "complete", appliedAt: new Date().toISOString() }), false, "回填完成的任务必须立即隐藏");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, status: "complete", billingRisk: "", availableActions: { dismissCompleted: true } }), true, "未回填完成任务在用户处理前仍需显示放弃动作");
assert.equal(mediaRecoveryJobBlocksOperation({ ...blockingJob, status: "complete", resultSuppressed: true, availableActions: { dismissCompleted: true } }), false, "已放弃并隐藏的完成任务不得继续阻塞");

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-media-single-flight-"));
process.env.SHENSI_DATA_ROOT = dataRoot;
try {
  const {
    createMediaGenerationJob,
    completeMediaGenerationJob,
    dismissMediaGenerationJob,
    getGenerationJob,
    markGenerationJobApplied,
    requestMediaGenerationCancel,
    requestMediaGenerationResume,
    updateMediaGenerationJob,
  } = await import(`../src/server/generation-job-store.mjs?single-flight=${Date.now()}`);
  const target = {
    workspaceKind: "project",
    workspacePath: join(dataRoot, "workspace"),
    documentId: "whiteboard-single-flight",
    nodeId: "video-card-single-flight",
  };
  const request = {
    prompt: "单飞任务验收",
    settings: { id: "test-video", connectionId: "test-video", provider: "即梦", adapter: "cli", dreaminaCliProfile: "test-account", model: "seedance2.0" },
    aspectRatio: "16:9",
    generationMode: "smart_params",
    duration: 4,
    resolution: "720p",
  };
  const first = await createMediaGenerationJob({ channel: "video", target, request, submissionId: "single-flight-0001" });
  const replacementRequest = {
    ...request,
    prompt: "全新的第二次请求",
    settings: { ...request.settings, model: "seedance2.5-pro" },
    aspectRatio: "9:16",
    duration: 8,
    resolution: "1080p",
    referenceMedia: [
      { id: "reference-b", relativePath: "media/reference-b.png" },
      { id: "reference-a", relativePath: "media/reference-a.png" },
    ],
  };
  const replacementActive = await createMediaGenerationJob({
    channel: "video",
    target,
    request: replacementRequest,
    forceNewGeneration: true,
    regenerationOfJobId: first.id,
    submissionId: "single-flight-0002",
  });
  assert.notEqual(replacementActive.id, first.id, "用户再次点击必须创建全新任务，不能复用旧任务");
  assert.deepEqual(replacementActive.abandonedJobIds, [first.id]);
  assert.equal(replacementActive.request.prompt, replacementRequest.prompt);
  assert.equal(replacementActive.request.settings.model, replacementRequest.settings.model);
  assert.equal(replacementActive.request.aspectRatio, "9:16");
  assert.equal(replacementActive.request.duration, 8);
  assert.equal(replacementActive.request.resolution, "1080p");
  assert.deepEqual(replacementActive.request.referenceMedia.map((item) => item.relativePath), ["media/reference-b.png", "media/reference-a.png"], "新请求的参考顺序必须原样保留");
  const abandonedActive = await getGenerationJob({ jobId: first.id });
  assert.equal(abandonedActive.status, "cancelled");
  assert.equal(abandonedActive.resultSuppressed, true);
  assert.equal(abandonedActive.abandonmentReason, "user_submitted_replacement");
  const duplicateTransportRetry = await createMediaGenerationJob({
    channel: "video",
    target,
    request: replacementRequest,
    forceNewGeneration: true,
    regenerationOfJobId: first.id,
    submissionId: "single-flight-0002",
  });
  assert.equal(duplicateTransportRetry.id, replacementActive.id, "同一 submissionId 的网络重试仍必须去重");
  assert.equal(duplicateTransportRetry.reused, true);
  await assert.rejects(
    createMediaGenerationJob({
      channel: "video",
      target,
      request: { ...replacementRequest, prompt: "错误复用同一个提交编号的新内容" },
      forceNewGeneration: true,
      submissionId: "single-flight-0002",
    }),
    (error) => error?.code === "MEDIA_SUBMISSION_ID_CONFLICT",
    "同一 submissionId 绑定不同内容时必须拒绝，不能串线覆盖",
  );

  const applyTarget = { ...target, nodeId: "video-card-apply-pending" };
  const applyPending = await createMediaGenerationJob({ channel: "video", target: applyTarget, request, submissionId: "single-flight-apply-0001" });
  await updateMediaGenerationJob({ jobId: applyPending.id, patch: {
    status: "complete",
    completedAt: new Date().toISOString(),
    result: { attachment: { relativePath: "media/result.mp4", sha256: "single-flight-sha" } },
  } });
  const replacementApply = await createMediaGenerationJob({
    channel: "video",
    target: applyTarget,
    request: { ...request, prompt: "替代尚未回填的旧结果" },
    forceNewGeneration: true,
    submissionId: "single-flight-apply-0002",
  });
  assert.notEqual(replacementApply.id, applyPending.id, "待回填旧结果也不得阻止用户提交新任务");
  const abandonedApply = await getGenerationJob({ jobId: applyPending.id });
  assert.equal(abandonedApply.status, "complete", "已完成的旧结果必须保留完成状态以便审计");
  assert.equal(abandonedApply.resultSuppressed, true, "已完成的旧结果不得再回填当前卡片");
  assert.equal(abandonedApply.abandonmentReason, "user_submitted_replacement");

  const orphanTarget = { ...target, nodeId: "image-card-orphan-complete" };
  const orphan = await createMediaGenerationJob({
    channel: "image",
    target: orphanTarget,
    request: { ...request, prompt: "目标文档已删除但结果仍需可放弃" },
    submissionId: "single-flight-orphan-complete-0001",
  });
  await updateMediaGenerationJob({ jobId: orphan.id, patch: {
    status: "complete",
    completedAt: new Date().toISOString(),
    result: { attachment: { relativePath: "media/orphan-result.png", sha256: "orphan-result-sha" } },
  } });
  const orphanPublic = await getGenerationJob({ jobId: orphan.id });
  assert.equal(orphanPublic.availableActions.dismissCompleted, true, "已完成但未回填的任务必须允许用户放弃并隐藏");
  const abandoned = await dismissMediaGenerationJob({ jobId: orphan.id });
  assert.equal(abandoned.status, "complete", "放弃回填不得伪装成厂商取消或失败");
  assert.equal(abandoned.resultSuppressed, true, "放弃后必须持久化结果隐藏标记");
  assert.equal(abandoned.abandonmentReason, "user_abandoned_completed_backfill");
  const afterAbandon = await createMediaGenerationJob({
    channel: "image",
    target: orphanTarget,
    request: { ...request, prompt: "放弃旧回填后允许新任务" },
    forceNewGeneration: true,
    submissionId: "single-flight-orphan-complete-0002",
  });
  assert.notEqual(afterAbandon.id, orphan.id, "放弃并隐藏后同一卡片必须能够创建新任务");

  const raceTarget = { ...target, nodeId: "video-card-race" };
  const [raceA, raceB] = await Promise.all([
    createMediaGenerationJob({ channel: "video", target: raceTarget, request: { ...request, prompt: "并发请求甲" }, submissionId: "single-flight-race-a" }),
    createMediaGenerationJob({ channel: "video", target: raceTarget, request: { ...request, prompt: "并发请求乙" }, submissionId: "single-flight-race-b" }),
  ]);
  assert.equal(raceA.id, raceB.id, "不同提示词并发命中同一卡片时也只能创建一个任务");

  const cancelTarget = { ...target, nodeId: "video-card-cancel-pending" };
  const cancelJob = await createMediaGenerationJob({ channel: "video", target: cancelTarget, request, submissionId: "single-flight-cancel-0001" });
  await updateMediaGenerationJob({ jobId: cancelJob.id, patch: {
    status: "polling",
    providerStatus: "running",
    providerTaskId: "provider-task-cancel-0001",
    submissionState: "submitted",
  } });
  const cancelPending = await requestMediaGenerationCancel({ jobId: cancelJob.id });
  assert.equal(cancelPending.status, "cancel_requested");
  assert.equal(cancelPending.desiredAction, "cancel");
  assert.ok(cancelPending.userStoppedAt, "用户确认终止后必须立即记录用户停止状态，以便前端释放按钮");
  const replacementBeforeProviderResolution = await createMediaGenerationJob({
    channel: "video",
    target: cancelTarget,
    request: { ...request, prompt: "取消确认未返回时的新请求" },
    forceNewGeneration: true,
    submissionId: "single-flight-cancel-before-resolution",
  });
  assert.notEqual(replacementBeforeProviderResolution.id, cancelJob.id, "用户明确新提交时，取消待确认的旧任务也必须让路");
  const abandonedCancelPending = await getGenerationJob({ jobId: cancelJob.id });
  assert.equal(abandonedCancelPending.status, "cancelled");
  assert.equal(abandonedCancelPending.resultSuppressed, true);
  assert.equal(abandonedCancelPending.cancelOutcome, "replacement_local_abandonment");
  const lateCompletion = await completeMediaGenerationJob({
    jobId: cancelJob.id,
    allowProviderCompletionAfterCancel: true,
    patch: {
      completedAt: new Date().toISOString(),
      result: { attachment: { relativePath: "media/late-result.mp4", sha256: "late-result-sha" } },
    },
  });
  assert.equal(lateCompletion.status, "complete", "厂商迟到结果仍应持久化为已完成资产");
  assert.equal(lateCompletion.desiredAction, "cancel", "厂商迟到结果不得把用户停止意图改回运行");
  assert.equal(lateCompletion.resultSuppressed, true, "厂商迟到结果不得自动回填用户已放弃的卡片");
  assert.ok(lateCompletion.userStoppedAt, "厂商迟到结果必须保留用户停止时间");
  await updateMediaGenerationJob({ jobId: cancelJob.id, patch: { desiredAction: "run", resultSuppressed: false } });
  const afterLateWorkerWrite = await getGenerationJob({ jobId: cancelJob.id });
  assert.equal(afterLateWorkerWrite.desiredAction, "cancel", "后续后台更新不得覆盖已停止意图");
  assert.equal(afterLateWorkerWrite.resultSuppressed, true, "后续后台更新不得解除结果抑制");
  const blockedWhileProviderCancelPending = await createMediaGenerationJob({
    channel: "video",
    target: cancelTarget,
    request,
    forceNewGeneration: true,
    submissionId: "single-flight-cancel-0002",
  });
  assert.notEqual(blockedWhileProviderCancelPending.id, cancelJob.id, "厂商已经返回迟到结果后，原任务不得继续形成卡片锁");

  const audioTarget = { ...target, nodeId: "audio-card-replacement" };
  const audioRequest = {
    prompt: "旧音频请求",
    settings: { id: "test-audio", connectionId: "test-audio", provider: "LibTV", adapter: "cli", model: "audio-test" },
    audioType: "speech",
    voiceId: "female-shaonv",
    format: "wav",
  };
  const oldAudio = await createMediaGenerationJob({ channel: "audio", target: audioTarget, request: audioRequest, submissionId: "single-flight-audio-0001" });
  const newAudio = await createMediaGenerationJob({
    channel: "audio",
    target: audioTarget,
    request: { ...audioRequest, prompt: "全新的音频请求", voiceId: "male-qingnian" },
    forceNewGeneration: true,
    submissionId: "single-flight-audio-0002",
  });
  assert.notEqual(newAudio.id, oldAudio.id, "音频卡片再次提交也必须放弃旧任务并创建新任务");
  const abandonedAudio = await getGenerationJob({ jobId: oldAudio.id });
  assert.equal(abandonedAudio.status, "cancelled");
  assert.equal(abandonedAudio.resultSuppressed, true);

  const audioResumeTarget = { ...target, nodeId: "audio-card-resume" };
  const audioResumeJob = await createMediaGenerationJob({
    channel: "audio",
    target: audioResumeTarget,
    request: { ...audioRequest, prompt: "需要续接的音频任务" },
    submissionId: "single-flight-audio-resume-0001",
  });
  await updateMediaGenerationJob({ jobId: audioResumeJob.id, patch: {
    status: "retry_required",
    providerStatus: "running",
    providerTaskId: "audio-provider-task-resume-0001",
    submissionState: "submitted",
  } });
  const resumedAudio = await requestMediaGenerationResume({ jobId: audioResumeJob.id, requestId: "audio-resume-request" });
  assert.equal(resumedAudio.status, "polling", "音频任务必须能按原厂商任务 ID 续接");
  assert.equal(resumedAudio.desiredAction, "run");

  const audioCancelTarget = { ...target, nodeId: "audio-card-cancel" };
  const audioCancelJob = await createMediaGenerationJob({
    channel: "audio",
    target: audioCancelTarget,
    request: { ...audioRequest, prompt: "需要用户停止的音频任务" },
    submissionId: "single-flight-audio-cancel-0001",
  });
  assert.equal((await getGenerationJob({ jobId: audioCancelJob.id })).availableActions.stop, true, "音频运行卡片必须显示停止任务动作");
  await updateMediaGenerationJob({ jobId: audioCancelJob.id, patch: {
    status: "polling",
    providerStatus: "running",
    providerTaskId: "audio-provider-task-cancel-0001",
    submissionState: "submitted",
  } });
  const audioCancelPending = await requestMediaGenerationCancel({ jobId: audioCancelJob.id });
  assert.equal(audioCancelPending.status, "cancel_requested", "用户必须能手动停止已提交的音频任务");
  assert.equal(audioCancelPending.resultSuppressed, true);
  const lateAudioCompletion = await completeMediaGenerationJob({
    jobId: audioCancelJob.id,
    allowProviderCompletionAfterCancel: true,
    patch: {
      completedAt: new Date().toISOString(),
      result: { attachment: { relativePath: "media/late-audio.wav", sha256: "late-audio-sha" } },
    },
  });
  assert.equal(lateAudioCompletion.status, "complete", "停止后到达的音频结果仍应保留为可审计资产");
  assert.equal(lateAudioCompletion.desiredAction, "cancel");
  assert.equal(lateAudioCompletion.resultSuppressed, true, "停止后的音频结果不得回填原卡片");
  await updateMediaGenerationJob({ jobId: audioCancelJob.id, patch: { desiredAction: "run", resultSuppressed: false } });
  const afterLateAudioWorkerWrite = await getGenerationJob({ jobId: audioCancelJob.id });
  assert.equal(afterLateAudioWorkerWrite.desiredAction, "cancel", "音频后台迟到更新不得恢复已停止任务");
  assert.equal(afterLateAudioWorkerWrite.resultSuppressed, true);

  const audioCompleteTarget = { ...target, nodeId: "audio-card-complete" };
  const audioCompleteJob = await createMediaGenerationJob({
    channel: "audio",
    target: audioCompleteTarget,
    request: { ...audioRequest, prompt: "正常完成的音频任务" },
    submissionId: "single-flight-audio-complete-0001",
  });
  const completedAudio = await completeMediaGenerationJob({
    jobId: audioCompleteJob.id,
    patch: {
      result: { attachment: { relativePath: "media/audio-complete.wav", sha256: "audio-complete-sha" } },
    },
  });
  assert.equal(completedAudio.status, "complete", "音频必须使用与图片和视频一致的持久完成事务");
  const audioAssetId = "asset-audio-complete";
  const appliedAudio = await markGenerationJobApplied({
    jobId: audioCompleteJob.id,
    resultAssetId: audioAssetId,
    cardReadback: {
      verified: true,
      generationJobId: audioCompleteJob.id,
      documentId: audioCompleteTarget.documentId,
      resultAssetId: audioAssetId,
      verifiedAt: new Date().toISOString(),
    },
  });
  assert.ok(appliedAudio.appliedAt, "音频附件完成回读后必须能标记为已应用");

  const cancelledTarget = { ...target, nodeId: "image-card-cancelled-before-late-result" };
  const cancelledBeforeResult = await createMediaGenerationJob({
    channel: "image",
    target: cancelledTarget,
    request: { ...request, settings: { ...request.settings, model: "5.0" } },
    submissionId: "single-flight-cancelled-late-0001",
  });
  const cancelledAt = await requestMediaGenerationCancel({ jobId: cancelledBeforeResult.id });
  assert.equal(cancelledAt.status, "cancelled", "尚未提交的任务应立即终结取消");
  const cancelledLateResult = await completeMediaGenerationJob({
    jobId: cancelledBeforeResult.id,
    allowProviderCompletionAfterCancel: true,
    patch: {
      completedAt: new Date().toISOString(),
      result: { attachment: { relativePath: "media/cancelled-late.png", sha256: "cancelled-late-sha" } },
    },
  });
  assert.equal(cancelledLateResult.status, "complete", "本地已终结取消后，完整的厂商迟到结果仍应保留");
  assert.equal(cancelledLateResult.desiredAction, "cancel");
  assert.equal(cancelledLateResult.resultSuppressed, true);

  const adjacentCard = await createMediaGenerationJob({
    channel: "video",
    target: { ...target, nodeId: "video-card-batch-adjacent" },
    request: { ...request, prompt: "批量视频相邻卡片" },
    submissionId: "single-flight-batch-0001",
  });
  assert.notEqual(adjacentCard.id, cancelJob.id, "批量视频必须按 nodeId 分别锁定，其他卡片不受影响");

  const expiredTarget = { ...target, nodeId: "image-card-expired-reconciliation" };
  const expired = await createMediaGenerationJob({
    channel: "image",
    target: expiredTarget,
    request: {
      prompt: "找回租约到期后必须可以人工释放",
      settings: { id: "test-video", connectionId: "test-video", provider: "即梦", adapter: "cli", dreaminaCliProfile: "test-account", model: "5.0" },
      aspectRatio: "1:1",
      quality: "2k",
    },
    submissionId: "single-flight-expired-0001",
  });
  await updateMediaGenerationJob({ jobId: expired.id, patch: {
    status: "retry_required",
    providerStatus: "unknown",
    providerErrorCode: "DREAMINA_SUBMISSION_RECONCILIATION_LEASE_EXPIRED",
    submissionState: "unknown",
    billingRisk: "submission_outcome_unknown",
    resubmitConfirmationRequired: true,
    automaticRecoveryStoppedAt: new Date().toISOString(),
    nextPollAt: "",
  } });
  const expiredPublic = await getGenerationJob({ jobId: expired.id });
  assert.equal(expiredPublic.availableActions.autoReconcileProviderTask, true, "租约到期后仍应允许继续找回原任务");
  assert.equal(expiredPublic.availableActions.dismissUncertain, true, "租约到期后必须提供忽略旧任务并释放卡片的动作");
  const dismissed = await dismissMediaGenerationJob({ jobId: expired.id });
  assert.equal(dismissed.status, "cancelled", "用户明确忽略后必须收敛为本地终态");
  assert.equal(dismissed.providerStatus, "cancel_unconfirmed", "没有厂商任务 ID 时不得伪造远端已取消");
  assert.equal(dismissed.resultSuppressed, true);
  assert.equal(dismissed.request.prompt, expired.request.prompt, "忽略旧任务不得删除原提示词和任务记录");
  const afterDismiss = await createMediaGenerationJob({
    channel: "image",
    target: expiredTarget,
    request: { ...expired.request, prompt: "切换配置后重新生成" },
    forceNewGeneration: true,
    submissionId: "single-flight-expired-0002",
  });
  assert.notEqual(afterDismiss.id, expired.id, "忽略旧任务后同一卡片必须能够创建新任务");

  const legacyStoppedTarget = { ...target, nodeId: "image-card-stopped-inconsistent" };
  const legacyStopped = await createMediaGenerationJob({
    channel: "image",
    target: legacyStoppedTarget,
    request: expired.request,
    submissionId: "single-flight-stopped-0001",
  });
  const stoppedAt = new Date().toISOString();
  await updateMediaGenerationJob({ jobId: legacyStopped.id, patch: {
    status: "retry_required",
    providerStatus: "unknown",
    providerErrorCode: "DREAMINA_SUBMISSION_RECONCILIATION_LEASE_EXPIRED",
    billingRisk: "submission_outcome_unknown",
    automaticRecoveryStoppedAt: stoppedAt,
    userStoppedAt: stoppedAt,
    resultSuppressed: true,
    desiredAction: "run",
  } });
  const recoveredFromOldStop = await createMediaGenerationJob({
    channel: "image",
    target: legacyStoppedTarget,
    request: { ...expired.request, prompt: "旧版停止状态也必须释放" },
    forceNewGeneration: true,
    submissionId: "single-flight-stopped-0002",
  });
  assert.notEqual(recoveredFromOldStop.id, legacyStopped.id, "旧版本遗留的停止状态不得继续形成隐形卡片锁");

  const { addCanvasGenerationRecoveryTombstone, canvasGenerationRecoveryTargetDeleted, normalizeCanvas } = await import(`../src/whiteboard.js?generation-tombstone=${Date.now()}`);
  const blankCanvas = normalizeCanvas({ nodes: [], edges: [] });
  const deletedCanvas = addCanvasGenerationRecoveryTombstone(blankCanvas, {
    nodeId: "deleted-generation-card",
    generationJobId: "generation-deleted-card-0001",
    deletedAt: "2026-09-01T10:00:00.000Z",
  });
  assert.equal(canvasGenerationRecoveryTargetDeleted(deletedCanvas, {
    nodeId: "deleted-generation-card",
    generationJobId: "generation-deleted-card-0001",
    generationCreatedAt: "2026-09-01T09:00:00.000Z",
  }), true, "删除生成卡片后必须阻止同一任务自动重建目标卡片");
  assert.equal(canvasGenerationRecoveryTargetDeleted(deletedCanvas, {
    nodeId: "deleted-generation-card",
    generationJobId: "generation-new-card-0002",
    generationCreatedAt: "2026-09-01T11:00:00.000Z",
  }), false, "删除墓碑不得阻塞同一位置后来明确创建的新任务");
  assert.deepEqual(normalizeCanvas(deletedCanvas).generationRecoveryTombstones, deletedCanvas.generationRecoveryTombstones, "删除墓碑必须随白板规范化和历史快照持久化");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
}

console.log("media single-flight and card-apply gate tests passed");
