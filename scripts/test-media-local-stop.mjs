import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = await mkdtemp(join(tmpdir(), "shensi-local-stop-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;
const store = await import("../src/server/generation-job-store.mjs");
const { stopLocalMediaJob } = await import("../src/server/media-local-stop.mjs");
const { recordMediaWorkerFailure } = await import("../src/server/media-worker-manager.mjs");
const { mediaRecoveryJobBlocksOperation } = await import("../src/media-generation-coordination.js");
let counter = 0;
const create = (provider = "LibTV", targetType = "whiteboard-node") => store.createMediaGenerationJob({
  channel: "video", target: { workspaceKind: "notebook", workspacePath: root, documentId: "doc", nodeId: `node-${counter++}`, targetType, conversationId: "conversation", messageId: `message-${counter}` },
  request: { prompt: "fixture prompt", settings: { id: "test", provider, adapter: "cli", model: "fixture", dreaminaCliProfile: "test-profile" } },
});
try {
  for (const provider of ["LibTV", "即梦"]) for (const targetType of ["whiteboard-node", "conversation-message"]) {
    const job = await create(provider, targetType);
    await store.updateMediaGenerationJob({ jobId: job.id, patch: { status: "retry_required", submissionState: "uncertain", error: "CLI 原始错误", providerErrorCode: "CLI_FAILURE", billingRisk: "submission_outcome_unknown" } });
    const stopped = await stopLocalMediaJob({ jobId: job.id }, {
      terminate: async () => {
        assert.equal((await store.listMediaGenerationJobsForWorker()).some((item) => item.id === job.id), false, "杀进程前必须先持久化停止意图");
        return { verified: false, alreadyExited: true };
      }, probe: async () => ({ released: true }),
    });
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.providerStatus, "cancel_unconfirmed", "没有任务号也不能把不确定提交误报为未提交");
    assert.equal(stopped.lastProviderError.message, "CLI 原始错误");
    assert.equal(stopped.request.prompt, "fixture prompt");
    assert.equal(mediaRecoveryJobBlocksOperation(stopped), false);
    assert.equal((await store.listMediaGenerationJobsForWorker()).some((item) => item.id === job.id), false);
    await stopLocalMediaJob({ jobId: job.id }, { terminate: async () => { throw new Error("不得重复杀进程"); } });
  }
  const blocked = await create("即梦");
  const scanWarning = await stopLocalMediaJob({ jobId: blocked.id }, {
    terminate: async () => ({ verified: false, scanError: "进程查询失败" }),
    probe: async () => { throw new Error("不应伪造进程已经退出"); },
  });
  assert.equal(scanWarning.status, "cancelled");
  assert.equal(scanWarning.resultSuppressed, true);
  assert.match(scanWarning.localStopWarning, /进程查询失败/);
  assert.equal(mediaRecoveryJobBlocksOperation(scanWarning), false, "终止诊断失败不得重新占用待处理列表");
  const blockedPhysicalSlot = await create("即梦");
  const slotWarning = await stopLocalMediaJob({ jobId: blockedPhysicalSlot.id }, {
    terminate: async () => ({ verified: false }), probe: async () => ({ released: false, error: "真实凭证槽仍忙" }),
  });
  assert.equal(slotWarning.status, "cancelled");
  assert.equal(slotWarning.physicalCredentialSlotReleased, false);
  assert.match(slotWarning.localStopWarning, /真实凭证槽仍忙/);
  assert.equal(mediaRecoveryJobBlocksOperation(slotWarning), false, "彻底终止后本地锁必须立即释放；物理槽异常由下一条命令有限重试");
  const document = await store.createClientGenerationJob({ channel: "text", target: { workspacePath: root, documentId: "doc", nodeId: "text" } });
  await assert.rejects(stopLocalMediaJob({ jobId: document.id }), /只能终止媒体任务/);
  assert.equal((await store.getGenerationJob({ jobId: document.id })).status, "running", "文档任务必须保持隔离");
  const crashed = await create();
  await store.updateMediaGenerationJob({ jobId: crashed.id, patch: { status: "submitting", submissionState: "submitting", workerPid: 123 } });
  await recordMediaWorkerFailure({ jobId: crashed.id, workerPid: 999, detail: "旧进程报错" });
  assert.equal((await store.getGenerationJob({ jobId: crashed.id })).status, "submitting", "旧进程退出不得覆盖新进程状态");
  await recordMediaWorkerFailure({ jobId: crashed.id, workerPid: 123, detail: "真实进程崩溃原因" });
  const crash = await store.getGenerationJob({ jobId: crashed.id });
  assert.equal(crash.status, "retry_required");
  assert.equal(crash.connectionRetryExhausted, true);
  assert.match(crash.error, /真实进程崩溃原因/);
  const earlyPending = await create();
  await store.updateMediaGenerationJob({ jobId: earlyPending.id, patch: { status: "waiting_credentials", createdAt: "2020-01-01T00:00:00.000Z" } });
  for (let i = 0; i < 102; i++) await store.createClientGenerationJob({ channel: "text", target: { workspacePath: root, documentId: "doc", nodeId: `new-${i}` } });
  assert.ok((await store.listGenerationJobs({ pendingMediaOnly: true })).some((job) => job.id === earlyPending.id), "旧阻塞任务不得被最近100条记录截断隐藏");
  console.log("Media local stop: both entry points, durable fence, restart, truthful cancellation and >100-record visibility passed");
} finally { await rm(root, { recursive: true, force: true }); }
