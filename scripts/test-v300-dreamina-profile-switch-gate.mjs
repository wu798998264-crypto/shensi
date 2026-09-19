import assert from "node:assert/strict";
import {
  dreaminaJobRequiresCredentialProfile,
  dreaminaProfileSwitchDecision,
} from "../src/dreamina-manual-profile-policy.js";

const job = ({ profile = "a", status = "polling", providerStatus = "running" } = {}) => ({
  id: `job-${profile}-${status}`,
  status,
  providerStatus,
  request: { settings: { provider: "即梦", adapter: "cli", dreaminaCliProfile: profile } },
});

assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "submitting" })), true);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "polling" })), true);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "downloading", providerStatus: "completed" })), true);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "cancel_requested" })), false);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "failed", providerStatus: "failed" })), false);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "retry_required", providerStatus: "running" })), false, "自动续查耗尽后必须释放即梦配置锁");

const sameProfile = dreaminaProfileSwitchDecision({ jobs: [job()], requestedProfileId: "a" });
assert.equal(sameProfile.allowed, true);
assert.equal(sameProfile.queuedBehindCurrent, false, "不得把同配置的新卡片任务伪装为跨账号队列");
const otherProfile = dreaminaProfileSwitchDecision({ jobs: [job()], requestedProfileId: "b" });
assert.equal(otherProfile.allowed, false, "仍在与厂商通信时才拦截切换另一个配置");
assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ status: "complete", providerStatus: "completed" })],
  requestedProfileId: "b",
}).allowed, false, "卡片回填未完成时必须保持原账号，避免跨配置串号");
assert.equal(dreaminaProfileSwitchDecision({
  jobs: [{ ...job({ status: "complete", providerStatus: "completed" }), appliedAt: new Date().toISOString() }],
  requestedProfileId: "b",
}).allowed, true, "卡片完成回写后必须立即释放账号切换门禁");

console.log("v3.0 即梦配置切换门禁测试通过");
