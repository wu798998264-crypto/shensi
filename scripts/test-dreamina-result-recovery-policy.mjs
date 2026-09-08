import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  dreaminaResultRecoveryPolicy,
} from "../src/dreamina-result-recovery-policy.js";

const startedAt = "2026-09-01T00:00:00.000Z";
const pending = dreaminaResultRecoveryPolicy({
  job: { resultRecoveryStartedAt: startedAt, resultRecoveryAttempts: 2 },
  errorCode: "DREAMINA_RESULT_PENDING",
  message: "任务已完成，但未返回可下载文件",
  nowMs: Date.parse("2026-09-01T00:02:00.000Z"),
  windowMs: 15 * 60 * 1000,
  maxAttempts: 180,
});
assert.equal(pending.applies, true);
assert.equal(pending.expired, false);
assert.equal(pending.attempts, 3);

const expired = dreaminaResultRecoveryPolicy({
  job: { resultRecoveryStartedAt: startedAt, resultRecoveryAttempts: 20 },
  errorCode: "DREAMINA_RESULT_PENDING",
  message: "任务已完成，但未返回可下载文件",
  nowMs: Date.parse("2026-09-01T00:16:00.000Z"),
  windowMs: 15 * 60 * 1000,
});
assert.equal(expired.applies, true);
assert.equal(expired.expired, true);

assert.equal(dreaminaResultRecoveryPolicy({
  job: {},
  errorCode: "DREAMINA_QUERY_TRANSIENT",
  message: "网络暂时不可用",
}).applies, false, "普通查询抖动不能误判为结果找回超时");

const [app, worker, imageCli, videoCli] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
]);

const composerGate = app.indexOf("await ensureDreaminaGenerationAccountAvailable(settings, { channel })");
const composerPlaceholder = app.lastIndexOf("taskMessages.push(userMessage", composerGate);
const composerBillingSubmit = app.indexOf("createWhiteboardMediaGenerationJob", composerGate);
assert.ok(composerPlaceholder > 0 && composerPlaceholder < composerGate,
  "对话图片/视频必须先显示准备中任务卡，再异步完成即梦核验");
assert.ok(composerBillingSubmit > composerGate,
  "即梦核验完成前仍不得提交可能收费的厂商任务");
assert.match(app, /queueDocumentArtifactJobs[\s\S]{0,1800}ensureDreaminaGenerationAccountAvailable\(imageSettings, \{ channel: "image" \}\)/u,
  "文档配图必须在批量创建任务前完成即梦核验");
assert.match(app, /provider_complete_retrieving[\s\S]{0,240}mediaGenerationErrorText\(current\)/u,
  "结果取回期间必须显示真实错误原因，不能只显示正在生成");
assert.match(app, /promptDreaminaReverificationForJob[\s\S]{0,1400}errorMessage: mediaGenerationErrorText\(job\)/u,
  "核验弹窗必须显示任务保存的结构化错误原因");
assert.match(app, /refreshDreaminaAccountStatus\(\{ verifyLive: true, profileId, channel \}\)/u,
  "每次收费提交前必须执行当前即梦配置的在线状态核对，不能只相信旧缓存");
assert.match(app, /if \(!current\.providerTaskId[\s\S]{0,260}controlMediaGenerationJob\(jobId, "resume"\)/u,
  "核验成功后只能自动续接已有厂商任务 ID 的原任务");
assert.match(app, /await resumeDreaminaJobsAfterVerification\(profileId\)/u,
  "账号核验完成后必须恢复等待中的原厂商任务");
assert.match(worker, /dreaminaResultRecoveryPolicy/u);
assert.match(worker, /status: "retry_required"[\s\S]{0,260}providerErrorCode: "DREAMINA_RESULT_PENDING"/u,
  "结果自动取回超过安全时限后必须停止活动状态");
assert.match(worker, /找回结果[\s\S]{0,120}不会重新提交或重复扣费/u,
  "超时后的处理建议必须统一显示找回结果且不重复收费");
assert.match(imageCli, /DREAMINA_RESULT_PENDING/u);
assert.match(videoCli, /DREAMINA_RESULT_PENDING/u);

console.log("Dreamina result recovery and cross-surface gate checks passed");
