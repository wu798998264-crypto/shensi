import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  dreaminaJobRequiresCredentialProfile,
  dreaminaProfileSwitchDecision,
} from "../src/dreamina-manual-profile-policy.js";

const job = ({
  profileId = "account-a",
  status = "polling",
  providerStatus = "running",
  recoveryStartedAt = "",
  appliedAt = "",
} = {}) => ({
  id: `generation-${profileId}-${status}`,
  status,
  providerStatus,
  recoveryStartedAt,
  appliedAt,
  createdAt: "2026-08-24T00:00:00.000Z",
  request: {
    settings: {
      provider: "即梦",
      adapter: "cli",
      dreaminaCliProfile: profileId,
    },
  },
});

assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "polling" })), true);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "downloading", providerStatus: "completed" })), true,
  "下载与验收仍属于受保护生成链，结果回写前不得切换到另一账号");
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "waiting_storage", providerStatus: "completed" })), false,
  "本地存储等待不得占用即梦账号切换门禁");
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "complete", providerStatus: "completed" })), true,
  "厂商完成但尚未回写卡片时仍须保持当前账号");
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "complete", providerStatus: "completed", appliedAt: "2026-08-24T00:10:00.000Z" })), false,
  "结果成功回写卡片后必须释放账号切换门禁");
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "failed", providerStatus: "failed" })), false);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "cancel_requested", providerStatus: "running" })), false,
  "用户点击停止后必须立即释放配置切换门禁");

const sameProfile = dreaminaProfileSwitchDecision({
  jobs: [job()],
  requestedProfileId: "account-a",
});
assert.equal(sameProfile.allowed, true, "同一配置应允许其他卡片继续创建独立任务");
assert.equal(sameProfile.queuedBehindCurrent, false, "配置门禁不应把新任务伪装成跨账号等待队列");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job()],
  requestedProfileId: "account-b",
}).allowed, false, "仍需厂商通信时才阻止切换另一配置");

const recentUnknown = job({
  status: "reconciliation_required",
  providerStatus: "reconciling",
  recoveryStartedAt: "2026-08-24T00:55:00.000Z",
});
assert.equal(dreaminaJobRequiresCredentialProfile(recentUnknown, {
  nowMs: Date.parse("2026-08-24T01:00:00.000Z"),
}), false, "提交结果未知但没有厂商任务号时必须保留记录并释放凭证锁");
assert.equal(dreaminaJobRequiresCredentialProfile(recentUnknown, {
  nowMs: Date.parse("2026-08-24T01:11:00.000Z"),
}), false, "短时核验超时后不得永久占用配置切换权");

const [worker, runner] = await Promise.all([
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("./windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
]);
assert.doesNotMatch(worker, /acquireJobLock\("dreamina-cli-global"\)/u,
  "工作进程不得用任务级外层锁包住整轮查询、下载或结果处理");
assert.match(runner, /WaitOne\(\[TimeSpan\]::FromSeconds\(2\)\)/u,
  "Windows 凭据槽互斥应只包住当前实际 CLI 命令");
assert.match(runner, /finally[\s\S]{0,1000}ReleaseMutex/u,
  "Windows 凭据互斥必须在 finally 中释放");

console.log("v3.0 即梦单次 CLI 凭据门禁测试通过");
