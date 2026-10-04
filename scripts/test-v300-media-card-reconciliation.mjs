import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { mediaResultLifecycleStage } from "../src/media-result-lifecycle.js";
import { createWorkspaceStateConflictError, isWorkspaceStateConflict } from "../src/workspace-conflict.js";

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
    markGenerationJobCardApplyPending,
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
  const applying = await markGenerationJobCardApplyPending({ jobId: created.id, state: "applying" });
  assert.equal(applying.cardApplyState, "applying", "白板回写开始时必须持久化 applying 阶段");
  const timedOut = await markGenerationJobCardApplyPending({
    jobId: created.id,
    state: "failed",
    error: "工作区请求超时，请检查磁盘状态后重试；原任务不会重新生成",
  });
  assert.equal(timedOut.cardApplyState, "failed", "白板回写超时必须转为可重试的失败阶段");
  assert.equal(mediaResultLifecycleStage(timedOut), "asset_saved_card_failed");
  const pendingAgain = await markGenerationJobCardApplyPending({ jobId: created.id, state: "pending" });
  assert.equal(pendingAgain.cardApplyState, "pending", "回写重试前必须回到 pending，不得重新提交厂商任务");
  await assert.rejects(
    markGenerationJobApplied({ jobId: created.id, resultAssetId: "asset-1" }),
    (error) => error?.code === "MEDIA_CARD_READBACK_RECEIPT_REQUIRED",
    "白板媒体必须在真实卡片回读成功后才能报告完整完成",
  );
  await assert.rejects(
    markGenerationJobApplied({
      jobId: created.id,
      resultAssetId: "asset-1",
      cardReadback: {
        verified: true,
        workspacePath: join(root, "workspace"),
        documentId: "whiteboard-1",
        nodeId: "card-1",
        generationJobId: "generation-stale-job",
        resultAssetId: "asset-1",
      },
    }),
    (error) => error?.code === "MEDIA_CARD_READBACK_RECEIPT_REQUIRED",
    "陈旧回读必须拒绝应用，不能把别的任务的卡片状态当成当前结果",
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
  assert.equal(isWorkspaceStateConflict(createWorkspaceStateConflictError("409")), true);
  assert.equal(isWorkspaceStateConflict({ statusCode: 409 }), true);
  assert.equal(isWorkspaceStateConflict({ code: "WORKSPACE_REQUEST_TIMEOUT" }), false);
  assert.match(app, /fetchWorkspaceRequest[\s\S]{0,700}WORKSPACE_REQUEST_TIMEOUT/u,
    "白板回写超时必须被归类为本地工作区超时，而不是重新提交厂商任务");
  assert.match(app, /writeWhiteboardGeneration[\s\S]{0,6500}flushWorkspaceSave\(\{ throwOnError: true \}\)/u,
    "白板卡片回写必须等待保存提交，409 冲突才能进入统一恢复路径");
  assert.match(app, /applyCompletedWhiteboardGenerationJob[\s\S]{0,900}markWhiteboardGenerationJobCardApplyPending\(job\.id, "failed"/u,
    "409/超时/陈旧回读异常必须持久化 card-apply 失败状态");
  assert.match(app, /completedWhiteboardApplyRetries[\s\S]{0,1500}for \(const delayMs of \[100, 350, 1_000, 2_500, 5_000, 10_000\]/u,
    "白板回写失败必须有限重试，不能无限卡在正在回写");
  assert.match(app, /verifyWhiteboardGenerationCardReadback/u,
    "前端必须在标记 applied 前重新读取持久工作区并核验卡片");
  assert.match(app, /cardReadback/u, "卡片回读凭证必须随 applied 请求保存");
  console.log("v3.0 媒体结果资产落库、409/超时/陈旧回读与卡片回读闭环测试通过");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(resolved, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
  delete process.env.SHENSI_MACHINE_DATA_ROOT;
}
