import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dreaminaQueueView } from "../src/dreamina-task-queue.js";
import { dreaminaFailureDiagnosis } from "../src/dreamina-failure.js";

const sources = await Promise.all([
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
]);

for (const source of sources) {
  const activeStatus = source.indexOf("const activeStatuses =");
  const queueHint = source.indexOf(
    'if ((queue.position !== null && queue.position > 0) || /queue|wait|排队/',
  );
  assert.ok(activeStatus >= 0, "即梦 CLI 必须识别明确的生成中状态");
  assert.ok(queueHint >= 0, "即梦 CLI 必须保留队列提示解析");
  assert.ok(activeStatus < queueHint, "明确 Generating/Running 状态必须优先于 queue_position");
  assert.match(source, /const queueStatus = String\(queue\.status/u, "即梦 CLI 必须读取 queue_status");
  assert.match(source, /activeStatuses\.includes\(queueStatus\)/u, "queue_status=Generating 必须显示为生成中");
}
assert.match(sources[0], /providerTaskId = dreaminaImageGenerationCommand/u, "图片提交异常也必须保留厂商任务 ID");
assert.match(sources[0], /switch to read-only polling/u, "图片任务带任务 ID 时必须转为只读续查");
assert.match(sources[0], /submit_id: providerTaskId/u, "图片桥接回执必须把任务 ID 作为 submit_id 交给提交层");
for (const source of sources) {
  assert.match(source, /queryAuthFailureIsFinal/u, "即梦查询遇到明确核验失败时不得再追加 list_task 长超时");
  assert.match(source, /if \(queryAuthFailureIsFinal\(error\)(?:\s*\|\|\s*dreaminaControlPlaneFailureIsTransient\(error\))?\)\s*\{/u, "明确核验失败和查询暂态故障必须立即返回给续查 worker");
}

const generating = dreaminaQueueView({
  id: "generation-status-1",
  mode: "server",
  channel: "image",
  status: "queued",
  submissionState: "not_submitted",
  dreaminaQueuePolicy: "command-lease-v1",
  providerStatus: "queued",
  providerQueueStatus: "Generating",
  providerQueuePosition: 1,
  providerQueueLength: 1,
  request: { settings: { adapter: "cli", provider: "即梦", model: "seedream" } },
  createdAt: new Date().toISOString(),
});
assert.equal(generating.queueStage, "厂商生成中", "queue_position=1 + Generating 必须归类为厂商生成中");
assert.equal(generating.queuePosition, 0, "厂商已生成时不再显示本地排队序号");
assert.equal(generating.queueTone, "green", "厂商生成中的任务应显示正常绿色边缘");

const completedReadbackPending = dreaminaQueueView({
  ...generating,
  status: "complete",
  providerStatus: "completed",
  providerQueueStatus: "",
  result: { attachment: { relativePath: "whiteboard-media/a.png", sha256: "sha", mimeType: "image/png" } },
});
assert.equal(completedReadbackPending.queueTone, "green", "已验收下载结果但尚未回写时不能误报红色失败");
assert.equal(completedReadbackPending.queueStage, "结果已生成，正在回写卡片");

const taskScopedAuth = dreaminaFailureDiagnosis({
  code: "DREAMINA_AUTH_REQUIRED",
  message: "即梦任务资源会话未登录",
  providerTaskId: "provider-task-123",
  submissionState: "submitted",
});
assert.equal(taskScopedAuth.code, "DREAMINA_PROVIDER_TASK_AUTH_FAILURE");
assert.equal(taskScopedAuth.requiresAccountVerification, false, "已有厂商任务 ID 的 authsdk 错误不得污染账号核验状态");

console.log("dreamina status classification: ok");
