import assert from "node:assert/strict";

import { buildUnifiedCreativeTask } from "../src/creative-task.js";
import { completedCreativeTask } from "../src/creative-task-state.js";
import {
  compileTaskContract,
  evaluateTaskContract,
  markTaskContractGenerated,
  taskContractOutputContract,
  validateTaskContractForExecution,
} from "../src/task-contract.js";

const contract = compileTaskContract({
  taskType: "writing",
  objective: "建立作品基础交付物",
  instruction: "写作并落盘",
  target: {
    documents: [
      { documentId: "canon-world", title: "作品设定", moduleId: "canon" },
      { documentId: "outline-series", title: "全集大纲", moduleId: "outline" },
      { documentId: "chapter-1", title: "第一章", moduleId: "manuscript" },
    ],
  },
  exclusions: ["测试草稿", "处理说明"],
});

assert.equal(contract.protocol, "shensi_task_contract_v1");
assert.equal(contract.taskType, "writing");
assert.deepEqual(contract.deliverables.map((item) => item.kind), ["setting", "outline", "prose"]);
assert.deepEqual(contract.deliverables.map((item) => item.targetDocument), ["canon-world", "outline-series", "chapter-1"]);
assert.ok(taskContractOutputContract(contract).includes("禁止混入：测试草稿、处理说明"));

const semanticContract = compileTaskContract({
  taskType: "modification",
  operation: "batch",
  objective: "分析前三章的问题，然后直接修改并保存",
  deliverables: [1, 2, 3].map((number) => ({
    id: `chapter-${number}-revision`,
    kind: "prose",
    targetDocumentId: `chapter-${number}`,
    title: `第${number}章`,
  })),
  requiredContextDocumentIds: ["chapter-1", "chapter-2", "chapter-3"],
  skillIds: ["novel-review", "novel-revision"],
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "agent",
});
const semanticValidation = validateTaskContractForExecution(semanticContract);
assert.equal(semanticValidation.valid, true);
assert.equal(semanticValidation.authoritative, true);
assert.equal(semanticValidation.persistence, "commit");
assert.deepEqual(semanticValidation.skillIds, ["novel-review", "novel-revision"]);
assert.equal(validateTaskContractForExecution(compileTaskContract({
  taskType: "writing",
  operation: "create",
  deliverables: [{ kind: "setting", targetDocumentId: "chapter-1" }],
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "model",
})).valid, false, "交付物类型与神思逻辑文档绑定不匹配时必须阻断");

const generated = markTaskContractGenerated(contract);
assert.ok(generated.deliverables.every((item) => item.status === "generated"));

const documents = {
  "canon-world": { title: "作品设定", markdown: "世界规则" },
  "outline-series": { title: "全集大纲", markdown: "第一卷：开端" },
  "chapter-1": { title: "第一章", markdown: "雨夜里，灯火熄灭。" },
};
const receipts = [
  { targetDocumentId: "canon-world", verified: true, writtenHash: "a", verifiedHash: "a" },
  { targetDocumentId: "outline-series", verified: true, writtenHash: "b", verifiedHash: "b" },
];
const partial = evaluateTaskContract({ contract: generated, documents, receipts });
assert.equal(partial.complete, false);
assert.equal(partial.contract.completionStatus, "blocked");
assert.match(partial.missing.find((item) => item.targetDocument === "chapter-1").reason, /write_receipt_unverified/u);

const complete = evaluateTaskContract({
  contract: partial.contract,
  documents,
  receipts: [...receipts, { targetDocumentId: "chapter-1", verified: true, writtenHash: "c", verifiedHash: "c" }],
});
assert.equal(complete.complete, true);
assert.equal(complete.contract.completionStatus, "completed");
assert.ok(complete.contract.deliverables.every((item) => item.status === "verified"));

const genericChapterContract = compileTaskContract({
  taskType: "writing",
  instruction: "写第1章并落盘",
  target: { documents: [{ documentId: "chapter-1", title: "第1章", moduleId: "manuscript" }] },
});
assert.equal(evaluateTaskContract({
  contract: genericChapterContract,
  documents: { "chapter-1": { title: "今日退婚", markdown: "正式正文" } },
  receipts: [{ targetDocumentId: "chapter-1", verified: true }],
}).complete, true, "结构占位标题第N章必须接受生成后的具体章名");

const wrongTitle = evaluateTaskContract({
  contract,
  documents: { ...documents, "outline-series": { ...documents["outline-series"], title: "作品设定" } },
  receipts: [...receipts, { targetDocumentId: "chapter-1", verified: true, writtenHash: "c", verifiedHash: "c" }],
});
assert.equal(wrongTitle.complete, false);
assert.match(wrongTitle.missing.find((item) => item.targetDocument === "outline-series").reason, /title_mismatch/u);

const task = buildUnifiedCreativeTask({
  taskId: "contract-task",
  instruction: "写正文并落盘",
  operation: "create",
  target: { documentId: "chapter-1", requestedTitle: "第一章", moduleId: "manuscript" },
  writeAuthorization: { state: "commit", targetDocumentIds: ["chapter-1"] },
});
assert.equal(task.taskContract.taskType, "writing");
assert.equal(task.taskContract.deliverables[0].targetDocument, "chapter-1");
assert.deepEqual(buildUnifiedCreativeTask({
  instruction: "看看当前正文有什么问题",
  operation: "assist",
  target: { documentId: "chapter-1", moduleId: "manuscript" },
}).taskContract.deliverables, [], "绑定文档是讨论上下文时不能变成写入交付物");
assert.equal(completedCreativeTask({
  status: "completed",
  taskContract: complete.contract,
  documents,
  receipt: { verified: true, failed: 0, results: complete.contract.deliverables.map((item) => ({ targetDocumentId: item.targetDocument, verified: true, writtenHash: "x", verifiedHash: "x" })) },
}), true);
assert.equal(completedCreativeTask({
  status: "completed",
  taskContract: contract,
  documents,
  receipt: { verified: true, failed: 0, results: [] },
}), false);

console.log("Shensi TaskContract delivery protocol passed");
