import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlankProjectState } from "../src/data.js";
import { inferExactReplacementEditPlan, patchesFromDocumentEditPlan } from "../src/document-edit-plan.js";
import { applyDocumentPatchPlan } from "../src/document-patch-engine.js";
import { renderHistoryDiff } from "../src/history-diff.js";
import { landingReceiptPresentation, verifiedLandingDocumentLinksForManifest } from "../src/landing-document-links.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { formalDocumentWriteRevisionFromState } from "../src/document-write-revision.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { contentRevision } from "../src/workspace-operations.js";

const original = "林夏推门。\n\n周宁看向林夏。\n\n林夏没有回答。";
const plan = inferExactReplacementEditPlan({
  instruction: "把林夏改成林雪。",
  targetDocumentId: "chapter-1",
  currentContent: original,
  executionSurface: "agent",
  requestId: "request-local-rename",
});
assert.equal(plan.mode, "patch");
assert.equal(plan.edits[0].expectedOccurrences, 3);
const result = applyDocumentPatchPlan(original, patchesFromDocumentEditPlan(plan));
assert.equal(result.content, "林雪推门。\n\n周宁看向林雪。\n\n林雪没有回答。");
assert.equal(result.changeSet.length, 3);
assert.notEqual(result.beforeRevision, result.afterRevision);

const multiPlan = applyDocumentPatchPlan("甲在左。乙在右。", [
  { type: "replace_all_exact", editId: "a", original: "甲", content: "青", expectedOccurrences: 1 },
  { type: "replace_all_exact", editId: "b", original: "乙", content: "白", expectedOccurrences: 1 },
]);
assert.equal(multiPlan.content, "青在左。白在右。");
assert.throws(() => applyDocumentPatchPlan("甲乙", [
  { type: "range", start: 0, end: 2, content: "一" },
  { type: "range", start: 1, end: 2, content: "二" },
]), (error) => error.code === "DOCUMENT_PATCH_OVERLAP");
assert.throws(() => applyDocumentPatchPlan("林夏", [
  { type: "replace_all_exact", original: "林夏", content: "林雪", expectedOccurrences: 2 },
]), /预期 2，实际 1/u);
assert.equal(inferExactReplacementEditPlan({ instruction: "全文重写，把林夏改成林雪", targetDocumentId: "chapter-1", currentContent: original }), null);
const twoNames = inferExactReplacementEditPlan({ instruction: "把人物名字林夏改成林雪，把周宁改成周安。", targetDocumentId: "chapter-1", currentContent: original });
assert.deepEqual(twoNames.edits.map((edit) => [edit.originalText, edit.replacementText]), [["林夏", "林雪"], ["周宁", "周安"]]);
const paragraphPlan = inferExactReplacementEditPlan({ instruction: "把“林夏推门。\n\n周宁看向林夏。”替换为“林雪推门。\n\n周安看向林雪。”", targetDocumentId: "chapter-1", currentContent: original });
assert.equal(paragraphPlan.edits[0].originalText, "林夏推门。\n\n周宁看向林夏。");

const inlineDiff = renderHistoryDiff({ before: original, after: result.content, changeSet: result.changeSet });
assert.match(inlineDiff, /history-diff-removed/u);
assert.match(inlineDiff, /history-diff-added/u);
assert.match(inlineDiff, /林夏/u);
assert.match(inlineDiff, /林雪/u);
assert.ok(inlineDiff.indexOf("history-diff-removed") < inlineDiff.indexOf("history-diff-added"));
assert.doesNotMatch(renderHistoryDiff({ before: "<script>x</script>", after: "安全" }), /<script>/u);

const linkManifest = {
  schemaVersion: 2,
  segments: [{ documentId: "note-1786417833163", requestedTitle: "note-1786417833163", receiptVerified: true, navigationTarget: { documentId: "note-1786417833163" } }],
  batchLandingReceipt: { verified: true, failed: 0, results: [{ targetDocumentId: "note-1786417833163", verified: true, writtenHash: "same", verifiedHash: "same" }] },
};
assert.deepEqual(verifiedLandingDocumentLinksForManifest({
  manifest: linkManifest,
  documents: { "note-1786417833163": { title: "北灵台人物关系" } },
}), [{ documentId: "note-1786417833163", title: "北灵台人物关系" }]);

const largeDocuments = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`document-${index + 1}`, { title: `正文 ${index + 1}` }]));
const largeResults = Array.from({ length: 11 }, (_, index) => ({
  targetDocumentId: `document-${index + 1}`,
  requestedTitle: `正文 ${index + 1}`,
  writtenHash: `hash-${index + 1}`,
  verifiedHash: `hash-${index + 1}`,
  verified: true,
}));
const largeSegments = largeResults.map((item, index) => ({
  documentId: item.targetDocumentId,
  title: item.requestedTitle,
  moduleId: index < 6 ? "manuscript" : "outline",
  receiptVerified: true,
  navigationTarget: { documentId: item.targetDocumentId },
}));
const largePresentation = landingReceiptPresentation({
  manifest: { schemaVersion: 2, segments: largeSegments, batchLandingReceipt: { verified: true, failed: 0, results: largeResults } },
  documents: largeDocuments,
  workspaceKind: "project",
  workspaceName: "验收作品",
});
assert.equal(largePresentation.largeBatch, true);
assert.equal(largePresentation.links.length, 0);
assert.match(largePresentation.summary, /写入作品“验收作品”/u);
assert.match(largePresentation.summary, /覆盖板块：正文、大纲/u);

const [appSource, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
assert.match(appSource, /conversationAgentRequest\("\/api\/conversation-agent\/start", \{[\s\S]*?workspaceKind: taskContextSnapshot\.workspaceKind,[\s\S]*?workspacePath: taskContextSnapshot\.workspacePath,[\s\S]*?messages: taskMessages/u,
  "本地结构操作必须使用发送时工作区快照启动原生 Agent");
assert.match(appSource, /processedAtomicTextDocuments/u);
assert.match(appSource, /verifiedLandingDocumentLinksForManifest\(\{ manifest: message\.landingManifest, documents: state\.documents \}\)/u);
assert.doesNotMatch(appSource, /data-history-diff-side=/u);
assert.match(appSource, /resolveHistoryDiffInput\(\{[\s\S]*?parentBefore:[\s\S]*?snapshotAfter:/u);
assert.match(appSource, /renderHistoryDiff\(diffInput\)/u);
assert.match(styles, /\.history-diff-removed[\s\S]*?color: #b42318/u);
assert.match(styles, /\.history-diff-added[\s\S]*?background: rgba\(34, 197, 94, 0\.20\)/u);

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v231-patch-"));
try {
  const appRoot = join(tempRoot, "app");
  for (const surface of ["agent"]) {
    const workspacePath = join(appRoot, "runtime", surface);
    const state = createBlankProjectState(surface);
    state.documents["chapter-1"] = { title: "第一章", markdown: original, html: `<p>${original}</p>`, moduleId: "manuscript" };
    state.moduleItems.manuscript.push(["chapter-1", "第一章", {}]);
    await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state, operationDocumentIds: ["chapter-1"] });
    const persistedBaseline = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
    const operations = [{
      operationId: `${surface}-local-replace`,
      type: "patch",
      targetDocumentId: "chapter-1",
      patches: patchesFromDocumentEditPlan({ ...plan, executionSurface: surface }),
    }];
    const instruction = "把林夏改成林雪。";
    const expectedRevisions = { "chapter-1": formalDocumentWriteRevisionFromState(persistedBaseline.state, "chapter-1") };
    const authorizedCandidate = JSON.stringify(operations[0].patches);
    const writeAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
      instruction,
      sourceMessageId: `${surface}-local-replace-user`,
      targetDocumentIds: ["chapter-1"],
      expectedRevisions,
      targetExists: true,
    }), { candidate: authorizedCandidate, targetDocumentIds: ["chapter-1"], expectedRevisions });
    const receipt = await executeDocumentTransaction({
      appRoot,
      workspacePath,
      task: { executionSurface: surface, operation: "patch", instruction, authorizedCandidate, writeAuthorization, source: { documentIds: [] }, target: { documentId: "chapter-1" } },
      operations,
      expectedRevisions,
    });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.results[0].changeSet.length, 3);
    const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
    assert.equal(loaded.state.documents["chapter-1"].markdown, result.content);
    assert.equal(loaded.state.histories["chapter-1"].length, 1);
    assert.equal(loaded.state.histories["chapter-1"][0].changeSet.length, 3);
    assert.equal(loaded.state.histories["chapter-1"][0].source, surface);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Shensi v2.3.1 local document patch and history diff contracts passed");
