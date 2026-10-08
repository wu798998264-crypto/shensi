import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dreaminaFailureDiagnosis } from "../src/dreamina-failure.js";

const videoCliPath = fileURLToPath(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url));
const healthPath = fileURLToPath(new URL("./check-dreamina-profile-health.mjs", import.meta.url));
const appPath = fileURLToPath(new URL("../src/app.js", import.meta.url));
const [videoCli, health, app] = await Promise.all([
  readFile(videoCliPath, "utf8"),
  readFile(healthPath, "utf8"),
  readFile(appPath, "utf8"),
]);

assert.match(videoCli, /referenceUploadTransientFailure/u, "视频 CLI 必须识别参考物上传临时超时");
assert.match(videoCli, /ApplyImageUpload[\s\S]{0,180}context deadline exceeded/u, "必须覆盖已观测的 ApplyImageUpload 超时");
assert.match(videoCli, /runGenerationSubmitCli[\s\S]{0,700}referenceUploadDidNotCreateTask/u, "提交前上传故障必须复用现有有限重试");
assert.match(videoCli, /DREAMINA_REFERENCE_UPLOAD_TRANSIENT/u, "厂商返回的参考上传临时故障必须有稳定错误码");
assert.match(videoCli, /providerRawError/u, "参考物故障必须保留厂商原始报错");
assert.match(videoCli, /referenceMediaRejectedFailure/u, "参考物不合规必须单独分类");
assert.match(app, /providerRawError \|\| current\.error/u, "界面必须优先显示即梦原始报错");

const transient = dreaminaFailureDiagnosis({
  code: "DREAMINA_REFERENCE_UPLOAD_TRANSIENT",
  message: 'upload resource "reference.png": ApplyImageUpload: context deadline exceeded',
});
assert.equal(transient.category, "reference_upload_transient");
assert.equal(transient.requiresAccountVerification, false);
assert.equal(transient.retryable, true);
assert.match(transient.resolution, /有限次数重试/u);

const submitted = dreaminaFailureDiagnosis({
  code: "DREAMINA_REFERENCE_UPLOAD_TRANSIENT",
  message: "ApplyImageUpload: context deadline exceeded",
  providerTaskId: "provider-task-1",
});
assert.match(submitted.resolution, /禁止重新提交/u);
assert.doesNotMatch(submitted.resolution, /核验/u, "参考上传临时故障不得伪装成账号核验");

const invalid = dreaminaFailureDiagnosis({
  code: "DREAMINA_REFERENCE_INVALID",
  message: "reference image dimensions are not supported: width must be between 512 and 4096",
});
assert.equal(invalid.category, "reference_invalid");
assert.match(invalid.resolution, /原始报错/u);

const invalidSubmitted = dreaminaFailureDiagnosis({
  code: "DREAMINA_REFERENCE_INVALID",
  message: "reference video duration exceeds the allowed limit",
  providerTaskId: "provider-task-2",
});
assert.match(invalidSubmitted.resolution, /保留原厂商任务编号/u);
assert.match(invalidSubmitted.resolution, /不要重新提交同一任务/u);

assert.match(health, /SHENSI_DREAMINA_HEALTH_TIMEOUT_MS/u, "健康检查必须支持总超时");
assert.match(health, /DREAMINA_HEALTH_CHECK_TIMEOUT/u, "健康检查超时必须返回稳定错误码");

console.log("Dreamina reference-upload transient classification and bounded health checks passed");
