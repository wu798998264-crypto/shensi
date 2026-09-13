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
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "downloading", providerStatus: "completed" })), true,
  "厂商成功后的下载和完整性验收仍属于受保护执行链");
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "cancel_requested" })), false);
assert.equal(dreaminaJobRequiresCredentialProfile(job({ status: "failed", providerStatus: "failed" })), false);

const sameProfile = dreaminaProfileSwitchDecision({ jobs: [job()], requestedProfileId: "a" });
assert.equal(sameProfile.allowed, true);
assert.equal(sameProfile.queuedBehindCurrent, false, "不得把同配置的新卡片任务伪装为跨账号队列");
const otherProfile = dreaminaProfileSwitchDecision({ jobs: [job()], requestedProfileId: "b" });
assert.equal(otherProfile.allowed, false, "仍在与厂商通信时才拦截切换另一个配置");
assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ status: "complete", providerStatus: "completed" })],
  requestedProfileId: "b",
}).allowed, true, "卡片回填未完成不能继续占用账号切换门禁");

console.log("v3.0 即梦配置切换门禁测试通过");
