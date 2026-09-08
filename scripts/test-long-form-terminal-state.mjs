import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-long-form-terminal-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

const { recoverInterruptedLongFormState } = await import("../src/long-form-recovery.js");
const store = await import(`../src/server/generation-attempt-store.mjs?terminal-state=${Date.now()}`);

const failedMessage = {
  id: "message-long-form-failed",
  role: "assistant",
  pending: true,
  content: "正在生成并检查第1章",
  execution: {
    jobId: "long-form-failed",
    requestId: "run-chapter-outlines",
    status: "running",
  },
};
const failedJob = {
  id: "long-form-failed",
  status: "failed",
  phase: "chapter_outlines",
  currentRequestId: null,
  currentChapter: 1,
  startChapter: 1,
  endChapter: 10,
  completedChapters: [],
};
const state = {
  messages: [],
  conversations: [{ id: "conversation-1", messages: [failedMessage] }],
  longFormJobs: [failedJob],
};
assert.equal(recoverInterruptedLongFormState(state), 1);
assert.equal(failedMessage.pending, false, "失败后的长篇消息必须退出 pending");
assert.equal(failedMessage.execution.status, "failed");
assert.equal(failedMessage.execution.executionStatus, "terminal");
assert.equal(failedMessage.execution.requestId, null, "失败消息不得保留可恢复运行 requestId");
assert.equal(failedJob.currentRequestId, null);

const interruptedMessage = {
  id: "message-long-form-interrupted",
  role: "assistant",
  pending: true,
  execution: {
    jobId: "long-form-interrupted",
    requestId: "run-active-chapter",
    status: "running",
  },
};
const interruptedJob = {
  id: "long-form-interrupted",
  status: "writing",
  phase: "chapters",
  currentRequestId: "run-active-chapter",
  startChapter: 1,
  endChapter: 10,
  currentChapter: 4,
  completedChapters: [1, 2, 3],
};
const interruptedState = {
  messages: [interruptedMessage],
  conversations: [],
  longFormJobs: [interruptedJob],
};
assert.equal(recoverInterruptedLongFormState(interruptedState), 1);
assert.equal(interruptedJob.status, "paused");
assert.equal(interruptedMessage.pending, false);
assert.equal(interruptedMessage.execution.status, "paused");
assert.equal(interruptedMessage.execution.executionStatus, "terminal");
assert.equal(interruptedMessage.execution.progressPercent, 100);
assert.equal(interruptedMessage.execution.requestId, null);

const workspacePath = join(dataRoot, "作品", "terminal-state");
const completed = await store.beginGenerationAttempt({
  requestId: "terminal-complete-001",
  workspacePath,
  targetDocumentId: "volume-outline",
  taskKind: "long-form:volume-outline",
  requestFingerprint: "terminal-complete-fingerprint",
});
const completedUpdate = await store.updateGenerationAttempt({
  requestId: completed.requestId,
  status: "complete",
  stage: "completed",
  landingEligible: true,
  resultData: { data: { chapters: [] } },
});
assert.equal(completedUpdate.status, "complete");
assert.equal(completedUpdate.executionStatus, "terminal");
assert.equal(completedUpdate.phase, "finished");
assert.ok(completedUpdate.completedAt, "终态必须有 completedAt");

const contradictory = await store.beginGenerationAttempt({
  requestId: "terminal-failed-001",
  workspacePath,
  targetDocumentId: "foundation",
  taskKind: "long-form:foundation",
  requestFingerprint: "terminal-failed-fingerprint",
});
const failedUpdate = await store.updateGenerationAttempt({
  requestId: contradictory.requestId,
  status: "failed",
  executionStatus: "running",
  phase: "planning",
  stage: "failed",
  landingEligible: false,
});
assert.equal(failedUpdate.status, "failed");
assert.equal(failedUpdate.executionStatus, "terminal", "失败状态必须覆盖冲突的 running executionStatus");
assert.equal(failedUpdate.phase, "finished", "终态不得保留 planning 等运行阶段");
assert.ok(failedUpdate.completedAt);

const legacyTerminalView = store.publicGenerationAttempt({
  requestId: "legacy-terminal-view-001",
  status: "complete",
  executionStatus: "running",
  phase: "planning",
});
assert.equal(legacyTerminalView.executionStatus, "terminal", "旧终态记录读取时不得重新显示为运行中");
assert.equal(legacyTerminalView.phase, "finished", "旧终态记录读取时不得暴露 planning 等运行阶段");

console.log("Long-form terminal state checks passed.");
await rm(dataRoot, { recursive: true, force: true });
