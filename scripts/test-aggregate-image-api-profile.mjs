import assert from "node:assert/strict";
import {
  AGGREGATE_IMAGE_API_PROFILE_VERSION,
  generationRuntimeBindings,
  normalizeGenerationProfiles,
} from "../src/generation-profiles.js";
import { imageGenerationMode } from "../src/model-presets.js";
import { publicGenerationJob } from "../src/server/generation-job-store.mjs";
import {
  aggregateImageRecoveryPolicy,
  builtInAggregateImageRecoveryJob,
  classifyMediaSubmissionFailure,
  DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS,
  isUpstreamStreamOpenTimeout,
  legacyAggregateReferencePreflightFailurePatch,
} from "../src/server/media-submission-recovery.mjs";
import {
  generationRuntimeCredentialsSnapshot,
  rememberGenerationRuntimeCredentials,
  resolveTrustedGenerationSettings,
} from "../src/server/generation-runtime-store.mjs";
import { generateImageWithAdapter } from "../src/server/adapters.mjs";
import { mediaGenerationActionPresentation } from "../src/media-generation-coordination.js";
import { readFile } from "node:fs/promises";

const profileId = "image-cockpit-aggregate-api";
const expectedBaseUrl = "http://127.0.0.1:5317/v1";

const upstreamTimeoutError = Object.assign(new Error("模型请求失败：upstream timed out in stream_open attempt=1/1 after 1m0s"), {
  providerErrorCode: "upstream_first_byte_timeout",
  submissionOutcomeKnown: true,
});
assert.equal(isUpstreamStreamOpenTimeout(upstreamTimeoutError), true, "聚合上游流打开超时必须被识别");
assert.equal(isUpstreamStreamOpenTimeout({ providerErrorCode: "HTTP_401", message: "invalid api key" }), false);

const initial = normalizeGenerationProfiles({});
const aggregate = initial.imageConnections.find((profile) => profile.id === profileId);
assert.ok(aggregate, "空设置应补入聚合 API 图片配置");
assert.equal(aggregate.name, "聚合api");
assert.equal(aggregate.remarkName, "聚合api");
assert.equal(aggregate.adapter, "api");
assert.equal(aggregate.provider, "自定义兼容接口");
assert.equal(aggregate.protocol, "images");
assert.equal(aggregate.baseUrl, expectedBaseUrl);
assert.equal(aggregate.model, "gpt-image-2");
assert.equal(aggregate.timeoutMs, "660000");
assert.equal(aggregate.apiKey, "", "源码预设不得包含 API Key");
assert.equal(initial.aggregateImageApiProfileVersion, AGGREGATE_IMAGE_API_PROFILE_VERSION);
assert.equal(imageGenerationMode(aggregate), "images_api");

const withSecureCredential = normalizeGenerationProfiles({}, {
  image: { [profileId]: "secure-test-token" },
});
assert.equal(
  withSecureCredential.imageConnections.find((profile) => profile.id === profileId)?.apiKey,
  "secure-test-token",
  "聚合 API Key 应从安全凭据存储注入，而不是写入源码预设",
);
rememberGenerationRuntimeCredentials({ credentials: { image: { [profileId]: "secure-test-token" } } });
const mediaCredentialSnapshot = generationRuntimeCredentialsSnapshot({ channels: ["image", "video", "audio"] });
assert.equal(mediaCredentialSnapshot.image?.[profileId], "secure-test-token", "媒体 worker 应能取得当前核心会话的图片凭据转交快照");
assert.equal(mediaCredentialSnapshot.text, undefined, "媒体 worker 转交快照不得包含文本模型凭据");
const reboundWithoutPortableSecret = await resolveTrustedGenerationSettings({
  channel: "image",
  settings: { ...aggregate, apiKey: "" },
});
assert.equal(reboundWithoutPortableSecret.apiKey, "secure-test-token", "后台 worker 必须能从当前核心会话恢复已核验的 API 凭据");

// A credential may be verified on the text profile while image/video profiles
// intentionally keep a redacted shared-endpoint record. Runtime rebinding must
// resolve that one unambiguous secret across channels without persisting it.
const sharedEndpointSettings = {
  textConnections: [{ id: "text-shared", adapter: "api", provider: aggregate.provider, protocol: "responses", baseUrl: expectedBaseUrl, model: "gpt-5.6-sol" }],
  imageConnections: [{ ...aggregate, apiKey: "" }],
};
rememberGenerationRuntimeCredentials({ credentials: { image: { [profileId]: "" } } });
rememberGenerationRuntimeCredentials({
  credentials: { text: { "text-shared": "shared-runtime-token" } },
  bindings: [
    { channel: "text", profileId: "text-shared", adapter: "api", provider: aggregate.provider, protocol: "responses", baseUrl: expectedBaseUrl },
    { channel: "image", profileId, adapter: "api", provider: aggregate.provider, protocol: "images", baseUrl: expectedBaseUrl },
  ],
});
const reboundSharedImage = await resolveTrustedGenerationSettings({
  channel: "image",
  settings: { ...aggregate, baseUrl: expectedBaseUrl, apiKey: "" },
});
assert.equal(reboundSharedImage.apiKey, "shared-runtime-token", "共享端点凭据必须能从文字通道安全恢复到图片通道");

const preserved = normalizeGenerationProfiles({
  activeImageConnectionId: "image-user-selected",
  imageConnections: [
    {
      id: "image-user-selected",
      name: "用户现有配置",
      adapter: "api",
      provider: "自定义兼容接口",
      protocol: "images",
      baseUrl: "http://127.0.0.1:9000/v1",
      model: "custom-image-model",
      timeoutMs: "120000",
      apiKey: "existing-secret",
    },
  ],
});
assert.equal(preserved.activeImageConnectionId, "image-user-selected", "不得切换用户当前活动配置");
assert.ok(preserved.imageConnections.some((profile) => profile.id === "image-user-selected"), "不得覆盖现有配置");
assert.equal(preserved.imageConnections.filter((profile) => profile.id === profileId).length, 1);

const normalizedAgain = normalizeGenerationProfiles(preserved);
assert.equal(normalizedAgain.imageConnections.filter((profile) => profile.id === profileId).length, 1, "重复规范化不得重复新增");

const existingEndpoint = normalizeGenerationProfiles({
  imageConnections: [
    {
      id: "image-user-aggregate",
      name: "已有聚合接口",
      adapter: "api",
      provider: "自定义兼容接口",
      protocol: "images",
      baseUrl: `${expectedBaseUrl}/`,
      model: "gpt-image-2",
      timeoutMs: "660000",
      apiKey: "existing-secret",
    },
  ],
});
assert.equal(existingEndpoint.imageConnections.filter((profile) => profile.id === profileId).length, 0, "同端点同模型不得新增别名配置");
assert.equal(existingEndpoint.imageConnections.filter((profile) => profile.id === "image-user-aggregate").length, 1);

const afterIntentionalRemoval = normalizeGenerationProfiles({
  ...initial,
  imageConnections: initial.imageConnections.filter((profile) => profile.id !== profileId),
});
assert.equal(afterIntentionalRemoval.imageConnections.filter((profile) => profile.id === profileId).length, 0, "迁移完成后不得强制恢复用户删除的配置");

const binding = generationRuntimeBindings(initial).bindings.find((item) => item.channel === "image" && item.profileId === profileId);
assert.ok(binding, "聚合 API 配置应进入运行时绑定");
assert.equal(binding.baseUrl, expectedBaseUrl);
assert.equal(binding.protocol, "images");

const recoveryJob = {
  channel: "image",
  idempotencyKey: "generation-test-idempotency-key",
  request: { settings: aggregate },
};
assert.equal(builtInAggregateImageRecoveryJob(recoveryJob), true, "只有内置聚合图片连接可进入自动同幂等键找回");
const aggregateTimeoutClassification = classifyMediaSubmissionFailure({
  job: { ...recoveryJob, status: "submitting", providerTaskId: null },
  error: upstreamTimeoutError,
});
assert.equal(aggregateTimeoutClassification.submissionUnknown, true, "聚合上游流超时必须进入同幂等键结果核对");
assert.equal(aggregateTimeoutClassification.upstreamStreamOpenTimeout, true);
assert.equal(classifyMediaSubmissionFailure({
  job: { ...recoveryJob, status: "submitting", providerTaskId: null },
  error: Object.assign(new Error("invalid api key"), { providerErrorCode: "HTTP_401", submissionOutcomeKnown: true }),
}).submissionUnknown, false, "鉴权失败不能进入上游结果未知恢复");
assert.equal(builtInAggregateImageRecoveryJob({
  ...recoveryJob,
  request: {
    settings: {
      provider: aggregate.provider,
      adapter: aggregate.adapter,
      protocol: aggregate.protocol,
      model: aggregate.model,
      connectionId: aggregate.id,
    },
  },
}), true, "持久任务移除 baseUrl 后仍必须按内置连接 ID 进入自动找回");
assert.equal(builtInAggregateImageRecoveryJob({
  ...recoveryJob,
  request: { settings: { ...aggregate, id: "image-user-copy", connectionId: "image-user-copy" } },
}), false, "任意第三方兼容接口不得套用聚合图片自动重试规则");
assert.equal(builtInAggregateImageRecoveryJob({
  ...recoveryJob,
  request: { settings: { ...aggregate, baseUrl: "http://127.0.0.1:9000/v1" } },
}), false, "任务记录显式包含其他端点时不得冒充内置聚合图片连接");

const originalFetch = globalThis.fetch;
let editRequest = null;
globalThis.fetch = async (url, options = {}) => {
  editRequest = { url: String(url), options };
  return new Response(JSON.stringify({
    id: "aggregate-image-edit-response-1",
    data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};
try {
  const edited = await generateImageWithAdapter({
    settings: { ...aggregate, apiKey: "secure-test-token", imageChannel: true },
    prompt: "保留线条与颜色，只去除噪点",
    aspectRatio: "16:9",
    quality: "high",
    imageCount: 1,
    idempotencyKey: "aggregate-image-edit-idempotency",
    referenceImages: [{
      id: "reference-1",
      name: "参考图.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    }],
  });
  assert.equal(editRequest.url, `${expectedBaseUrl}/images/edits`, "聚合 API 带参考图时必须走图片编辑端点");
  assert.equal(editRequest.options.method, "POST");
  assert.ok(editRequest.options.body instanceof FormData);
  assert.equal(editRequest.options.body.getAll("image[]").length, 1, "参考图必须作为真实媒体参数提交，不能只留在提示词中");
  assert.equal(editRequest.options.body.get("prompt").includes("保留线条与颜色"), true);
  assert.equal(edited.dataUrls.length, 1);
} finally {
  globalThis.fetch = originalFetch;
}

let upstreamTimeoutRequest = null;
globalThis.fetch = async (url, options = {}) => {
  upstreamTimeoutRequest = { url: String(url), options };
  return new Response(JSON.stringify({
    error: {
      code: "upstream_first_byte_timeout",
      message: "upstream timed out in stream_open attempt=1/1 after 1m0s",
    },
  }), { status: 504, headers: { "content-type": "application/json" } });
};
try {
  const upstreamTimeout = await generateImageWithAdapter({
    settings: { ...aggregate, apiKey: "secure-test-token", imageChannel: true },
    prompt: "生成一张测试图片",
    idempotencyKey: "aggregate-upstream-timeout-idempotency",
  }).then(() => null, (error) => error);
  assert.equal(upstreamTimeoutRequest?.url, `${expectedBaseUrl}/images/generations`);
  assert.equal(upstreamTimeout?.providerErrorCode, "upstream_first_byte_timeout");
  assert.equal(upstreamTimeout?.submissionOutcomeKnown, false, "真实聚合网关流超时不得声明提交结果已知");
  assert.equal(upstreamTimeout?.retryableUpstreamTimeout, true);
} finally {
  globalThis.fetch = originalFetch;
}

const invalidReferenceError = await generateImageWithAdapter({
  settings: { ...aggregate, apiKey: "secure-test-token", imageChannel: true },
  prompt: "使用参考图生成",
  referenceImages: [{ id: "reference-empty", name: "空参考图", mimeType: "image/png", dataUrl: "" }],
}).then(() => null, (error) => error);
assert.equal(invalidReferenceError?.providerErrorCode, "IMAGE_REFERENCE_INVALID");
assert.equal(invalidReferenceError?.submissionOutcomeKnown, true, "本地参考图校验失败必须明确标记为未提交厂商");
assert.equal(classifyMediaSubmissionFailure({
  job: { channel: "image", status: "submitting", providerTaskId: null },
  error: invalidReferenceError,
}).submissionUnknown, false, "本地预检失败不得进入可能收费的人工找回状态");

const legacyReferenceJob = {
  ...recoveryJob,
  id: "generation-legacy-aggregate-reference-preflight-0001",
  mode: "server",
  status: "retry_required",
  providerStatus: "submitting",
  submissionState: "submitting",
  billingRisk: "submission_outcome_unknown",
  providerTaskId: null,
  providerErrorCode: "",
  createdAt: "2026-08-30T09:11:40.432Z",
  desiredAction: "run",
  error: "提交期间连接中断，未取得厂商任务 ID。为防重复计费，已禁止自动重投。",
  target: { targetType: "whiteboard-node", documentId: "board-1", nodeId: "node-1" },
  request: {
    settings: {
      provider: aggregate.provider,
      adapter: aggregate.adapter,
      protocol: aggregate.protocol,
      model: aggregate.model,
      connectionId: aggregate.id,
    },
    referenceMedia: [{ id: "reference-1", name: "参考图.png", mimeType: "image/png", relativePath: "附件/参考图.png" }],
  },
};
const legacyPatch = legacyAggregateReferencePreflightFailurePatch(legacyReferenceJob, { now: Date.parse("2026-08-30T10:00:00.000Z") });
assert.equal(legacyPatch?.status, "failed");
assert.equal(legacyPatch?.submissionState, "not_submitted");
assert.equal(legacyPatch?.safeNoTaskRetry, true);
assert.equal(legacyPatch?.billingRisk, "");
const migratedPublicJob = publicGenerationJob({ ...legacyReferenceJob, ...legacyPatch });
assert.equal(migratedPublicJob.availableActions.safeResubmit, true, "旧版确定未提交的参考图任务必须允许无风险重新生成");
assert.equal(migratedPublicJob.availableActions.confirmedResubmit, false, "确定未提交的旧任务不得继续显示收费风险确认");
assert.deepEqual(mediaGenerationActionPresentation(migratedPublicJob), {
  action: "resume",
  label: "重新生成",
  confirmNewSubmission: false,
  recovery: false,
});
const recoveryNow = Date.parse("2026-08-30T10:00:00.000Z");
const pendingRecovery = aggregateImageRecoveryPolicy({
  ...recoveryJob,
  automaticRecoveryStartedAt: "2026-08-30T10:00:00.000Z",
  aggregateRecoveryAttempts: 1,
}, { now: recoveryNow + 5_000 });
assert.equal(pendingRecovery.expired, false);
assert.ok(Date.parse(pendingRecovery.nextPollAt) > recoveryNow + 5_000);
const expiredRecovery = aggregateImageRecoveryPolicy({
  ...recoveryJob,
  automaticRecoveryStartedAt: "2026-08-30T10:00:00.000Z",
  aggregateRecoveryAttempts: DEFAULT_AGGREGATE_IMAGE_RECOVERY_ATTEMPTS,
}, { now: recoveryNow + 5_000 });
assert.equal(expiredRecovery.expired, true, "达到次数上限后必须停止自动续接并交还人工确认");
assert.equal(expiredRecovery.nextPollAt, "");
const publicRecovery = publicGenerationJob({
  ...recoveryJob,
  id: "generation-aggregate-recovery-contract-0001",
  mode: "server",
  status: "retry_required",
  providerStatus: "reconciling",
  submissionState: "uncertain",
  billingRisk: "submission_outcome_unknown",
  resubmitConfirmationRequired: false,
  nextPollAt: pendingRecovery.nextPollAt,
  target: { targetType: "whiteboard-node", documentId: "board-1", nodeId: "node-1" },
});
assert.equal(publicRecovery.automaticRecoveryInProgress, true);
assert.equal(publicRecovery.availableActions.confirmedResubmit, false, "自动找回期间不得同时开放人工重复提交");

const worker = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
const store = await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(worker, /aggregateImageRecoveryPending[\s\S]{0,1800}AGGREGATE_IMAGE_RECOVERY_PENDING/u);
assert.match(worker, /!openAiImageCliJob\(job\) && !builtInAggregateImageRecoveryJob\(job\)/u, "启动恢复扫描不得把聚合图片任务提前降级为手动找回");
assert.match(store, /builtInAggregateImageRecoveryJob\(job\)[\s\S]{0,160}Boolean\(job\.nextPollAt\)/u, "持久任务扫描必须继续调度聚合图片自动找回");
assert.match(app, /MEDIA_JOB_POLL_STOP_STATUSES\.has\(job\.status\) && job\.automaticRecoveryInProgress !== true/u, "卡片轮询不得在自动找回期间提前停止");

console.log("Shensi aggregate image API profile tests passed");
