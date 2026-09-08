import assert from "node:assert/strict";

import {
  NOVEL_MEMORY_DOCUMENT_IDS,
  compilePostCommitProjection,
} from "../src/post-commit-projection.js";

const prose = compilePostCommitProjection({ documents: [{ documentId: "chapter-4", moduleId: "manuscript", contextDomain: "novel" }] });
assert.deepEqual(prose.memory.eligibleDocumentIds, NOVEL_MEMORY_DOCUMENT_IDS);
assert.deepEqual(prose.canon.automaticDocumentIds, []);
assert.equal(prose.canon.requiresExplicitAuthorization, true);
assert.deepEqual(prose.outline.automaticDocumentIds, []);
assert.equal(prose.outline.requiresExplicitAuthorization, true);
assert.deepEqual(prose.cockpit.immediateDocumentIds, ["report-compile", "index-update-log", "index-pending"]);
assert.ok(prose.cockpit.formalReportDocumentIds.includes("report-novel"));
assert.equal(prose.cockpit.formalReportAuthorization, "explicit_self_check_only");
assert.equal(prose.cockpit.creativeContractMutation, "explicit_author_instruction_only");

const outline = compilePostCommitProjection({ documents: [{ documentId: "outline-chapter-4", moduleId: "outline", contextDomain: "novel" }] });
assert.equal(outline.memory.plannedContentMustNotBecomeRealized, true);
assert.deepEqual(outline.memory.realizedDocumentIds, []);
assert.deepEqual(outline.outline.automaticDocumentIds, []);

const canon = compilePostCommitProjection({ documents: [{ documentId: "canon-characters", moduleId: "canon", contextDomain: "novel" }] });
assert.deepEqual(canon.memory.realizedDocumentIds, []);
assert.deepEqual(canon.canon.automaticDocumentIds, []);
assert.equal(canon.canon.requiresExplicitAuthorization, true);

const adaptation = compilePostCommitProjection({
  documents: [{ documentId: "script-episode-2", moduleId: "manuscript", contextDomain: "script" }],
  crossFormat: true,
});
assert.ok(adaptation.cockpit.formalReportDocumentIds.includes("report-script"));
assert.ok(adaptation.cockpit.formalReportDocumentIds.includes("report-adaptation"));

console.log("Shensi v2.19 derived projection policy tests passed");
