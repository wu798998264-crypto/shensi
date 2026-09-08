import assert from "node:assert/strict";

import { mediaGenerationPollDelayMs } from "../src/media-generation-coordination.js";
import { DEFAULT_MEDIA_RECOVERY_INTERVAL_MS, createMediaRecoveryReconciler } from "../src/media-recovery-reconciler.js";
import { dreaminaProfileSwitchDecision } from "../src/dreamina-manual-profile-policy.js";

assert.ok(mediaGenerationPollDelayMs({ activePolls: 1 }) <= 750, "正常轮询应尽快接回已完成结果");
assert.ok(DEFAULT_MEDIA_RECOVERY_INTERVAL_MS <= 2_000, "恢复回执不应留下五秒级卡片空窗");

let recoverCalls = 0;
let release;
const pending = new Promise((resolve) => { release = resolve; });
const reconciler = createMediaRecoveryReconciler({ recover: async () => { recoverCalls += 1; await pending; } });
const first = reconciler.run();
const second = reconciler.run();
assert.equal(first, second, "媒体结果恢复必须保持 single-flight");
assert.equal(recoverCalls, 0);
await Promise.resolve();
assert.equal(recoverCalls, 1);
release();
await first;

assert.equal(dreaminaProfileSwitchDecision({
  requestedProfileId: "dreamina-account-b",
  jobs: [{ request: { settings: { id: "dreamina-account-a", dreaminaCliProfile: "dreamina-account-a", provider: "即梦", adapter: "cli" } }, status: "running", appliedAt: "" }],
}).allowed, false, "另一个即梦配置占用唯一凭证锁时只能提示，不能自动排队或切换");
assert.equal(dreaminaProfileSwitchDecision({
  requestedProfileId: "dreamina-account-a",
  jobs: [{ request: { settings: { id: "dreamina-account-a", dreaminaCliProfile: "dreamina-account-a", provider: "即梦", adapter: "cli" } }, status: "running", appliedAt: "" }],
}).allowed, true, "同一配置可以从其他卡片继续提交，由同凭证运行器串行处理");

console.log("Shensi v2.88 media feedback latency tests passed");
