import assert from "node:assert/strict";
import {
  dreaminaTaskSessionRecoveryPolicy,
} from "../src/dreamina-task-session-recovery-policy.js";

const startedAt = "2026-09-02T00:00:00.000Z";
const activeJob = {
  providerTaskId: "provider-task-a",
  dreaminaSessionRecoveryStartedAt: startedAt,
  dreaminaSessionRecoveryAttempts: 1,
};

const next = dreaminaTaskSessionRecoveryPolicy({
  job: activeJob,
  code: "DREAMINA_AUTH_REQUIRED",
  now: Date.parse(startedAt) + 10_000,
});
assert.equal(next.applies, true);
assert.equal(next.expired, false);
assert.equal(next.attempts, 2);
assert.match(next.startedAt, /^2026-09-02T00:00:00\.000Z$/u);
assert.ok(next.delayMs > 0);

const exhausted = dreaminaTaskSessionRecoveryPolicy({
  job: { ...activeJob, dreaminaSessionRecoveryAttempts: 2 },
  code: "DREAMINA_AUTH_REQUIRED",
  now: Date.parse(startedAt) + 30_000,
});
assert.equal(exhausted.attempts, 3);
assert.equal(exhausted.expired, true, "同一原任务自动恢复最多尝试三次，不能持续二十分钟假进度");

assert.equal(dreaminaTaskSessionRecoveryPolicy({
  job: activeJob,
  code: "DREAMINA_PROFILE_BROKER_BUSY",
}).applies, false, "凭证槽繁忙不是账号失效，不得进入重新核验策略");

assert.equal(dreaminaTaskSessionRecoveryPolicy({
  job: { ...activeJob, providerTaskId: "" },
  code: "DREAMINA_AUTH_REQUIRED",
}).applies, false, "没有厂商任务号时仍由提交前账号门禁负责核验");

assert.equal(dreaminaTaskSessionRecoveryPolicy({
  job: activeJob,
  code: "DREAMINA_ACCOUNT_MISMATCH",
}).applies, false, "账号不匹配必须保持身份安全阻断，不得自动切换账号");

const expired = dreaminaTaskSessionRecoveryPolicy({
  job: activeJob,
  code: "DREAMINA_PROVIDER_SESSION_EXPIRED",
  now: Date.parse(startedAt) + 60_000 + 1,
});
assert.equal(expired.applies, true);
assert.equal(expired.expired, true);

console.log("Dreamina task session recovery policy tests passed");
