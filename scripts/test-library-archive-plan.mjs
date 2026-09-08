import assert from "node:assert/strict";

import {
  LIBRARY_ARCHIVE_SCHEMA,
  buildLibraryArchiveOperations,
  compareLibraryArchiveCandidates,
  createLibraryArchiveSnapshot,
  isLibraryArchiveSource,
  isLibraryArchiveTarget,
  libraryArchiveExecutionInstruction,
  libraryArchiveOutputContract,
  parseLibraryArchivePlan,
} from "../src/library-archive-plan.js";

const documents = {
  "library-reference": {
    id: "library-reference",
    title: "参考资料",
    revision: "lib-r1",
    moduleId: "library",
    markdown: "北明院只接受北明血脉后裔入院。院规不得擅自外传。",
  },
  "canon-world": {
    id: "canon-world",
    title: "世界观与基础规则",
    revision: "canon-r4",
    moduleId: "canon",
    markdown: "# 世界观与基础规则\n\n## 世界观\n\n沿海城市。",
  },
  "outline-series": {
    id: "outline-series",
    title: "全集大纲",
    revision: "outline-r2",
    moduleId: "outline",
    markdown: "# 全集大纲\n\n## 第一卷\n\n主角入局。",
  },
};

assert.equal(isLibraryArchiveSource("library-reference", documents["library-reference"]), true);
assert.equal(isLibraryArchiveSource("library-trash", { moduleId: "library" }), false);
assert.equal(isLibraryArchiveTarget("canon-world"), true);
assert.equal(isLibraryArchiveTarget("library-reference"), false);

const snapshot = createLibraryArchiveSnapshot({
  documents,
  sourceDocumentIds: ["library-reference"],
  projectId: "project-1",
});
assert.equal(snapshot.schema, LIBRARY_ARCHIVE_SCHEMA);
assert.equal(snapshot.sourceDocumentIds.length, 1);
assert.equal(snapshot.documents["library-reference"].contentHash.length, 64);

const rawPlan = {
  schema: LIBRARY_ARCHIVE_SCHEMA,
  summary: "把资料中的院规归入世界观规则",
  candidates: [{
    sourceDocumentId: "library-reference",
    sourceQuote: "北明院只接受北明血脉后裔入院。",
    targetDocumentId: "canon-world",
    targetSection: "世界观",
    disposition: "update",
    operation: "patch",
    reason: "资料给出组织准入规则",
    content: "## 北明院准入\n\n北明院只接受北明血脉后裔入院。",
    confidence: "high",
  }],
};
const parsed = parseLibraryArchivePlan(rawPlan, {
  snapshot,
  documents,
  allowedTargetDocumentIds: ["canon-world", "outline-series"],
});
assert.equal(parsed.candidates.length, 1);
assert.equal(parsed.candidates[0].sourceRevision, "lib-r1");
assert.equal(parsed.candidates[0].confidence, 0.9);
assert.equal(parsed.evidence.valid, true);
assert.equal(parsed.fingerprint.length, 64);

assert.throws(() => parseLibraryArchivePlan({
  ...rawPlan,
  candidates: [{ ...rawPlan.candidates[0], sourceQuote: "不存在的句子" }],
}, { snapshot, documents, allowedTargetDocumentIds: ["canon-world"] }), /证据不在来源原文/u);

assert.throws(() => parseLibraryArchivePlan({
  ...rawPlan,
  candidates: [{ ...rawPlan.candidates[0], targetDocumentId: "library-reference" }],
}, { snapshot, documents }), /目标必须是设定或大纲/u);

assert.throws(() => parseLibraryArchivePlan({
  ...rawPlan,
  candidates: [{ ...rawPlan.candidates[0], operation: "replace" }],
}, { snapshot, documents, allowedTargetDocumentIds: ["canon-world"] }), /禁止全文覆盖/u);

const compared = compareLibraryArchiveCandidates({ plan: parsed, documents });
assert.equal(compared.candidates[0].comparison, "target_section_exists");

const operations = buildLibraryArchiveOperations({ plan: parsed, documents });
assert.equal(operations.operations.length, 1);
assert.equal(operations.operations[0].type, "patch");
assert.equal(operations.operations[0].targetDocumentId, "canon-world");
assert.equal(operations.expectedRevisions["canon-world"], "canon-r4");

assert.match(libraryArchiveExecutionInstruction(parsed), /资料库原文只作为参考来源/u);
assert.match(libraryArchiveOutputContract(parsed), /canon-world/u);

console.log("Library archive plan, evidence, idempotency and target safety tests passed");

