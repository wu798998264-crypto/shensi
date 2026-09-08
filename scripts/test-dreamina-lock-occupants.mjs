import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-dreamina-lock-occupants-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

const {
  createMediaGenerationJob,
  forceReleaseDreaminaJob,
  listDreaminaProfileBlockingJobs,
  listMediaGenerationJobsForWorker,
  updateMediaGenerationJob,
} = await import("../src/server/generation-job-store.mjs");

const target = (nodeId) => ({
  workspaceKind: "project",
  workspacePath: root,
  documentId: "temporary-lock-test",
  nodeId,
  targetType: "whiteboard-node",
});
const request = ({ channel = "image", profileId = "account-a", provider = "即梦", adapter = "cli" } = {}) => ({
  prompt: "临时锁占用测试，不调用厂商生成",
  aspectRatio: "1:1",
  quality: "1k",
  imageCount: 1,
  settings: {
    id: `${channel}-${profileId}`,
    connectionId: `${channel}-${profileId}`,
    provider,
    adapter,
    protocol: channel === "video" ? "videos" : "images",
    model: channel === "video" ? "seedance2.5" : "5.0",
    dreaminaCliProfile: provider === "即梦" ? profileId : "",
  },
});

try {
  const first = await createMediaGenerationJob({ channel: "image", target: target("card-a"), request: request() });
  const second = await createMediaGenerationJob({ channel: "video", target: target("card-b"), request: request({ channel: "video" }) });
  const unrelated = await createMediaGenerationJob({
    channel: "image",
    target: target("card-c"),
    request: request({ provider: "OpenAI", adapter: "api", profileId: "" }),
  });
  const completed = await createMediaGenerationJob({ channel: "image", target: target("card-d"), request: request() });
  await updateMediaGenerationJob({
    jobId: first.id,
    patch: {
      providerTaskId: "dreamina-provider-task-1",
      providerStatus: "running",
      submissionState: "submitted",
      result: { attachment: { relativePath: "assets/kept-result.png", sha256: "a".repeat(64) } },
    },
  });
  await updateMediaGenerationJob({ jobId: completed.id, patch: { status: "complete", providerStatus: "completed" } });
  const forcePendingAt = new Date().toISOString();
  await updateMediaGenerationJob({
    jobId: second.id,
    patch: {
      forceReleasePendingAt: forcePendingAt,
      desiredAction: "cancel",
      userStoppedAt: forcePendingAt,
      resultSuppressed: true,
    },
  });

  const initial = await listDreaminaProfileBlockingJobs();
  assert.deepEqual(new Set(initial.map((job) => job.id)), new Set([first.id, second.id]), "列表只应显示仍占用即梦锁的任务");
  assert.equal(initial.find((job) => job.id === first.id)?.providerTaskId, "dreamina-provider-task-1");
  const workerJobs = await listMediaGenerationJobsForWorker();
  assert.equal(workerJobs.some((job) => job.id === second.id), false, "强制解除处理中不得被 watchdog 再次调度");

  const released = await forceReleaseDreaminaJob({ jobId: first.id });
  assert.equal(released.status, "cancelled");
  assert.equal(released.providerStatus, "cancel_unconfirmed", "有厂商任务 ID 时不得伪造远端已取消");
  assert.equal(released.result.attachment.relativePath, "assets/kept-result.png", "强制解除不得删除已生成结果记录");
  assert.equal(released.request.prompt, "临时锁占用测试，不调用厂商生成", "强制解除不得删除提示词");

  const after = await listDreaminaProfileBlockingJobs();
  assert.deepEqual(after.map((job) => job.id), [second.id], "单条强制解除后其他占用任务仍应保留");
  await assert.rejects(
    forceReleaseDreaminaJob({ jobId: first.id }),
    (error) => error?.code === "DREAMINA_PROFILE_NOT_HELD",
    "已解除的任务不得重复标记为占用");
  assert.equal(unrelated.status, "queued");

  const [server, manager, app] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/server/media-worker-manager.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(server, /verifyDreaminaCredentialSlot[\s\S]{0,2600}forceReleaseDreaminaJob/u, "锁探针必须先于任务终态写入");
  assert.match(manager, /const candidates = \[\];[\s\S]{0,1200}findWindowsWorkerPid\(normalizedJobId\)/u, "服务重启后必须重新扫描 worker");
  const lockDialog = app.slice(app.indexOf('id="dreaminaProfileLockDialog"'), app.indexOf('id="dreaminaLockOccupantsDialog"'));
  assert.match(lockDialog, /查看占用任务/u);
  assert.doesNotMatch(lockDialog, /强制解除占用/u, "底部锁提示只能进入占用任务页面，不直接显示强制操作");

  console.log("Dreamina lock occupant list and force-release invariants passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()), "只允许清理本测试创建的临时目录");
  await rm(resolved, { recursive: true, force: true });
}
