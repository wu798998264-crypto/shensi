import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-dreamina-broker-lease-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

try {
  const identityStore = await import(`../src/server/dreamina-profile-identity-store.mjs?lease=${Date.now()}`);
  const leaseStore = await import(`../src/server/dreamina-broker-lease.mjs?lease=${Date.now()}`);
  const jobs = await import(`../src/server/generation-job-store.mjs?lease=${Date.now()}`);

  await identityStore.saveDreaminaProfileIdentity({ profileId: "account-a", expectedUserId: "user-a", verifiedUserId: "user-a" });
  await identityStore.saveDreaminaProfileIdentity({ profileId: "account-b", expectedUserId: "user-b", verifiedUserId: "user-b" });
  await identityStore.saveDreaminaProfileIdentity({ profileId: "account-a-alias", expectedUserId: "user-a", verifiedUserId: "user-a" });

  const target = (nodeId) => ({
    workspaceKind: "project",
    workspacePath: join(root, "workspace"),
    documentId: "broker-lease-board",
    nodeId,
    targetType: "whiteboard-node",
  });
  const request = (profileId) => ({
    prompt: "物理凭证租约测试，不调用厂商",
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

  await leaseStore.writeDreaminaBrokerLease({
    profileId: "account-a",
    token: "live-a",
    pid: process.pid,
    jobId: "generation-live-a",
    channel: "image",
    command: "text2image",
    acquiredAt: new Date().toISOString(),
  });
  await assert.rejects(
    jobs.createMediaGenerationJob({ channel: "image", target: target("blocked-b"), request: request("account-b") }),
    (error) => error?.code === "DREAMINA_PROFILE_SWITCH_BLOCKED"
      && error?.details?.activeProfileId === "account-a"
      && error?.details?.reason === "physical_credential_slot_busy",
    "其他真实账号占用物理凭证槽时必须在创建任务前明确失败",
  );

  const alias = await jobs.createMediaGenerationJob({
    channel: "image",
    target: target("same-account-alias"),
    request: request("account-a-alias"),
  });
  assert.equal(alias.status, "queued", "同一真实账号的配置别名不得被物理租约误拦");

  await leaseStore.clearDreaminaBrokerLease("live-a");
  await jobs.updateMediaGenerationJob({
    jobId: alias.id,
    patch: {
      status: "failed",
      providerStatus: "failed",
      providerErrorCode: "TEST_TERMINAL_FAILURE",
      error: "测试明确终态",
      failedAt: new Date().toISOString(),
    },
  });
  const other = await jobs.createMediaGenerationJob({
    channel: "image",
    target: target("released-b"),
    request: request("account-b"),
  });
  assert.equal(other.status, "queued", "物理租约释放后其他账号应立即可创建任务");

  await leaseStore.writeDreaminaBrokerLease({
    profileId: "account-a",
    token: "stale-a",
    pid: 2_147_483_647,
    acquiredAt: new Date().toISOString(),
  });
  assert.equal(await leaseStore.readDreaminaBrokerLease(), null, "死亡进程留下的物理租约必须自动清除");

  const jobFiles = await readdir(join(root, "generation-jobs"));
  assert.equal(jobFiles.filter((name) => name.endsWith(".json")).length, 2, "被物理锁拒绝的请求不得创建本地排队任务");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /providerErrorCode \|\| ""\)\.toUpperCase\(\) === "DREAMINA_PROFILE_SWITCH_BLOCKED"[\s\S]{0,1400}openDreaminaProfileLockDialog/u, "worker 提交前发生物理锁竞态时也必须弹出占用窗口");
  assert.match(app, /const promptDreaminaSubmissionBlockForJob = \(job, \{ allowLockDialog = true \} = \{\}\)/u, "实时锁冲突必须默认允许弹出占用窗口");
  assert.match(app, /if \(!allowLockDialog\) return false;[\s\S]{0,700}openDreaminaProfileLockDialog/u, "启动恢复必须能仅恢复任务状态而不重放历史锁弹窗");
  assert.match(app, /showInterruptedConversationMediaJob\(job, \{ allowLockDialog: false \}\)/u, "启动恢复对话媒体任务时不得重放历史锁弹窗");
  assert.match(app, /showInterruptedDocumentArtifactJob\(job, \{ allowLockDialog: false \}\)/u, "启动恢复文档媒体任务时不得重放历史锁弹窗");
  assert.match(app, /showInterruptedWhiteboardGenerationJob\(job, \{ allowLockDialog: false \}\)/u, "启动恢复白板媒体任务时不得重放历史锁弹窗");
  console.log("Dreamina broker lease conflict tests passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()), "只允许清理本测试创建的临时目录");
  await rm(resolved, { recursive: true, force: true });
}
