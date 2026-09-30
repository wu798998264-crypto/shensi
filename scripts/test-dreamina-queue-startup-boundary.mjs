import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueTaskMarkup } from "../src/dreamina-queue-panel.js";

const root = await mkdtemp(join(tmpdir(), "shensi-dreamina-startup-boundary-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;
const store = await import("../src/server/generation-job-store.mjs");
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const target = (id) => ({ workspaceKind: "project", workspacePath: root, documentId: "startup-boundary", nodeId: id });
const create = (id) => store.createMediaGenerationJob({
  channel: "image",
  target: target(id),
  request: {
    prompt: "启动边界回归测试，不调用厂商",
    aspectRatio: "1:1",
    imageCount: 1,
    settings: {
      id,
      connectionId: id,
      provider: "即梦",
      adapter: "cli",
      model: "5.0",
      dreaminaCliProfile: id,
    },
  },
});

try {
  const historicalA = await create("historical-a");
  const historicalB = await create("historical-b");
  await store.reorderDreaminaQueue({ jobIds: [historicalB.id, historicalA.id] });

  await wait(20);
  const startupBoundary = new Date().toISOString();
  await wait(20);
  const fresh = await create("fresh-after-restart");
  const fenced = await store.deferDreaminaQueueForStartup({ before: startupBoundary });
  assert.equal(fenced.deferred, 2, "启动边界只应暂停重启前未提交的本地任务");
  assert.equal((await store.getGenerationJob({ jobId: historicalA.id })).dreaminaQueueDeferredReason, "server_restart");
  assert.equal((await store.getGenerationJob({ jobId: historicalB.id })).providerTaskId, null, "历史任务不得被改写厂商任务 ID");
  assert.equal((await store.getGenerationJob({ jobId: fresh.id })).dreaminaQueueDeferredAt || "", "", "启动期间新建任务不得被历史 fence 暂停");
  const freshToken = await store.claimDreaminaQueueTurn({ jobId: fresh.id });
  assert.ok(freshToken, "重启后的新任务必须越过暂停历史队首并取得本地调度轮次");
  assert.equal(await store.claimDreaminaQueueTurn({ jobId: historicalB.id }), "", "暂停历史任务不得抢占新任务轮次");
  await store.releaseDreaminaQueueTurn({ jobId: fresh.id, token: freshToken });
  const pausedViews = await store.listDreaminaQueueJobs();
  assert.deepEqual(pausedViews.map((job) => job.id), [historicalB.id, historicalA.id, fresh.id], "暂停不得改写持久化顺序");
  assert.equal(pausedViews.find((job) => job.id === historicalB.id).queueState, "queued_paused");
  assert.equal(pausedViews.find((job) => job.id === historicalB.id).queueTone, "blue");
  assert.equal(pausedViews.find((job) => job.id === fresh.id).queuePosition, 1);
  assert.match(queueTaskMarkup(pausedViews.find((job) => job.id === historicalB.id)), /取消排队/u);
  const reorderedWithPaused = await store.reorderDreaminaQueue({ jobIds: [fresh.id] });
  assert.deepEqual(reorderedWithPaused.map((job) => job.id), [historicalB.id, historicalA.id, fresh.id], "调整活动任务时不得丢失重启暂停任务的持久化顺序");
  // The application invokes this automatically during startup; the queue
  // dialog has no manual resume control.
  const resumed = await store.resumeDeferredDreaminaQueue();
  assert.equal(resumed.resumed, 2, "启动恢复必须自动解除全部暂停历史任务");
  assert.equal((await store.getGenerationJob({ jobId: historicalA.id })).dreaminaQueueDeferredAt, "");
  const activeViews = await store.listDreaminaQueueJobs();
  assert.deepEqual(activeViews.map((job) => job.id), [historicalB.id, historicalA.id, fresh.id], "自动恢复必须保留原持久化顺序");
  assert.equal(activeViews.find((job) => job.id === historicalB.id).queuePosition, 1);

  const submitted = await create("already-submitted");
  await store.updateMediaGenerationJob({ jobId: submitted.id, patch: {
    status: "polling",
    submissionState: "submitted",
    providerTaskId: "provider-task-preserved",
  } });
  const secondFence = await store.deferDreaminaQueueForStartup();
  assert.equal(secondFence.deferred, 3, "再次启动只应暂停仍未提交的排队任务，已提交记录不参与");
  const submittedAfter = await store.getGenerationJob({ jobId: submitted.id });
  assert.equal(submittedAfter.dreaminaQueueDeferredAt || "", "", "已有厂商任务 ID 的记录不得增加启动暂停标记");
  assert.equal(submittedAfter.providerTaskId, "provider-task-preserved");
  console.log("Dreamina queue startup boundary regression passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
