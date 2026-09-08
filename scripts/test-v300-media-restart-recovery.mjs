import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-v300-media-restart-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

try {
  const store = await import(`../src/server/generation-job-store.mjs?restart=${Date.now()}`);
  const created = await store.createMediaGenerationJob({
    channel: "video",
    target: {
      workspaceKind: "project",
      workspacePath: join(root, "workspace"),
      documentId: "board-1",
      nodeId: "card-1",
      targetType: "whiteboard-node",
    },
    request: {
      prompt: "短片",
      duration: 4,
      resolution: "720p",
      settings: { id: "dreamina-a", provider: "即梦", adapter: "cli", model: "seedance2.5", dreaminaCliProfile: "a" },
    },
    submissionId: "submission-v300-restart-recovery-0001",
  });
  await store.updateMediaGenerationJob({
    jobId: created.id,
    patch: {
      status: "complete",
      providerStatus: "completed",
      providerTaskId: "provider-restart-1",
      result: { attachment: { relativePath: "assets/recovered.mp4", sha256: "b".repeat(64), mimeType: "video/mp4" } },
      landingReceipt: { relativePath: "assets/recovered.mp4", sha256: "b".repeat(64), mimeType: "video/mp4" },
    },
  });
  const visibleAfterRestart = await store.listGenerationJobs({ workspacePath: join(root, "workspace") });
  assert.equal(visibleAfterRestart.length, 1, "未回填卡片的完成任务在重启后必须保留给前端恢复，不得重新提交");
  assert.equal(visibleAfterRestart[0].providerTaskId, "provider-restart-1");
  assert.equal(visibleAfterRestart[0].status, "complete");

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /if \(job\.status === "complete"\) \{[\s\S]{0,450}applyCompletedWhiteboardGenerationJob/u,
    "启动恢复必须继续完成既有资产到目标卡片的回填，而不是发起新生成");
  assert.match(app, /fetchMediaRecoveryJobs/u, "启动恢复必须从持久任务账本读取已有任务");
  console.log("v3.0 媒体重启后卡片回填恢复测试通过");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(resolved, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
  delete process.env.SHENSI_MACHINE_DATA_ROOT;
}
