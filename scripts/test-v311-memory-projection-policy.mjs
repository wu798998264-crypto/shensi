import assert from "node:assert/strict";

import { memoryProjectionDecision } from "../src/memory-projection-policy.js";

const contract = (taskType, kind, documentId = "chapter-1") => ({
  protocol: "shensi.task-contract.v1",
  taskType,
  deliverables: [{ id: "deliverable-001", kind, targetDocumentId: documentId, target: { documentId, moduleId: kind === "prose" || kind === "script" ? "manuscript" : kind === "outline" ? "outline" : "canon" } }],
});

assert.equal(memoryProjectionDecision({
  documentId: "chapter-1",
  moduleId: "manuscript",
  taskContract: contract("writing", "prose"),
}).eligible, true);

assert.equal(memoryProjectionDecision({
  documentId: "script-episode-1",
  moduleId: "manuscript",
  contextDomain: "script",
  taskContract: contract("modification", "script", "script-episode-1"),
}).eligible, true);

for (const [taskType, kind, documentId, moduleId] of [
  ["planning", "outline", "outline-chapter-1", "outline"],
  ["writing", "setting", "canon-world", "canon"],
  ["testing", "prose", "chapter-1", "manuscript"],
  ["diagnosis", "report", "report-novel", "reports"],
]) {
  const decision = memoryProjectionDecision({ documentId, moduleId, taskContract: contract(taskType, kind, documentId) });
  assert.equal(decision.eligible, false, `${taskType}/${kind} 不得派生正式记忆`);
}

assert.equal(memoryProjectionDecision({
  documentId: "chapter-9",
  moduleId: "manuscript",
}).eligible, true, "没有 TaskContract 的历史正文写入保留兼容能力");

assert.equal(memoryProjectionDecision({
  documentId: "chapter-9",
  moduleId: "manuscript",
  deliverableKind: "outline",
}).eligible, false, "已有明确交付类型时不得退回按文档名猜测");

assert.equal(memoryProjectionDecision({
  documentId: "chapter-1",
  moduleId: "manuscript",
  taskContract: { ...contract("writing", "prose", "chapter-2") },
}).eligible, false, "合同中没有当前交付物时不得派生记忆");

console.log("v3.1.1 memory projection policy tests passed");
