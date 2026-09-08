import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankProjectState } from "../src/data.js";
import { compileTaskContract, evaluateTaskContract } from "../src/task-contract.js";
import { createFormalWriteAuthorization, bindFormalWriteCandidate } from "../src/formal-write-authorization.js";
import { formalDocumentWriteRevisionFromState } from "../src/document-write-revision.js";
import { classifyFormalWriteFailure, formalWritePendingReply } from "../src/formal-write-outcome.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const temporary = await mkdtemp(join(tmpdir(), "shensi-report-boundary-"));
try {
  const workspacePath = join(temporary, "runtime", "source-preview", "作品", "事务边界测试");
  const original = createBlankProjectState("事务边界测试");
  original.documents["chapter-1"] = { title: "第一章", moduleId: "manuscript", html: "<p>必须原样保留的正文。</p>" };
  original.documents["report-novel"] = { title: "小说自检", moduleId: "reports", html: "<p>修改前报告，必须保留历史版本。</p>" };
  await saveWorkspaceState({ appRoot: temporary, requestedPath: workspacePath, state: original });
  const baseline = await loadWorkspaceState({ appRoot: temporary, requestedPath: workspacePath });
  const expectedRevisions = { "report-novel": formalDocumentWriteRevisionFromState(baseline.state, "report-novel") };
  const content = "# 自检报告\n\n## 审查范围\n第一章，全文已读取。\n\n## 证据\n必须原样保留的正文。\n\n## 问题与保留项\n没有发现冲突，保留现有叙事。\n\n## 结论\n本测试报告完整，不修改源正文。";
  const instruction = "检查第一章，保护正文，保存自检报告";
  const contract = compileTaskContract({ taskType: "diagnosis", operation: "replace", instruction,
    deliverables: [{ kind: "report", target: { documentId: "report-novel", moduleId: "reports", title: "小说自检" } }],
    requiredContextDocumentIds: ["chapter-1"], persistence: "commit", semanticSource: "model", sourceMessageId: "report-boundary-user", targetResolution: "exact" });
  const writeAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({ instruction, sourceMessageId: "report-boundary-user", taskContract: contract, expectedRevisions }), { candidate: content, expectedRevisions });
  const task = { executionSurface: "chat", operation: "replace", instruction, taskContract: contract, authorizedCandidate: content, writeAuthorization };
  const operations = [{ operationId: "report-write-once", type: "replace", targetDocumentId: "report-novel", targetDirectoryId: "reports", contentType: "report", content }];
  const receipt = await executeDocumentTransaction({ appRoot: temporary, workspacePath, task, operations, expectedRevisions });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.results[0].verified, true);
  assert.match(receipt.results[0].targetPath, /07_编译报告/u);
  const after = await loadWorkspaceState({ appRoot: temporary, requestedPath: workspacePath });
  assert.match(after.state.documents["report-novel"].markdown, /本测试报告完整/u);
  assert.equal(after.state.documents["chapter-1"].html, baseline.state.documents["chapter-1"].html);
  assert.ok(after.state.histories["report-novel"].some((version) => JSON.stringify(version).includes("修改前报告")));
  const outcome = classifyFormalWriteFailure({ submissionStarted: true, diskCommitted: true, error: { code: "LANDING_RECEIPT_MISSING" } });
  const pending = formalWritePendingReply({ outcome, receipt, documentIds: ["report-novel"] });
  assert.equal(pending.commitFailed, true);
  assert.equal(outcome.rollbackAllowed, false);
  const stillOnDisk = await loadWorkspaceState({ appRoot: temporary, requestedPath: workspacePath });
  assert.equal(stillOnDisk.state.documents["report-novel"].markdown, after.state.documents["report-novel"].markdown);
  const replay = await executeDocumentTransaction({ appRoot: temporary, workspacePath, task, operations, expectedRevisions });
  assert.equal(replay.results[0].idempotentReplay, true);
  const final = await loadWorkspaceState({ appRoot: temporary, requestedPath: workspacePath });
  assert.equal(final.state.histories["report-novel"].length, after.state.histories["report-novel"].length);
  assert.equal(evaluateTaskContract({ contract, documents: { ...final.state.documents, "report-novel": { ...final.state.documents["report-novel"], html: "", markdown: "" } }, requireVerifiedWrite: false }).complete, false);
  console.log("Report transaction real filesystem write/readback/history/idempotency and postcommit failure checks passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
