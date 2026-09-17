import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createBlankProjectState } from "../src/data.js";
import { buildLandingManifest, validateLandingManifest } from "../src/landing-manifest.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { contentRevision } from "../src/workspace-operations.js";
import { formalDocumentWriteRevisionFromState } from "../src/document-write-revision.js";

const root = await mkdtemp(join(tmpdir(), "shensi-v124-batch-"));
const appRoot = join(root, "app");
const workspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "v1.2.4批量落盘验收");
const task = (surface, taskId, operations, expectedRevisions = {}, action = "create") => {
  const instruction = `执行${taskId}正式文档事务`;
  const targetDocumentIds = operations.map((item) => item.targetDocumentId);
  const normalizedRevisions = Object.fromEntries(targetDocumentIds.map((id) => [id, expectedRevisions[id] || ""]));
  const authorizedCandidate = operations.map((item) => item.content || JSON.stringify(item.patches || [])).join("\n\n");
  const writeAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction,
    sourceMessageId: `user-${taskId}`,
    targetDocumentIds,
    expectedRevisions: normalizedRevisions,
    targetExists: action !== "create",
    contextualWriteAction: action,
  }), { candidate: authorizedCandidate, targetDocumentIds, expectedRevisions: normalizedRevisions });
  return {
    taskId,
    executionSurface: surface,
    operation: "batch",
    instruction,
    authorizedCandidate,
    writeAuthorization,
    source: { documentIds: [] },
    target: { workId: "v1.2.4批量落盘验收" },
  };
};
const createOperations = (prefix, count, contentType = "novel") => Array.from({ length: count }, (_, index) => ({
  operationId: `${prefix}-op-${index + 1}`,
  type: "create",
  targetDocumentId: `${prefix}-document-${index + 1}`,
  targetDirectoryId: "manuscript",
  contentType,
  requestedTitle: `${prefix.toUpperCase()} 文档 ${index + 1}`,
  content: `${prefix} 正式正文 ${index + 1}\n\n这是批量落盘验收内容。`,
}));

try {
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: createBlankProjectState("v1.2.4批量落盘验收") });

  for (const surface of ["chat", "agent"]) {
    const operations = createOperations(surface, 5, surface === "agent" ? "script" : "novel");
    const receipt = await executeDocumentTransaction({
      appRoot,
      workspacePath,
      task: task(surface, `${surface}-five`, operations),
      operations,
      requestId: `${surface}-five`,
      batchId: `batch-${surface}-five`,
      commitMode: "atomic",
    });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.succeeded, 5);
    assert.equal(receipt.failed, 0);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.requestId, `${surface}-five`);
    assert.equal(receipt.results.every((item) => item.navigationTarget?.documentId === item.targetDocumentId), true);

    const documents = operations.map((operation) => ({
      documentId: operation.targetDocumentId,
      title: operation.requestedTitle,
      content: operation.content,
      target: { moduleId: operation.targetDirectoryId },
    }));
    const manifest = buildLandingManifest({ documents, workspacePath, batchLandingReceipt: receipt });
    assert.equal(validateLandingManifest(manifest, documents), true);
    assert.equal(manifest.segments.every((segment) => segment.navigationTarget?.documentId === segment.documentId), true);
  }

  const beforeMixed = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  const existingId = "chat-document-1";
  const existingContent = beforeMixed.state.documents[existingId].markdown;
  const mixedOperations = [
    { operationId: "mixed-create", type: "create", targetDocumentId: "mixed-new", requestedTitle: "混合新文档", content: "混合新建正文" },
    { operationId: "mixed-patch", type: "patch", targetDocumentId: existingId, requestedTitle: "CHAT 文档 1", patches: [{ type: "append", content: "用户最新版基础上的局部补充。" }] },
  ];
  const mixedRevisions = { [existingId]: formalDocumentWriteRevisionFromState(beforeMixed.state, existingId) };
  const mixed = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: task("chat", "mixed-create-update", mixedOperations, mixedRevisions),
    operations: mixedOperations,
    expectedRevisions: mixedRevisions,
    commitMode: "atomic",
  });
  assert.equal(mixed.succeeded, 2);
  const afterMixed = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.match(afterMixed.state.documents[existingId].markdown, /用户最新版基础上的局部补充/u);
  assert.equal(
    afterMixed.state.histories[existingId][0].content,
    afterMixed.state.documents[existingId].markdown,
    "局部补充落盘后必须把最新正文保存为最新历史版本",
  );
  assert.equal(afterMixed.state.histories[existingId][1].content, existingContent, "局部补充前的历史版本必须继续保留");
  assert.ok(mixed.results.find((item) => item.targetDocumentId === existingId)?.versionId);

  const conflictBasis = afterMixed.state.documents[existingId].markdown;
  const partialOperations = [
    { operationId: "partial-create", type: "create", targetDocumentId: "partial-created", requestedTitle: "部分成功", content: "已验证成功" },
    { operationId: "partial-conflict", type: "append", targetDocumentId: existingId, content: "冲突后重试内容" },
  ];
  const partialRevisions = { [existingId]: contentRevision(`${conflictBasis}已被用户改动`) };
  const partial = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: task("system", "partial-retry", partialOperations, partialRevisions),
    operations: partialOperations,
    expectedRevisions: partialRevisions,
    commitMode: "partial",
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.succeeded, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.verified, false);
  assert.equal(partial.retryOperations.length, 1);

  const retryRevisions = { [existingId]: formalDocumentWriteRevisionFromState(afterMixed.state, existingId) };
  const retried = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: task("system", "partial-retry-commit", partial.retryOperations, retryRevisions, "patch"),
    operations: partial.retryOperations,
    expectedRevisions: retryRevisions,
    commitMode: "partial",
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.succeeded, 1);
  const afterRetry = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(Object.keys(afterRetry.state.documents).filter((id) => id === "partial-created").length, 1);
  assert.match(afterRetry.state.documents[existingId].markdown, /冲突后重试内容/u);

  const restartOperations = createOperations("restart", 3, "prompt");
  const firstCommit = await executeDocumentTransaction({ appRoot, workspacePath, task: task("chat", "restart", restartOperations), operations: restartOperations, batchId: "restart-batch" });
  const replayAfterReload = await executeDocumentTransaction({ appRoot, workspacePath, task: task("chat", "restart", restartOperations), operations: restartOperations, batchId: "restart-batch" });
  assert.equal(firstCommit.succeeded, 3);
  assert.equal(replayAfterReload.results.every((item) => item.idempotentReplay === true), true);
  await assert.rejects(
    executeDocumentTransaction({
      appRoot,
      workspacePath,
      task: task("chat", "restart-conflict", [{ ...restartOperations[0], content: "相同操作 ID 的不同正文" }]),
      operations: [{ ...restartOperations[0], content: "相同操作 ID 的不同正文" }],
    }),
    (error) => error?.code === "DOCUMENT_TRANSACTION_IDEMPOTENCY_CONFLICT",
  );

  const stressOperations = createOperations("stress", 20, "prompt");
  const startedAt = performance.now();
  const stress = await executeDocumentTransaction({ appRoot, workspacePath, task: task("agent", "stress-20", stressOperations), operations: stressOperations, batchId: "stress-20" });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(stress.succeeded, 20);
  assert.equal(stress.results.every((item) => item.verified), true);
  assert.ok(elapsedMs <= 15_000, `20 文档事务耗时 ${elapsedMs.toFixed(1)}ms，超过 15 秒`);
  const finalState = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(stressOperations.every((operation) => finalState.state.documents[operation.targetDocumentId]?.markdown === operation.content), true);

  console.log(JSON.stringify({
    ok: true,
    chatBatch: "5/5",
    agentBatch: "5/5",
    mixedCreateUpdate: "2/2",
    conflictRetry: "1 failed then 1/1 retried",
    restartIdempotence: "3/3 exactly once",
    stressBatch: "20/20",
    stressElapsedMs: Number(elapsedMs.toFixed(1)),
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
