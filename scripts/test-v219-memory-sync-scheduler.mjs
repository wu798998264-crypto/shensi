import assert from "node:assert/strict";

import { manualMemorySyncDelay, memorySyncRevisionIsCurrent } from "../src/memory-sync-scheduler.js";

assert.equal(manualMemorySyncDelay({ now: 100_000, lastRunAt: 0 }), 15_000);
assert.equal(manualMemorySyncDelay({ now: 100_000, lastRunAt: 70_000 }), 30_000);
assert.equal(manualMemorySyncDelay({ now: 100_000, lastRunAt: 20_000 }), 15_000);
assert.equal(manualMemorySyncDelay({ now: 100_000, lastRunAt: 70_000, immediate: true }), 30_000);
assert.equal(manualMemorySyncDelay({ now: 100_000, lastRunAt: 0, immediate: true }), 0);
assert.equal(memorySyncRevisionIsCurrent({ expectedRevision: "abc", currentRevision: "abc" }), true);
assert.equal(memorySyncRevisionIsCurrent({ expectedRevision: "abc", currentRevision: "def" }), false);

console.log("Shensi v2.19 low-frequency memory sync scheduler tests passed");
