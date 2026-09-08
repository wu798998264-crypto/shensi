import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-live-data-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

const { createBlankProjectState } = await import("../src/data.js");
const {
  loadWorkspaceState,
  saveWorkspaceState,
} = await import("../src/server/workspace.mjs");
const {
  beginGenerationAttempt,
  updateGenerationAttempt,
  loadGenerationAttempt,
  recoverInterruptedGenerationAttempts,
} = await import("../src/server/generation-attempt-store.mjs");

const appRoot = dataRoot;
const workspacePath = join(dataRoot, "作品", "live-conflict-heartbeat");
const initial = createBlankProjectState({ name: "实时冲突心跳验收", workspacePath });
// This fixture represents an existing authored guidance record, not a startup document.
initial.moduleItems.index.push(["index-creative-guidance", "创作引导"]);
initial.documents["index-creative-guidance"] = { title: "创作引导", moduleId: "index", html: "", markdown: "" };
const firstCommit = await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: initial });
const snapshotA = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
const snapshotB = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
assert.equal(snapshotA.stateStamp, snapshotB.stateStamp, "A/B 必须从同一状态戳开始");

const aState = structuredClone(snapshotA.state);
aState.documents["index-creative-guidance"].markdown = "# A 修改\n\n来自实例 A";
aState.documents["index-creative-guidance"].html = "<h1>A 修改</h1><p>来自实例 A</p>";
const aCommit = await saveWorkspaceState({
  appRoot,
  requestedPath: workspacePath,
  state: aState,
  expectedStateStamp: snapshotA.stateStamp,
  operationDocumentIds: ["index-creative-guidance"],
});
assert.equal(aCommit.verificationStatus, "passed");

const bState = structuredClone(snapshotB.state);
bState.documents["index-creative-guidance"].markdown = "# B 修改\n\n来自实例 B";
bState.documents["index-creative-guidance"].html = "<h1>B 修改</h1><p>来自实例 B</p>";
await assert.rejects(
  () => saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    state: bState,
    expectedStateStamp: snapshotB.stateStamp,
    operationDocumentIds: ["index-creative-guidance"],
  }),
  (error) => error?.code === "WORKSPACE_STATE_CONFLICT",
);

const latest = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
const bRetry = structuredClone(latest.state);
bRetry.documents["index-creative-guidance"].markdown = "# B 重试\n\n冲突处理后保留 B";
bRetry.documents["index-creative-guidance"].html = "<h1>B 重试</h1><p>冲突处理后保留 B</p>";
const bCommit = await saveWorkspaceState({
  appRoot,
  requestedPath: workspacePath,
  state: bRetry,
  expectedStateStamp: latest.stateStamp,
  operationDocumentIds: ["index-creative-guidance"],
});
assert.equal(bCommit.verificationStatus, "passed");
const recoveredWorkspace = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
assert.match(recoveredWorkspace.state.documents["index-creative-guidance"].markdown, /B 重试/u);

const requestId = "live-heartbeat-001";
const started = await beginGenerationAttempt({
  requestId,
  workspacePath,
  targetDocumentId: "index-creative-guidance",
  taskKind: "creative",
  requestFingerprint: "live-heartbeat-fingerprint",
});
const firstHeartbeat = Date.parse(started.heartbeatAt);
await new Promise((resolve) => setTimeout(resolve, 40));
const running = await updateGenerationAttempt({
  requestId,
  status: "running",
  executionStatus: "running",
  phase: "generating",
  stage: "持续心跳",
  heartbeatAt: new Date().toISOString(),
});
assert.ok(Date.parse(running.heartbeatAt) >= firstHeartbeat, "运行中必须持久化心跳时间");
const persistedRunning = await loadGenerationAttempt({ requestId });
assert.equal(persistedRunning.stage, "持续心跳");
const completed = await updateGenerationAttempt({
  requestId,
  status: "complete",
  executionStatus: "terminal",
  phase: "complete",
  stage: "已完成",
  heartbeatAt: new Date().toISOString(),
});
assert.equal(completed.executionStatus, "terminal");
assert.ok(completed.completedAt, "终态必须写入完成时间");
const recovery = await recoverInterruptedGenerationAttempts();
assert.equal(recovery.recovered, 0, "已完成任务不应被重启恢复逻辑重新标记");
const interruptedRequestId = "live-recovery-001";
await beginGenerationAttempt({
  requestId: interruptedRequestId,
  workspacePath,
  targetDocumentId: "index-creative-guidance",
  taskKind: "creative",
  requestFingerprint: "live-recovery-fingerprint",
});
const interruptedRecovery = await recoverInterruptedGenerationAttempts();
assert.equal(interruptedRecovery.recovered, 1, "运行中任务重启后必须进入可恢复终态");
const interruptedAttempt = await loadGenerationAttempt({ requestId: interruptedRequestId });
assert.equal(interruptedAttempt.status, "interrupted");
assert.equal(interruptedAttempt.executionStatus, "terminal");
assert.equal(interruptedAttempt.phase, "interrupted", "重启中断记录必须使用明确终态阶段");

console.log(JSON.stringify({
  ok: true,
  conflict: { firstCommit: "passed", staleSave: "WORKSPACE_STATE_CONFLICT", retry: "passed", finalContent: "B 重试" },
  heartbeat: {
    persisted: true,
    terminal: "complete",
    recoveryCount: recovery.recovered,
    interruptedRecovery: interruptedRecovery.recovered,
  },
  initialStateStamp: firstCommit.stateStamp,
}, null, 2));

await rm(dataRoot, { recursive: true, force: true });
