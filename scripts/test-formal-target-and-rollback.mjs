import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { formalTargetCompatibility } from "../src/formal-target-compatibility.js";
import { compileTaskContract } from "../src/task-contract.js";
import {
  latestFormalWriteRollbackCheckpoint,
  registerFormalWriteRollbackCheckpoints,
} from "../src/formal-write-rollback.js";

const mismatch = formalTargetCompatibility({
  instruction: "把这段正文写入创作引导",
  target: { documentId: "index-creative-guidance", moduleId: "index", title: "创作引导" },
});
assert.equal(mismatch.compatible, false);
assert.equal(mismatch.recommendedModuleId, "manuscript");
assert.match(mismatch.message, /只用于保存已确认的推演记录/u);
assert.equal(formalTargetCompatibility({
  instruction: "把这段正文写入第三章",
  target: { documentId: "chapter-3", moduleId: "manuscript", title: "第三章" },
}).compatible, true);

const reportContract = compileTaskContract({
  taskType: "diagnosis",
  operation: "create",
  instruction: "检查前三章正文并保存自检报告",
  deliverables: [{
    kind: "artifact",
    target: { documentId: "report-novel", moduleId: "reports", title: "小说自检" },
  }],
  persistence: "commit",
  targetResolution: "exact",
});
const reportCompatibility = formalTargetCompatibility({
  instruction: "请检查前三章正文，只输出《前三章自检报告》并直接保存",
  target: { documentId: "report-novel", moduleId: "reports", title: "小说自检" },
  taskContract: reportContract,
});
assert.equal(reportCompatibility.domain, "reports");
assert.equal(reportCompatibility.compatible, true, "权威 TaskContract 的报告目标不得被正文来源词覆盖");
assert.equal(formalTargetCompatibility({
  instruction: "请检查前三章正文，只输出《前三章自检报告》并直接保存",
  target: { documentId: "report-novel", moduleId: "reports", title: "小说自检" },
}).domain, "reports", "离线兜底也应优先识别明确的报告交付物");

const checkpoint = {
  id: "rollback-1",
  documentId: "chapter-3",
  beforeRevision: "before",
  afterRevision: "after",
  committedAt: 10,
};
const checkpoints = registerFormalWriteRollbackCheckpoints({ current: [], additions: [checkpoint] });
assert.equal(latestFormalWriteRollbackCheckpoint({
  checkpoints,
  documentId: "chapter-3",
  currentRevision: "after",
}).available, true);
assert.equal(latestFormalWriteRollbackCheckpoint({
  checkpoints,
  documentId: "chapter-3",
  currentRevision: "later-edit",
}).reason, "document_changed_after_write");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /kind === "formal_target_correction"/u);
assert.match(app, /kind === "formal_write_rollback"/u);
assert.match(app, /forcedFormalTarget/u);
assert.match(app, /这是唯一不新增历史版本的恢复操作/u);
assert.match(app, /conversationChoicePanel/u);
assert.match(app, /lastQuestionText: String\(message \|\| ""\)\.trim\(\)/u);
assert.doesNotMatch(app, /formalTargetCorrectionDialog|formalWriteRollbackDialog/u);

const targetChoiceBranch = app.slice(
  app.indexOf('pendingConversationChoice.kind === "formal_target_correction"'),
  app.indexOf('pendingConversationChoice.kind === "landing_resolution"'),
);
assert.doesNotMatch(targetChoiceBranch, /showModal\s*\(/u, "目标纠正不得使用中央弹窗");
const rollbackChoiceBranch = app.slice(
  app.indexOf('pendingConversationChoice.kind === "formal_write_rollback"'),
  app.indexOf('pendingConversationChoice.kind === "landing_resolution"'),
);
assert.doesNotMatch(rollbackChoiceBranch, /showModal\s*\(/u, "退回确认不得使用中央弹窗");

console.log("formal target correction and rollback contracts passed");
