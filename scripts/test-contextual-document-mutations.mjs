import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  contextualInsertionRequested,
  documentMutationKindForInstruction,
  documentMutationOutputInstruction,
  inferContextualInsertionEditPlan,
  inferContextualReplacementEditPlan,
  patchesFromDocumentEditPlan,
  terminalContinuationRequested,
} from "../src/document-edit-plan.js";
import { applyDocumentPatchPlan } from "../src/document-patch-engine.js";
import { classifyDocumentWriteIntent } from "../src/formal-artifact-extractor.js";
import { createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { compileCreativeMutationPlan, creativeMutationOutputContract } from "../src/creative-mutation-plan.js";

const current = [
  "第一段建立场景。",
  "神器尚未现世。",
  "第三段承接后续冲突。",
].join("\n\n");

const insertionInstruction = "请在「神器尚未现世。」之后补写一段，使其衔接前后文并写入当前正文";
const insertionCandidate = "夜空裂开，古剑坠入山谷，第三段中的争夺因此有了起因。";

assert.equal(contextualInsertionRequested(insertionInstruction), true);
assert.equal(terminalContinuationRequested(insertionInstruction), false);
assert.equal(documentMutationKindForInstruction(insertionInstruction), "insert");
assert.deepEqual(classifyDocumentWriteIntent({ instruction: insertionInstruction }), {
  operation: "insert",
  reason: "contextual_middle_insert",
});

const insertionPlan = inferContextualInsertionEditPlan({
  instruction: insertionInstruction,
  targetDocumentId: "chapter-1",
  currentContent: current,
  candidateContent: insertionCandidate,
  requestId: "insert-1",
});
assert.ok(insertionPlan, "明确唯一锚点的中间补写必须形成局部编辑计划");
const inserted = applyDocumentPatchPlan(current, patchesFromDocumentEditPlan(insertionPlan), {
  expectedRevision: insertionPlan.baselineRevision,
}).content;
assert.equal(inserted, [
  "第一段建立场景。",
  "神器尚未现世。",
  insertionCandidate,
  "第三段承接后续冲突。",
].join("\n\n"));

const beforePlan = inferContextualInsertionEditPlan({
  instruction: "请在「第三段承接后续冲突。」之前插入过渡文字并写入正文",
  targetDocumentId: "chapter-1",
  currentContent: current,
  candidateContent: "风声骤紧，众人同时望向山谷。",
});
assert.match(applyDocumentPatchPlan(current, patchesFromDocumentEditPlan(beforePlan)).content, /风声骤紧，众人同时望向山谷。\n\n第三段承接后续冲突。/u);

const paragraphPlan = inferContextualInsertionEditPlan({
  instruction: "请在第二段后补写一段并写入正文",
  targetDocumentId: "chapter-1",
  currentContent: current,
  candidateContent: insertionCandidate,
});
assert.ok(paragraphPlan, "段落序号必须能够成为安全插入锚点");

assert.equal(inferContextualInsertionEditPlan({
  instruction: "请在中间补写一段并写入正文",
  targetDocumentId: "chapter-1",
  currentContent: current,
  candidateContent: insertionCandidate,
}), null, "没有唯一锚点时必须阻止中间补写，而不是猜测位置");

const replacementInstruction = "请修改第二段，使神器提前出现并写入正文";
const replacementPlan = inferContextualReplacementEditPlan({
  instruction: replacementInstruction,
  targetDocumentId: "chapter-1",
  currentContent: current,
  candidateContent: "神器从裂隙中坠落，照亮整座山谷。",
});
assert.ok(replacementPlan, "明确段落的局部改写必须形成锚点计划");
const replaced = applyDocumentPatchPlan(current, patchesFromDocumentEditPlan(replacementPlan)).content;
assert.equal(replaced, [
  "第一段建立场景。",
  "神器从裂隙中坠落，照亮整座山谷。",
  "第三段承接后续冲突。",
].join("\n\n"));

const continuationInstruction = "请续写当前正文并写入当前文档";
assert.equal(terminalContinuationRequested(continuationInstruction), true);
assert.equal(documentMutationKindForInstruction(continuationInstruction), "continuation");
assert.equal(classifyDocumentWriteIntent({ instruction: continuationInstruction }).operation, "append");
assert.equal(classifyDocumentWriteIntent({ instruction: "请补写当前正文并写入当前文档" }).operation, "append");
assert.equal(classifyDocumentWriteIntent({ instruction: "请全文重写当前正文" }).operation, "replace");

const insertionAuthorization = createFormalWriteAuthorization({
  instruction: insertionInstruction,
  sourceMessageId: "user-insert-1",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
});
assert.equal(insertionAuthorization.state, "commit");
assert.equal(insertionAuthorization.action, "patch", "中间补写必须获得局部修改授权，不能获得追加或全文覆盖授权");

const insertionQuestionAuthorization = createFormalWriteAuthorization({
  instruction: "能不能在「神器尚未现世。」之后补写一段？",
  sourceMessageId: "user-insert-question",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
});
assert.equal(insertionQuestionAuthorization.state, "none", "能力询问不得被误当成正式写入命令");

const continuationAuthorization = createFormalWriteAuthorization({
  instruction: continuationInstruction,
  sourceMessageId: "user-continue-1",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
});
assert.equal(continuationAuthorization.state, "commit");
assert.equal(continuationAuthorization.action, "append");

assert.match(documentMutationOutputInstruction(insertionInstruction), /同时承接前文与后文/u);
assert.match(documentMutationOutputInstruction(continuationInstruction), /现有结尾继续/u);
assert.match(documentMutationOutputInstruction(replacementInstruction), /不要返回整篇文档/u);

const mutationPlan = compileCreativeMutationPlan({
  instruction: insertionInstruction,
  boundDocument: { documentId: "chapter-1", title: "第一章", moduleId: "manuscript" },
  inventory: [{ id: "chapter-1", title: "第一章", moduleId: "manuscript", characters: current.length }],
  contextDomain: "novel",
  formalWriteIntent: true,
  productionIntent: true,
  explicitlyRequestsBoundDocument: true,
});
assert.equal(mutationPlan.requestedMutationKind, "insert");
assert.match(creativeMutationOutputContract(mutationPlan), /只输出需要插入的新内容片段/u);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /DOCUMENT_TRANSACTION_INSERT_ANCHOR_MISSING/u, "聊天与 Agent 落盘链必须在插入锚点缺失时阻止覆盖");
assert.match(app, /contextualInsertionPlan[\s\S]{0,1600}partial-replace/u, "中间补写必须进入局部写入事务");
assert.doesNotMatch(app, /const continuationRequested = \/\(\?:续写[\s\S]{0,100}补写\|增补/u, "补写与增补不得继续被粗暴归类为末尾续写");

console.log("Context-aware continuation, insertion, and localized replacement tests passed");
