import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mediaGenerationActionPresentation,
  mediaGenerationFailureNeedsCard,
  whiteboardMediaJobHoldsCard,
  whiteboardMediaJobIsSupersededByNodeGeneration,
} from "../src/media-generation-coordination.js";
import { classifyMediaSubmissionFailure } from "../src/server/media-submission-recovery.mjs";
import { dreaminaProfileCommandFailure } from "../src/server/dreamina-profile-oauth.mjs";
import { assertDreaminaImageModelRequest, assertImageReferenceRequest } from "../src/server/generation-job-store.mjs";

const brokerBusy = Object.assign(new Error("credential slot busy"), {
  code: "DREAMINA_PROFILE_BROKER_BUSY",
  submissionOutcomeKnown: true,
});
const classified = classifyMediaSubmissionFailure({
  job: { channel: "video", status: "submitting", transientFailures: 27 },
  error: brokerBusy,
});
assert.equal(classified.safeAutomaticRetry, false, "凭据槽繁忙也必须遵守有限重试次数，不能无限占用");
assert.equal(classified.submissionUnknown, false, "凭据槽繁忙发生在提交前，不能标记为扣费结果未知");
assert.deepEqual(
  dreaminaProfileCommandFailure({ code: 75, stderr: "[DREAMINA_PROFILE_BROKER_BUSY] credential slot is busy" }),
  {
    ok: false,
    transient: true,
    code: "DREAMINA_PROFILE_BROKER_BUSY",
    error: "即梦账号通道正被生成、找回或其他账号核验占用，本次在线核验已延后；已保存的核验状态保持有效",
  },
  "凭据槽繁忙只能延后在线刷新，不能让已核验账号失效",
);
assert.equal(
  dreaminaProfileCommandFailure({ code: 78, stderr: "not signed in" }).transient,
  false,
  "真实未登录错误仍必须要求重新核验",
);
assert.throws(
  () => assertImageReferenceRequest({ prompt: "[REFERENCE IMAGE URL] 与参考图完全一致", referenceMedia: [] }),
  (error) => error.code === "IMAGE_REFERENCE_REQUIRED" && error.statusCode === 422,
  "提示词含未解析参考图占位符时必须在提交付费任务前阻止",
);
assert.equal(assertImageReferenceRequest({
  prompt: "[REFERENCE IMAGE URL] 与参考图完全一致",
  referenceMedia: [{ mimeType: "image/png", relativePath: "assets/reference.png" }],
}), true);
assert.throws(
  () => assertDreaminaImageModelRequest({
    quality: "1k",
    settings: { provider: "即梦", adapter: "cli", model: "5.0Pro" },
  }),
  (error) => error.code === "IMAGE_MODEL_OPTIONS_INVALID" && error.statusCode === 422,
  "5.0Pro 的旧 1k 参数必须在提交计费任务前阻止",
);
assert.equal(assertDreaminaImageModelRequest({
  quality: "1.5k",
  settings: { provider: "即梦", adapter: "cli", model: "5.0Pro" },
}), true);

assert.deepEqual(
  mediaGenerationActionPresentation({ status: "retry_required", availableActions: { autoReconcileProviderTask: true } }),
  { action: "reconcile", label: "自动找回", confirmNewSubmission: false, recovery: true },
  "找回应使用保存的任务元数据，不向用户索要厂商 ID",
);
const failedBeforeSubmission = {
  status: "failed",
  availableActions: { confirmedResubmit: true },
};
assert.equal(whiteboardMediaJobHoldsCard(failedBeforeSubmission), false, "明确失败不得继续占用白板卡片执行锁");
assert.equal(mediaGenerationFailureNeedsCard(failedBeforeSubmission), true, "明确失败仍应保留原卡片错误与重新生成入口");
assert.equal(whiteboardMediaJobHoldsCard(null), false, "视频任务创建前失败时不得因空任务读取 userStoppedAt 而遮蔽真实错误");

const oldFailedJob = {
  id: "generation-old",
  status: "failed",
  updatedAt: "2026-08-15T13:45:00.000Z",
};
const newerSuccessfulNode = {
  id: "canvas-node",
  kind: "video",
  file: "assets/final.mp4",
  generation: {
    jobId: "generation-new",
    createdAt: "2026-08-15T14:05:00.000Z",
  },
};
assert.equal(
  whiteboardMediaJobIsSupersededByNodeGeneration(oldFailedJob, newerSuccessfulNode),
  true,
  "同一卡片后来的成功媒体必须压过旧失败覆盖层",
);
assert.equal(
  whiteboardMediaJobIsSupersededByNodeGeneration({ ...oldFailedJob, id: "generation-new" }, newerSuccessfulNode),
  false,
  "当前任务不能被自身视为旧失败",
);

const [runner, worker, drivers, imageBridge, store, app, server, styles] = await Promise.all([
  readFile(new URL("./windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
assert.match(runner, /WaitOne\(\[TimeSpan\]::FromSeconds\(2\)\)/u, "账号凭据槽不能继续阻塞到外层超时");
assert.match(runner, /DREAMINA_PROFILE_BROKER_BUSY/u, "凭据槽繁忙应返回可识别的未提交状态");
assert.match(worker, /current\.providerTaskId \|\| dreaminaSubmissionRecoveryPending \? "retry_required" : "failed"/u, "连接重试耗尽后保留已提交任务，交由用户决定而非无限查询");
assert.doesNotMatch(worker, /acquireJobLock\("dreamina-cli-global"\)/u, "工作进程不得用任务级锁覆盖厂商查询、下载和卡片回写");
assert.match(runner, /Global\\ShensiDreaminaCredentialSwitchV1/u, "Windows 配置槽仍必须由单命令互斥保护");
assert.match(worker, /本任务尚未提交、不会扣积分/u, "未提交的凭据槽等待应明确说明不会扣积分");
assert.match(worker, /safeAutomaticRetry[\s\S]{0,900}safeNoTaskRetry: true/u, "单命令凭据槽繁忙发生在提交前时必须留下可安全续跑标记");
assert.match(worker, /dreaminaJobs\.sort\([\s\S]{0,220}priority\(left\) - priority\(right\)/u, "新提交的安全队列任务必须优先于无期限历史找回，避免被饿死");
assert.match(drivers, /12 \* 60_000/u, "提交查询必须覆盖官方 CLI 的十分钟执行上限，不能再被 120/180 秒误杀");
assert.match(imageBridge, /providerQueuePosition: queue\.position/u, "图片任务也必须透传厂商排队位置");
assert.match(imageBridge, /providerQueueLength: queue\.length/u, "图片任务也必须透传厂商排队总数");
assert.match(imageBridge, /\["1\.5k", "2k", "4k"\]/u, "5.0Pro 必须使用官方支持的 1.5k、2k、4k 分辨率");
assert.match(store, /automatic_submission_reconciliation/u, "自动找回必须由后台按幂等键核对");
assert.match(store, /DREAMINA_PRE_SUBMIT_INTERRUPTED/u, "旧版提交前超时应明确标记为未提交");
assert.doesNotMatch(app, /requestMediaProviderTaskId/u, "界面不得再要求用户填写内部任务 ID");
assert.match(app, /const reopenableChannels = \["text", "image", "video", "audio"\]/u, "已生成卡片应按持久类型重新打开对应操作栏，不依赖瞬时探测");
assert.match(app, /whiteboardMediaJobIsSupersededByNodeGeneration/u, "旧失败不得覆盖同一卡片的新成功结果");
assert.match(app, /dreaminaCreditRefreshIdentityForCompletedJob/u, "积分刷新必须绑定到已经完成的持久任务快照");
assert.match(app, /recordedConnectionId && recordedConnectionId !== connectionId/u, "任务配置元数据不一致时不得刷新或提示其他即梦账号");
assert.match(app, /refreshDreaminaCreditAfterSuccessfulGeneration\(job\)/u, "生成成功后的积分刷新必须使用完成任务，而不是当前界面配置");
assert.match(app, /markDreaminaCreditRefreshPending\(profileId\)/u, "后台积分暂未返回时只标记余额待刷新");
assert.doesNotMatch(app, /最新剩余积分暂未读取/u, "后台积分刷新失败不得再弹出容易误认为配置串线的提示");
assert.doesNotMatch(app, /refreshDreaminaCreditAfterSuccessfulGeneration\((?:image|video)Settings\)/u, "图片和视频提交函数不得重复按局部配置触发积分刷新");
assert.match(app, /refreshCurrentDreaminaCredit[\s\S]{0,1400}AbortSignal\.timeout\(75_000\)/u, "手动积分刷新等待时间必须覆盖服务端真实积分查询上限");
assert.match(app, /creditRefreshDeferred[\s\S]{0,500}自动重试/u, "凭据槽繁忙时积分刷新必须等待并自动重试");
assert.match(app, /persistVerifiedGenerationChannel\("text"\)/u, "文字连接测试成功后必须自动保存");
assert.match(app, /persistVerifiedGenerationChannel\("image"\)/u, "图片连接测试成功后必须自动保存");
assert.match(app, /persistVerifiedGenerationChannel\("video"\)/u, "视频连接测试和即梦核验成功后必须自动保存");
assert.match(app, /applyCompletedConversationMediaJobNow[\s\S]{0,500}refreshDreaminaCreditAfterSuccessfulGeneration/u, "对话媒体生成成功后也必须刷新对应账号积分");
assert.match(app, /applyCompletedDocumentArtifactJob[\s\S]{0,500}refreshDreaminaCreditAfterSuccessfulGeneration/u, "文档配图生成成功后也必须刷新对应账号积分");
assert.match(app, /当前对话第一次生成\$\{channel === "video" \? "视频" : "图片"\}，请选择具体模型和配置；成功后本对话会记住该选择。/u, "对话首次生成媒体必须让用户选择具体配置，不能默认串到 GPT 或其他连接");
assert.match(app, /source:[^\n]{0,220}"conversation_memory"/u, "对话后续媒体生成应继续使用本对话上次成功的具体配置");
assert.match(app, /上次使用的\$\{channel === "video" \? "视频" : "图片"\}配置当前不可用，请重新选择具体模型和配置。/u, "已记忆配置失效后必须让用户重新选择，不能自动改用其他配置");
assert.match(app, /GPT 生图已明确返回额度不足。请选择即梦配置继续本次生成/u, "GPT 额度不足时必须询问即梦具体配置");
assert.match(app, /requestedConversationMediaConnectionCandidates[\s\S]{0,1400}requestedProfiles\.length === 1/u, "用户明确指定唯一配置时应直接使用，不再询问");
assert.match(app, /gpt_quota_fallback/u, "GPT 首次返回额度不足后应保留原任务并由用户选择即梦后续接");
assert.match(app, /videoDragSurface[\s\S]{0,700}scheduleWhiteboardCardOpen\(card\.dataset\.canvasNode\)/u, "已有视频画面单击不得吞掉卡片操作栏自动唤醒");
assert.match(app, /forceNewGeneration: true,[\s\S]{0,120}regenerationOfJobId: previousGenerationJobId/u, "图片再次生成必须显式建立新一轮任务");
assert.match(app, /forceNewGeneration: true,[\s\S]{0,160}regenerationOfJobId: targetNodeId === nodeId \? previousGenerationJobId : ""/u, "视频再次生成必须显式替换目标卡片的旧任务");
assert.match(store, /forceNewGeneration !== true/u, "只有网络重试可以复用请求指纹，明确重新生成必须跳过旧任务复用");
assert.match(app, /GENERATION_JOB_RESPONSE_INVALID/u, "前端必须拒绝空的持久任务响应，不能继续读取 userStoppedAt");
assert.match(app, /const current = job && typeof job === "object" \? job : \{\};[\s\S]{0,220}正在连接生成任务/u, "媒体状态文案必须对空任务安全降级且使用用户可理解的文字");
assert.match(app, /const localTaskId = String\(current\.id \|\| current\.jobId \|\| ""\)\.trim\(\)/u, "白板卡片必须使用 jobId 识别已经建立的生成任务，不能一直误显示正在连接");
assert.match(app, /connecting: "正在连接生成服务",[\s\S]{0,180}submitting: providerAccepted \? "正在生成" : "正在连接生成服务",[\s\S]{0,120}running: "正在生成",[\s\S]{0,100}polling: "正在生成"/u, "连接阶段不得误报生成；厂商受理后的运行与轮询阶段必须明确显示正在生成");
assert.doesNotMatch(app, /正在重新读取持久任务状态/u, "用户界面不得暴露持久任务等内部术语");
assert.match(server, /生成任务记录为空或不完整[\s\S]{0,180}GENERATION_JOB_RESPONSE_INVALID/u, "服务端不得把空任务包装成成功响应");
assert.match(app, /captureWhiteboardSpaceTextSnapshot[\s\S]{0,1300}restoreWhiteboardSpaceTextSnapshotForPan/u, "生成栏聚焦时必须保留空格输入快照供白板平移恢复");
assert.match(app, /if \(ui\.whiteboardSpacePressed\) restoreWhiteboardSpaceTextSnapshotForPan\(\);[\s\S]{0,600}if \(!ui\.whiteboardSpacePressed\) closeWhiteboardGenerationDialogsOutside/u, "空格平移必须先恢复提示词且跳过栏外关闭");
assert.match(app, /generationTextEditing[\s\S]{0,450}!event\.isComposing[\s\S]{0,450}!editingText[\s\S]{0,180}event\.preventDefault/u, "提示词编辑时应记录物理空格，但不能阻止普通输入或输入法");
assert.match(styles, /minmax\(140px, 1\.05fr\) minmax\(184px, 1\.40fr\) minmax\(126px, \.92fr\) minmax\(212px, 1\.45fr\)/u, "视频栏只把 8px 从模型列转移给设置列");

const testDataRoot = await mkdtemp(join(tmpdir(), "shensi-explicit-regeneration-"));
process.env.SHENSI_DATA_ROOT = testDataRoot;
try {
  const { createMediaGenerationJob, getGenerationJob, updateMediaGenerationJob } = await import(`../src/server/generation-job-store.mjs?explicit-regeneration=${Date.now()}`);
  const target = {
    workspaceKind: "project",
    workspacePath: join(testDataRoot, "workspace"),
    documentId: "whiteboard-test",
    nodeId: "video-card-test",
  };
  const request = {
    prompt: "相同提示词也必须允许用户明确重新生成",
    settings: {
      id: "test-video",
      connectionId: "test-video",
      provider: "即梦",
      adapter: "cli",
      model: "seedance2.0",
      dreaminaCliProfile: "default",
    },
    aspectRatio: "16:9",
    generationMode: "smart_params",
    duration: 4,
    resolution: "720p",
  };
  const first = await createMediaGenerationJob({ channel: "video", target, request, submissionId: "submission-regeneration-0001" });
  const fingerprintReuse = await createMediaGenerationJob({ channel: "video", target, request, submissionId: "submission-regeneration-0002" });
  assert.equal(fingerprintReuse.id, first.id, "普通网络路径仍应复用相同活跃请求，避免意外双提交");
  const replacementDuringActive = await createMediaGenerationJob({
    channel: "video",
    target,
    request,
    submissionId: "submission-regeneration-0003",
    forceNewGeneration: true,
    regenerationOfJobId: first.id,
  });
  assert.notEqual(replacementDuringActive.id, first.id, "用户明确再次提交时必须放弃旧任务并创建全新任务");
  assert.notEqual(replacementDuringActive.idempotencyKey, first.idempotencyKey, "替代任务必须获得全新厂商幂等键");
  const abandonedFirst = await getGenerationJob({ jobId: first.id });
  assert.equal(abandonedFirst.status, "cancelled", "旧任务必须立即释放卡片占用");
  assert.equal(abandonedFirst.resultSuppressed, true, "旧任务的迟到结果不得覆盖新卡片内容");
  assert.equal(abandonedFirst.abandonmentReason, "user_submitted_replacement");

  await updateMediaGenerationJob({ jobId: replacementDuringActive.id, patch: {
    status: "failed",
    failedAt: new Date().toISOString(),
    error: "测试任务已进入终态",
  } });
  const regenerated = await createMediaGenerationJob({
    channel: "video",
    target,
    request,
    submissionId: "submission-regeneration-0004",
    forceNewGeneration: true,
    regenerationOfJobId: replacementDuringActive.id,
  });
  assert.notEqual(regenerated.id, replacementDuringActive.id, "旧任务已终结时也必须创建独立的新一轮");
  assert.notEqual(regenerated.idempotencyKey, replacementDuringActive.idempotencyKey, "新一轮必须获得全新厂商幂等键");
  assert.equal(regenerated.explicitRegeneration, true);
  assert.equal(regenerated.regenerationOfJobId, replacementDuringActive.id);
  const transportRetry = await createMediaGenerationJob({
    channel: "video",
    target,
    request,
    submissionId: "submission-regeneration-0004",
    forceNewGeneration: true,
    regenerationOfJobId: replacementDuringActive.id,
  });
  assert.equal(transportRetry.id, regenerated.id, "同一新任务的 HTTP 重发仍必须保持幂等");
} finally {
  await rm(testDataRoot, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
}

console.log("即梦多账号队列、自动找回、显式重新生成与卡片操作栏回归测试通过");
