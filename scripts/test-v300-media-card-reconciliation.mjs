import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { mediaResultLifecycleStage } from "../src/media-result-lifecycle.js";

assert.equal(mediaResultLifecycleStage({ status: "polling", providerStatus: "running" }), "provider_running");
assert.equal(mediaResultLifecycleStage({ status: "downloading", providerStatus: "completed" }), "provider_complete_retrieving");
assert.equal(mediaResultLifecycleStage({ status: "complete", providerStatus: "completed", landingReceipt: { sha256: "a" } }), "asset_saved_card_pending");
assert.equal(mediaResultLifecycleStage({
  status: "complete",
  providerStatus: "completed",
  landingReceipt: { sha256: "a" },
  appliedAt: "2026-08-24T01:00:00.000Z",
  cardReadbackVerified: true,
}), "card_complete");

const root = await mkdtemp(join(tmpdir(), "shensi-v300-card-reconcile-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

try {
  const {
    createMediaGenerationJob,
    markGenerationJobApplied,
    updateMediaGenerationJob,
  } = await import(`../src/server/generation-job-store.mjs?v300=${Date.now()}`);
  const created = await createMediaGenerationJob({
    channel: "image",
    target: {
      workspaceKind: "project",
      workspacePath: join(root, "workspace"),
      documentId: "whiteboard-1",
      nodeId: "card-1",
      targetType: "whiteboard-node",
    },
    request: {
      prompt: "雨中的灯塔",
      settings: { id: "dreamina-a", provider: "即梦", adapter: "cli", model: "5.0", dreaminaCliProfile: "a" },
    },
    submissionId: "submission-v300-card-reconcile-0001",
  });
  const completed = await updateMediaGenerationJob({
    jobId: created.id,
    patch: {
      status: "complete",
      providerStatus: "completed",
      providerTaskId: "provider-task-1",
      providerTerminalAt: "2026-08-24T00:59:00.000Z",
      assetSavedAt: "2026-08-24T01:00:00.000Z",
      landingReceipt: { relativePath: "assets/result.png", sha256: "a".repeat(64), mimeType: "image/png" },
      result: { attachment: { relativePath: "assets/result.png", sha256: "a".repeat(64), mimeType: "image/png" } },
    },
  });
  assert.equal(mediaResultLifecycleStage(completed), "asset_saved_card_pending");
  await assert.rejects(
    markGenerationJobApplied({ jobId: created.id, resultAssetId: "asset-1" }),
    (error) => error?.code === "MEDIA_CARD_READBACK_RECEIPT_REQUIRED",
    "白板媒体必须在真实卡片回读成功后才能报告完整完成",
  );
  const applied = await markGenerationJobApplied({
    jobId: created.id,
    resultAssetId: "asset-1",
    cardReadback: {
      verified: true,
      workspacePath: join(root, "workspace"),
      documentId: "whiteboard-1",
      nodeId: "card-1",
      generationJobId: created.id,
      resultAssetId: "asset-1",
      verifiedAt: "2026-08-24T01:00:01.000Z",
    },
  });
  assert.equal(applied.cardReadbackVerified, true);
  assert.equal(applied.resultAssetId, "asset-1");
  assert.equal(applied.providerTaskId, "provider-task-1", "回填卡片不得丢失原厂商任务 ID");
  assert.equal(mediaResultLifecycleStage(applied), "card_complete");

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /verifyWhiteboardGenerationCardReadback/u,
    "前端必须在标记 applied 前重新读取持久工作区并核验卡片");
  assert.match(app, /cardReadback/u, "卡片回读凭证必须随 applied 请求保存");
  console.log("v3.0 媒体结果资产落库与卡片回读闭环测试通过");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(resolved, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
  delete process.env.SHENSI_MACHINE_DATA_ROOT;
}
