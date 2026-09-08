import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-media-receipt-"));
process.env.SHENSI_DATA_ROOT = root;
try {
  const store = await import(`../src/server/generation-job-store.mjs?receipt=${Date.now()}`);
  const operationId = "media-operation-result-receipt-0001";
  const job = await store.createMediaGenerationJob({
    channel: "image",
    submissionId: operationId,
    target: {
      workspaceKind: "project",
      workspacePath: join(root, "workspace"),
      documentId: "whiteboard-1",
      nodeId: "image-card-1",
      targetType: "whiteboard-node",
    },
    request: {
      prompt: "生成一张用于验证回收凭证的图片",
      settings: {
        id: "image-openai-test",
        connectionId: "image-openai-test",
        provider: "OpenAI",
        adapter: "api",
        model: "gpt-image-2",
      },
    },
  });
  assert.equal(job.operationId, operationId);
  assert.equal(job.profileId, "image-openai-test");
  assert.equal(job.cardId, "image-card-1");
  assert.equal(job.resultAssetId, "");

  const completed = await store.updateMediaGenerationJob({
    jobId: job.id,
    patch: {
      status: "complete",
      result: { attachment: { relativePath: "assets/result.png", sha256: "a".repeat(64) } },
    },
  });
  assert.equal(completed.status, "complete");
  const applied = await store.markGenerationJobApplied({
    jobId: job.id,
    resultAssetId: "asset-result-1",
    cardReadback: {
      verified: true,
      generationJobId: job.id,
      documentId: "whiteboard-1",
      resultAssetId: "asset-result-1",
      verifiedAt: new Date().toISOString(),
    },
  });
  assert.equal(applied.resultAssetId, "asset-result-1");
  assert.ok(applied.appliedAt);
} finally {
  await rm(root, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
}

console.log("媒体任务结果资产与卡片回收凭证测试通过");
