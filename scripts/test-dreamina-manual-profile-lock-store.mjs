import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-dreamina-lock-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

const {
  createMediaGenerationJob,
  finalizeMediaGenerationCancellation,
  markGenerationJobApplied,
  mediaGenerationCancellationFinalizationExpired,
  requestMediaGenerationCancel,
  updateMediaGenerationJob,
} = await import("../src/server/generation-job-store.mjs");

const request = (profileId) => ({
  prompt: "一只站在雨中的猫",
  aspectRatio: "1:1",
  quality: "2k",
  imageCount: 1,
  settings: {
    id: `image-${profileId}`,
    connectionId: `image-${profileId}`,
    provider: "即梦",
    adapter: "cli",
    protocol: "images",
    model: "5.0",
    dreaminaCliProfile: profileId,
  },
});
const target = (nodeId) => ({ workspaceKind: "project", workspacePath: root, documentId: "doc-1", nodeId });
const completeAndApply = async (job) => {
  await updateMediaGenerationJob({
    jobId: job.id,
    patch: {
      status: "complete",
      result: { attachment: { relativePath: `assets/${job.id}.png`, sha256: "a".repeat(64) } },
    },
  });
  await markGenerationJobApplied({
    jobId: job.id,
    resultAssetId: `asset-${job.id}`,
    cardReadback: {
      verified: true,
      workspacePath: job.target.workspacePath,
      documentId: job.target.documentId,
      nodeId: job.target.nodeId,
      generationJobId: job.id,
      resultAssetId: `asset-${job.id}`,
      verifiedAt: new Date().toISOString(),
    },
  });
};

try {
  const first = await createMediaGenerationJob({ channel: "image", target: target("card-a"), request: request("account-a") });
  const sameProfile = await createMediaGenerationJob({ channel: "image", target: target("card-b"), request: request("account-a") });
  assert.notEqual(first.id, sameProfile.id, "同一配置在不同卡片应创建两条串行任务");

  await assert.rejects(
    createMediaGenerationJob({ channel: "image", target: target("card-c"), request: request("account-b") }),
    (error) => error?.code === "DREAMINA_PROFILE_SWITCH_BLOCKED" && error?.statusCode === 409,
  );

  await completeAndApply(first);
  await completeAndApply(sameProfile);
  const switched = await createMediaGenerationJob({ channel: "image", target: target("card-c"), request: request("account-b") });
  assert.equal(switched.request.settings.dreaminaCliProfile, "account-b");

  const cancelled = await createMediaGenerationJob({ channel: "image", target: target("card-d"), request: request("account-b") });
  await updateMediaGenerationJob({
    jobId: cancelled.id,
    patch: {
      status: "polling",
      providerStatus: "running",
      providerTaskId: "cancel-verification-0001",
      submissionState: "submitted",
    },
  });
  const cancelPending = await requestMediaGenerationCancel({ jobId: cancelled.id });
  assert.equal(mediaGenerationCancellationFinalizationExpired(cancelPending, {
    nowMs: Date.parse(cancelPending.cancelRequestedAt) + 31 * 60_000,
  }), true, "厂商取消回执长期缺失时必须触发自动终结窗口");
  const terminalized = await finalizeMediaGenerationCancellation({ jobId: cancelled.id, force: true, reason: "test_force_stop" });
  assert.equal(terminalized.status, "cancelled", "用户强制终结后本地任务必须收敛为终态");
  assert.equal(terminalized.providerStatus, "cancel_unconfirmed", "未获厂商回执时不得伪造厂商已取消");
  assert.equal(terminalized.cancelOutcome, "local_terminalized_unconfirmed");
  console.log("即梦持久队列同配置排队与跨配置切换门禁测试通过");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()), "只允许清理本测试创建的临时目录");
  await rm(resolved, { recursive: true, force: true });
}
