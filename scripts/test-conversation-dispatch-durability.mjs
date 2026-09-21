import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConversationDispatchDurability } from "../src/conversation-dispatch-durability.js";

{
  let canonicalCalls = 0;
  const result = await ensureConversationDispatchDurability({
    ensureRecoveryCheckpoint: async () => true,
    hasRecoveryOnlyDraft: () => false,
    saveCanonicalWorkspace: async () => { canonicalCalls += 1; return true; },
  });
  assert.equal(result.protectedBy, "recovery_checkpoint");
  assert.equal(canonicalCalls, 0, "快速检查点成功后不应重复保存规范工作区");
}

{
  const checkpointFailure = Object.assign(new Error("故障注入：检查点失败"), { code: "CHECKPOINT_TEST_FAILURE" });
  let canonicalCalls = 0;
  const result = await ensureConversationDispatchDurability({
    ensureRecoveryCheckpoint: async () => { throw checkpointFailure; },
    hasRecoveryOnlyDraft: () => false,
    saveCanonicalWorkspace: async () => { canonicalCalls += 1; return true; },
  });
  assert.equal(result.protectedBy, "canonical_workspace");
  assert.equal(result.degraded, true);
  assert.equal(result.checkpointError, checkpointFailure);
  assert.equal(canonicalCalls, 1, "无恢复层独占草稿时必须用规范保存保住第二句对话");
}

{
  const checkpointFailure = new Error("故障注入：检查点失败");
  let canonicalCalls = 0;
  const result = await ensureConversationDispatchDurability({
    ensureRecoveryCheckpoint: async () => { throw checkpointFailure; },
    hasRecoveryOnlyDraft: () => true,
    saveCanonicalWorkspace: async () => { canonicalCalls += 1; return true; },
  });
  assert.equal(result.protectedBy, "canonical_workspace");
  assert.equal(result.recoverableAfterRestart, false, "恢复层独占草稿失败时必须如实标注无法完整断电恢复");
  assert.match(result.warning, /模型任务已继续/u);
  assert.equal(canonicalCalls, 1, "仍应后台保存可由规范工作区承载的对话和文档状态");
}

{
  const result = await ensureConversationDispatchDurability({
    ensureRecoveryCheckpoint: async () => { throw new Error("检查点失败"); },
    hasRecoveryOnlyDraft: () => false,
    saveCanonicalWorkspace: async () => { throw new Error("磁盘保存失败"); },
  });
  assert.equal(result.protectedBy, "memory_only");
  assert.equal(result.recoverableAfterRestart, false);
  assert.match(result.warning, /模型任务已继续/u, "两种完整保存都失败时只能降低恢复保证，不能阻断模型");
}

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const nativeDispatch = app.slice(app.indexOf("const executeConversationAgentMessage = async"), app.indexOf("const sendMessage = async"));
assert.match(nativeDispatch, /const pending = \{[\s\S]{0,900}result: "正在路由"[\s\S]{0,900}renderNativeConversation(?:Immediately)?\(runtime, true\)[\s\S]{0,500}const initialTaskRoute/u,
  "路由编译前必须先显示最小任务卡并标记为正在路由");
assert.match(app, /await onPersist\(\)[\s\S]{0,600}renderNativeConversation\(runtime, true\)[\s\S]{0,250}yieldAfterImmediateInstructionRender[\s\S]{0,250}conversationAgentRequest\("\/api\/conversation-agent\/start"/u,
  "Agent 对话应先把用户消息和任务卡显示出来，再启动模型");
const nativePersistence = app.slice(app.indexOf("const persistNativeConversation ="), app.indexOf("const renderNativeConversation ="));
assert.match(nativePersistence, /persistWorkspaceStateOnly\(\{ saveDelay: 180 \}\)/u, "Agent 进度应交给状态自动保存");
assert.doesNotMatch(nativePersistence, /await flushWorkspaceSave/u, "Agent 问题和回答不得等待完整工作区保存");
assert.doesNotMatch(app, /if \(!landingOnlyRequested\) await protectConversationDispatchBeforeModel\(\);/u, "完整保存不得再阻塞模型调用");
const integration = app.slice(
  app.indexOf("const protectConversationDispatchBeforeModel ="),
  app.indexOf("const persistRuntimeCache ="),
);
assert.match(integration, /ensureRecoveryCheckpoint: ensureCurrentRecoveryCheckpoint/u, "应先尝试快速恢复检查点");
assert.match(integration, /hasRecoveryOnlyDraft: whiteboardGenerationDraftNeedsRecoveryCheckpoint/u, "必须检查白板恢复层独占草稿");
assert.match(integration, /saveWorkspace\(\{ throwOnError: true, recoverConflict: true \}\)/u, "后台降级保护仍必须尝试规范工作区保存");
assert.match(integration, /while \(\(ui\.workspaceDirty \|\| ui\.workspaceSavePromise\) && attempts < 4\)/u, "并发保存完成后必须继续保存最新对话版本");
assert.match(integration, /if \(ui\.workspaceDirty \|\| ui\.workspaceSavePromise\) throw/u, "后台规范保存必须识别未收敛状态并继续由自动保存重试");
assert.match(app, /durabilityStatus: durability\.status/u, "检查点和规范保存都失败时必须把仅内存状态留在任务记录上");
assert.match(app, /<dt>保存状态<\/dt>/u, "任务详情必须持续显示不可靠保存状态，不能只闪现 toast");

const originalDataRoot = process.env.SHENSI_DATA_ROOT;
const originalFault = process.env.SHENSI_TEST_GENERATION_ATTEMPT_WRITE_FAILURE;
const originalTaskSessionFault = process.env.SHENSI_TEST_TASK_SESSION_WRITE_FAILURE;
const originalAttemptReadFault = process.env.SHENSI_TEST_GENERATION_ATTEMPT_READ_FAILURE;
const originalTaskSessionReadFault = process.env.SHENSI_TEST_TASK_SESSION_READ_FAILURE;
const attemptDataRoot = await mkdtemp(join(tmpdir(), "shensi-attempt-memory-fallback-"));
const otherDataRoot = await mkdtemp(join(tmpdir(), "shensi-attempt-memory-isolation-"));
try {
  process.env.SHENSI_DATA_ROOT = attemptDataRoot;
  process.env.SHENSI_TEST_GENERATION_ATTEMPT_WRITE_FAILURE = "1";
  const store = await import(`../src/server/generation-attempt-store.mjs?memory-fallback=${Date.now()}`);
  const requestId = "durability-memory-fallback-0001";
  const started = await store.beginGenerationAttempt({
    requestId,
    workspacePath: join(attemptDataRoot, "workspace"),
    targetDocumentId: "chapter-1",
    taskKind: "creative",
    requestFingerprint: "fault-injection-request",
    requestSnapshot: { prompt: "即使任务日志暂时不可写也继续调用模型" },
  });
  assert.equal(started.durabilityStatus, "memory_only", "任务日志故障必须降级为进程内记录");
  assert.equal(store.publicGenerationAttempt(started).recoverableAfterRestart, false);
  const completed = await store.updateGenerationAttempt({
    requestId,
    status: "complete",
    executionStatus: "terminal",
    stage: "finished",
    candidate: "模型已经实际返回的候选内容",
    landingEligible: true,
  });
  assert.equal(completed.status, "complete", "日志写盘失败不得阻止模型结果进入当前会话任务记录");
  assert.equal((await store.loadGenerationAttempt({ requestId })).adoptedCandidate, "模型已经实际返回的候选内容");
  assert.equal((await store.listGenerationAttempts({ workspacePath: join(attemptDataRoot, "workspace") })).length, 1, "当前会话待处理列表必须看得到内存兜底任务");

  delete process.env.SHENSI_TEST_GENERATION_ATTEMPT_WRITE_FAILURE;
  const recoveredDurability = await store.updateGenerationAttempt({ requestId, stage: "storage_recovered" });
  assert.equal(recoveredDurability.durabilityStatus, "durable", "磁盘恢复后下一次更新必须自动转回持久任务");
  const onDisk = JSON.parse(await readFile(store.generationAttemptStorePath({ requestId }), "utf8"));
  assert.equal(onDisk.adoptedCandidate, "模型已经实际返回的候选内容");

  process.env.SHENSI_TEST_TASK_SESSION_WRITE_FAILURE = "1";
  const taskSessions = await import(`../src/server/task-session-manager.mjs?memory-fallback=${Date.now()}`);
  const session = await taskSessions.beginTaskSession({
    taskId: "general-chat-memory-fallback",
    dataRoot: attemptDataRoot,
    conversationId: "conversation-memory-fallback",
    conversationLedger: { currentGoal: "普通 Chat 也不能被完整日志写盘失败阻断" },
  });
  assert.equal(session.durabilityStatus, "memory_only", "普通 Chat 的任务会话日志必须支持当前进程内存兜底");
  assert.match(session.durabilityWarning, /模型仍会继续运行/u);
  const completedSession = await taskSessions.completeTaskSession({
    taskId: session.taskId,
    dataRoot: attemptDataRoot,
  });
  assert.equal(completedSession.status, "complete");
  assert.equal((await taskSessions.loadTaskSession({ taskId: session.taskId, dataRoot: attemptDataRoot })).status, "complete");
  assert.equal((await taskSessions.listTaskSessionProvenance({ conversationId: session.conversationId, dataRoot: attemptDataRoot })).length, 1);
  await taskSessions.beginTaskSession({
    taskId: "other-root-memory-fallback",
    dataRoot: otherDataRoot,
    conversationId: session.conversationId,
    conversationLedger: { currentGoal: "另一个数据根中的同名对话不得串入" },
  });
  assert.deepEqual(
    (await taskSessions.listTaskSessionProvenance({ conversationId: session.conversationId, dataRoot: attemptDataRoot })).map((item) => item.taskId),
    [session.taskId],
    "内存兜底来源列表必须按 dataRoot 隔离",
  );
  assert.deepEqual(
    (await taskSessions.listTaskSessionProvenance({ conversationId: session.conversationId, dataRoot: otherDataRoot })).map((item) => item.taskId),
    ["other-root-memory-fallback"],
    "另一个 dataRoot 只能看到自身的内存兜底会话",
  );
  delete process.env.SHENSI_TEST_TASK_SESSION_WRITE_FAILURE;
  const durableSession = await taskSessions.updateTaskSession({ taskId: session.taskId, dataRoot: attemptDataRoot, patch: { currentStage: "storage_recovered" } });
  assert.equal(durableSession.durabilityStatus, "durable", "任务会话日志磁盘恢复后必须自动转回持久状态");

  process.env.SHENSI_TEST_GENERATION_ATTEMPT_READ_FAILURE = "1";
  const readFailedAttempt = await store.beginGenerationAttempt({
    requestId: "durability-read-fallback-0001",
    workspacePath: join(attemptDataRoot, "workspace"),
    requestFingerprint: "read-fault",
  });
  assert.equal(readFailedAttempt.durabilityStatus, "memory_only", "任务日志读取故障不得在模型调用前阻断");
  delete process.env.SHENSI_TEST_GENERATION_ATTEMPT_READ_FAILURE;

  process.env.SHENSI_TEST_TASK_SESSION_READ_FAILURE = "1";
  const readFailedSession = await taskSessions.beginTaskSession({
    taskId: "general-chat-read-fallback",
    dataRoot: attemptDataRoot,
    conversationId: "conversation-read-fallback",
  });
  assert.equal(readFailedSession.durabilityStatus, "memory_only", "通用 Chat 会话日志读取故障不得阻断模型调用");
  delete process.env.SHENSI_TEST_TASK_SESSION_READ_FAILURE;
} finally {
  if (originalDataRoot === undefined) delete process.env.SHENSI_DATA_ROOT;
  else process.env.SHENSI_DATA_ROOT = originalDataRoot;
  if (originalFault === undefined) delete process.env.SHENSI_TEST_GENERATION_ATTEMPT_WRITE_FAILURE;
  else process.env.SHENSI_TEST_GENERATION_ATTEMPT_WRITE_FAILURE = originalFault;
  if (originalTaskSessionFault === undefined) delete process.env.SHENSI_TEST_TASK_SESSION_WRITE_FAILURE;
  else process.env.SHENSI_TEST_TASK_SESSION_WRITE_FAILURE = originalTaskSessionFault;
  if (originalAttemptReadFault === undefined) delete process.env.SHENSI_TEST_GENERATION_ATTEMPT_READ_FAILURE;
  else process.env.SHENSI_TEST_GENERATION_ATTEMPT_READ_FAILURE = originalAttemptReadFault;
  if (originalTaskSessionReadFault === undefined) delete process.env.SHENSI_TEST_TASK_SESSION_READ_FAILURE;
  else process.env.SHENSI_TEST_TASK_SESSION_READ_FAILURE = originalTaskSessionReadFault;
  await rm(attemptDataRoot, { recursive: true, force: true });
  await rm(otherDataRoot, { recursive: true, force: true });
}

console.log("Conversation dispatch durability tests passed.");
