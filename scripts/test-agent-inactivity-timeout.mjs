import assert from "node:assert/strict";

import {
  createAgentInactivityTimeout,
  effectiveAgentInactivityTimeoutMs,
} from "../src/server/agent-inactivity-timeout.mjs";

assert.equal(effectiveAgentInactivityTimeoutMs(120_000), 600_000);
assert.equal(effectiveAgentInactivityTimeoutMs(1_800_000), 1_800_000);
assert.equal(effectiveAgentInactivityTimeoutMs(9_000_000), 3_600_000);

const scheduled = [];
const cancelled = [];
const schedule = (callback, delayMs) => {
  const handle = { callback, delayMs, unref() {} };
  scheduled.push(handle);
  return handle;
};
const cancel = (handle) => cancelled.push(handle);
let timedOut = 0;
const inactivity = createAgentInactivityTimeout({
  timeoutMs: 50,
  onTimeout: () => { timedOut += 1; },
  schedule,
  cancel,
});

assert.equal(scheduled.length, 1);
assert.equal(scheduled[0].delayMs, 50);
inactivity.refresh();
assert.equal(cancelled.length, 1, "收到进展时必须取消旧空闲计时器");
assert.equal(scheduled.length, 2, "收到进展时必须重新开始完整空闲窗口");
scheduled[0].callback();
assert.equal(timedOut, 0, "已被续期的旧计时器不得终止任务");
scheduled[1].callback();
assert.equal(timedOut, 1);
inactivity.stop();
inactivity.refresh();
assert.equal(scheduled.length, 2, "任务结束后不得再次启动计时器");

console.log("Agent inactivity timeout tests passed");
