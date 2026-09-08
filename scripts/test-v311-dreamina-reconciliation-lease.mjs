import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS,
  dreaminaSubmissionReconciliationLease,
} from "../src/server/dreamina-submission-reconciliation-lease.mjs";

const startedAt = "2026-08-25T08:00:00.000Z";
const withinLease = dreaminaSubmissionReconciliationLease({ automaticRecoveryStartedAt: startedAt }, {
  now: Date.parse(startedAt) + DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS - 1,
});
assert.equal(withinLease.expired, false, "30 分钟窗口内必须继续自动找回");

const expired = dreaminaSubmissionReconciliationLease({ automaticRecoveryStartedAt: startedAt }, {
  now: Date.parse(startedAt) + DEFAULT_DREAMINA_SUBMISSION_RECONCILIATION_LEASE_MS,
});
assert.equal(expired.expired, true, "到达 30 分钟上限必须停止自动找回");

const stopped = dreaminaSubmissionReconciliationLease({
  automaticRecoveryStartedAt: startedAt,
  automaticRecoveryStoppedAt: "2026-08-25T08:30:00.000Z",
}, { now: Date.parse("2026-08-25T09:00:00.000Z") });
assert.equal(stopped.stopped, true, "已停止记录不能被 watchdog 自动重启");
assert.equal(stopped.expired, false, "已停止记录应由 stopped 状态主导");

const restarted = dreaminaSubmissionReconciliationLease({
  automaticRecoveryStartedAt: "2026-08-25T09:05:00.000Z",
  automaticRecoveryStoppedAt: "",
}, { now: Date.parse("2026-08-25T09:10:00.000Z") });
assert.equal(restarted.stopped, false, "用户手动自动找回后必须开始新租约");
assert.equal(restarted.expired, false, "新租约不能继承旧轮次的到期状态");

const [worker, store] = await Promise.all([
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8"),
]);
assert.match(worker, /DREAMINA_SUBMISSION_RECONCILIATION_LEASE_EXPIRED/u, "worker 必须持久化可识别的租约到期状态");
assert.match(worker, /后台找回已停止并释放凭证槽/u, "到期提示必须说明凭证槽已释放");
assert.match(worker, /没有重新提交或重复扣费/u, "到期提示必须保留账单安全说明");
assert.match(worker, /automaticSubmissionRecoveryJob[\s\S]{0,500}dreaminaAutomaticSubmissionRecoveryAllowed/u, "watchdog 必须排除已停止或到期的即梦找回任务");
assert.match(store, /automaticRecoveryStartedAt:[\s\S]{0,120}automaticRecoveryStoppedAt: ""/u, "手动自动找回必须开启新租约并清除旧停止标记");

process.stdout.write("v3.1.1 Dreamina reconciliation lease regression checks passed\n");
