import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import { buildUnifiedCreativeTask } from "../src/creative-task.js";
import { resolveGenerationAttemptReviewGate } from "../src/server/generation-attempt-store.mjs";
import { completedCreativeTask, mayTransitionCreativeTask } from "../src/creative-task-state.js";
import { buildLandingManifest, validateLandingManifest } from "../src/landing-manifest.js";
import { applyDocumentPatch, applyDocumentPatches } from "../src/document-patch-engine.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { isNonDeliverableCandidate } from "../src/server/shensi-orchestrator.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const authorizedTransactionTask = ({ operations, label, executionSurface = "agent", operation = "batch", action = "create" }) => {
  const instruction = `执行${label}正式文档事务`;
  const targetDocumentIds = operations.map((item) => item.targetDocumentId);
  const expectedRevisions = Object.fromEntries(targetDocumentIds.map((id) => [id, ""]));
  const authorizedCandidate = operations.map((item) => item.content || JSON.stringify(item.patches || [])).join("\n\n");
  const writeAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction,
    sourceMessageId: `user-${label}`,
    targetDocumentIds,
    expectedRevisions,
    targetExists: action !== "create",
    contextualWriteAction: action,
  }), { candidate: authorizedCandidate, targetDocumentIds, expectedRevisions });
  return {
    task: { executionSurface, operation, instruction, authorizedCandidate, writeAuthorization, source: { documentIds: [] }, target: {} },
    expectedRevisions,
  };
};

const task = buildUnifiedCreativeTask({
  taskId: "task-huanjin-1",
  instruction: "将《幻烬》第一章小说改编为剧本并落盘到新文档《第一集》",
  executionSurface: "agent",
  source: { workId: "幻烬", documentIds: ["novel-1"], contentType: "novel", chapter: 1 },
  context: { associatedDocumentId: "novel-1", activeDocumentId: "scratch", referenceDocumentIds: ["canon-1"] },
  target: { workId: "幻烬", documentId: "script-1", contentType: "script", requestedTitle: "第一集", forceCreateNew: true },
  operation: "transform",
});
assert.equal(task.executionSurface, "agent");
assert.deepEqual(task.source.documentIds, ["novel-1"]);
assert.equal(task.target.documentId, "script-1");
assert.notEqual(task.source.documentIds[0], task.target.documentId);
assert.equal(task.qualityPolicy.selfCheckRequested, false);
assert.equal(buildUnifiedCreativeTask({ instruction: "请先自检并修改后落盘" }).qualityPolicy.selfCheckRequested, true);
assert.equal(buildUnifiedCreativeTask({ instruction: "直接写入，不要额外自检" }).qualityPolicy.selfCheckRequested, false);
assert.equal(buildUnifiedCreativeTask({ instruction: "全文重写" }).qualityPolicy.fullRewriteRequested, true);
assert.equal(resolveGenerationAttemptReviewGate({ selfCheckRequested: false, hasPersistedCandidate: true, requestedLandingStatus: "committed" }).landingStatus, "committed");
assert.equal(resolveGenerationAttemptReviewGate({ selfCheckRequested: true, hasPersistedCandidate: true, requestedLandingStatus: "committed" }).landingStatus, "committed");
assert.equal(mayTransitionCreativeTask("committing", "verifying"), true);
assert.equal(mayTransitionCreativeTask("generating", "completed"), false);
assert.equal(completedCreativeTask({ status: "completed", receipt: { verified: true, failed: 0 } }), true);
assert.equal(completedCreativeTask({ status: "completed", receipt: null }), false);
const patchSource = "# 第一场\n\n旧对白。\n\n# 第二场\n\n用户修改必须保留。";
assert.match(applyDocumentPatch(patchSource, { type: "heading", heading: "第一场", content: "新对白。" }), /新对白/u);
assert.match(applyDocumentPatch(patchSource, { type: "block", original: "旧对白。", content: "压缩后的对白。" }), /压缩后的对白/u);
assert.match(applyDocumentPatch(patchSource, { type: "semantic", beforeAnchor: "# 第一场", afterAnchor: "# 第二场", content: "\n\n语义改写。\n\n" }), /语义改写/u);
assert.match(applyDocumentPatch(patchSource, { type: "append", heading: "第二场", content: "补充动作。" }), /补充动作/u);
assert.match(applyDocumentPatches("abc", [{ type: "range", start: 1, end: 2, expectedText: "b", content: "B" }]), /aBc/u);
assert.throws(() => applyDocumentPatch("重复 重复", { type: "block", original: "重复", content: "替换" }), /不唯一/u);
assert.equal(isNonDeliverableCandidate("当前无法生成并写入。缺少第一章正文，因此本轮未生成候选稿，也未进入写入事务。请先导入正文。"), true);
assert.equal(isNonDeliverableCandidate("外景·钟楼·雨夜\n\n林烬敲响铜钟。"), false);

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v120-transaction-"));
try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "幻烬");
  const state = createBlankProjectState("幻烬");
  state.documents["novel-1"] = { title: "第一章", html: "<p>源小说正文，不能被目标写入覆盖。</p>", markdown: "源小说正文，不能被目标写入覆盖。", moduleId: "manuscript" };
  state.documents["script-1"] = { title: "第一集", html: "<p>改编后的剧本正文。</p>", markdown: "改编后的剧本正文。", moduleId: "manuscript", contextDomain: "script" };
  state.moduleItems.manuscript.push(["novel-1", "第一章", { workspaceView: "novel" }]);
  state.moduleItems.manuscript.push(["script-1", "第一集", { workspaceView: "script" }]);

  const initial = await saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    state,
    operationDocumentIds: ["script-1"],
  });
  assert.equal(initial.verificationStatus, "passed");
  assert.equal(initial.batchLandingReceipt.verified, true);
  assert.equal(initial.batchLandingReceipt.failed, 0);
  assert.equal(initial.batchLandingReceipt.results.length, 1);
  assert.equal(initial.batchLandingReceipt.results[0].targetDocumentId, "script-1");
  assert.equal(initial.batchLandingReceipt.results[0].writtenHash, initial.batchLandingReceipt.results[0].verifiedHash);
  assert.match(await readFile(initial.batchLandingReceipt.results[0].targetPath, "utf8"), /改编后的剧本正文/u);

  const documents = [{ documentId: "script-1", title: "第一集", content: "改编后的剧本正文。", target: { moduleId: "manuscript", viewId: "script" } }];
  const manifest = buildLandingManifest({ source: "改编后的剧本正文。", documents, workspacePath, batchLandingReceipt: initial.batchLandingReceipt });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(validateLandingManifest(manifest, documents), true);

  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  const idempotent = await saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    state: loaded.state,
    expectedStateStamp: loaded.stateStamp,
    operationDocumentIds: ["script-1"],
  });
  assert.equal(idempotent.batchLandingReceipt.results.length, 1);
  assert.equal(idempotent.batchLandingReceipt.results[0].operation, "verify");
  const finalState = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.match(finalState.state.documents["novel-1"].html, /源小说正文/u);
  assert.doesNotMatch(finalState.state.documents["novel-1"].html, /改编后的剧本正文/u);

  const batchWorkspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "批量事务验收");
  await saveWorkspaceState({ appRoot, requestedPath: batchWorkspacePath, state: createBlankProjectState("批量事务验收") });
  const sixOperations = [1, 2, 3].flatMap((number) => ([
    { operationId: `script-${number}`, type: "create", targetDocumentId: `script-${number}`, targetDirectoryId: "manuscript", contentType: "script", requestedTitle: `第${String(number).padStart(3, "0")}集`, content: `剧本 ${number}` },
    { operationId: `prompt-${number}`, type: "create", targetDocumentId: `prompt-${number}`, targetDirectoryId: "manuscript", contentType: "prompt", requestedTitle: `第${String(number).padStart(3, "0")}集 Seedance`, content: `提示词 ${number}` },
  ]));
  const batchContract = authorizedTransactionTask({ operations: sixOperations, label: "六文档批量创建" });
  const batch = await executeDocumentTransaction({ appRoot, workspacePath: batchWorkspacePath, ...batchContract, operations: sixOperations, commitMode: "atomic" });
  assert.equal(batch.status, "completed");
  assert.equal(batch.succeeded, 6);
  assert.equal(batch.results.every((receipt) => receipt.verified), true);
  assert.equal(batch.results.filter((receipt) => receipt.targetDocumentId.startsWith("script-")).every((receipt) => /04_正文[\\/]短剧[\\/]短剧剧本/u.test(receipt.targetPath)), true);
  assert.equal(batch.results.filter((receipt) => receipt.targetDocumentId.startsWith("prompt-")).every((receipt) => /04_正文[\\/]短剧[\\/]视频提示词/u.test(receipt.targetPath)), true);
  const replayContract = authorizedTransactionTask({ operations: sixOperations, label: "六文档批量创建", executionSurface: "agent" });
  const replay = await executeDocumentTransaction({ appRoot, workspacePath: batchWorkspacePath, ...replayContract, operations: sixOperations, commitMode: "atomic" });
  assert.equal(replay.succeeded, 6);
  assert.equal(replay.results.every((receipt) => receipt.idempotentReplay), true);

  const partialOperations = [
    { operationId: "partial-good", type: "create", targetDocumentId: "analysis-good", requestedTitle: "分析一", content: "成功项" },
    { operationId: "partial-retry", type: "patch", targetDocumentId: "analysis-later", patches: [{ type: "append", content: "重试成功" }] },
  ];
  const partialContract = authorizedTransactionTask({ operations: partialOperations, label: "系统部分事务", executionSurface: "system" });
  const partial = await executeDocumentTransaction({
    appRoot,
    workspacePath: batchWorkspacePath,
    ...partialContract,
    operations: partialOperations,
    commitMode: "partial",
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.succeeded, 1);
  assert.equal(partial.retryOperations.length, 1);
  const prepareOperations = [{ operationId: "prepare-retry-target", type: "create", targetDocumentId: "analysis-later", requestedTitle: "稍后分析", content: "基线" }];
  const prepareContract = authorizedTransactionTask({ operations: prepareOperations, label: "重试目标创建", executionSurface: "system", operation: "create" });
  await executeDocumentTransaction({
    appRoot,
    workspacePath: batchWorkspacePath,
    ...prepareContract,
    operations: prepareOperations,
  });
  const retryContract = authorizedTransactionTask({ operations: partial.retryOperations, label: "系统局部重试", executionSurface: "system", action: "patch" });
  const retried = await executeDocumentTransaction({
    appRoot,
    workspacePath: batchWorkspacePath,
    ...retryContract,
    operations: partial.retryOperations,
    commitMode: "partial",
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.succeeded, 1);
  const afterRetry = await loadWorkspaceState({ appRoot, requestedPath: batchWorkspacePath });
  assert.equal(Object.keys(afterRetry.state.documents).filter((id) => id === "analysis-good").length, 1);
  assert.match(afterRetry.state.documents["analysis-later"].markdown, /重试成功/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Shensi native CreativeTask and verified document transaction contracts passed");
