import assert from "node:assert/strict";
import { agentDecision, reportContract } from "./fixtures/agent-decision.mjs";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization, validateFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { compileTaskContract } from "../src/task-contract.js";

const target = { documentId: "chapter-6", revision: "revision-6" };
const routeFor = (instruction, decision, extra = {}) => buildAdaptiveTaskRoute({
  text: instruction, sourceMessageId: "source", target,
  targetDocumentId: target.documentId, targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision }, agentDecision: decision, ...extra,
});
for (const text of ["只分析一下这章应该怎么修改", "告诉我应该如何修改这一章，不要改正文", "给修改建议、不要动原文", "讨论如何续写", "这章哪里需要调整"]) {
  const route = routeFor(text, agentDecision({ mode: "general", intent: "none", taskKind: "quality_review" }));
  assert.equal(route.writeAuthorization.state, "none");
  assert.equal(route.commitDisposition, "no_artifact");
}
for (const [instruction, operation, state] of [
  ["续写当前章节", "append", "commit"],
  ["生成一篇公众号文章到已有文档", "replace", "commit"],
  ["生成一篇公众号文章到新文档", "create", "commit"],
  ["继续完善这个故事", "replace", "commit"],
  ["先写一版看看", "replace", "candidate_only"],
  ["只修改标题", "rename", "commit"],
]) {
  const route = routeFor(instruction, agentDecision({ intent: state === "commit" ? "commit" : "candidate", operation }));
  assert.equal(route.writeAuthorization.state, state);
  assert.equal(route.writeAuthorization.action, operation);
  assert.equal(route.writeAuthorization.allowBodyMutation, state === "commit" && operation !== "rename");
  assert.equal(route.landingConfirmationRequired, false);
}
const report = routeFor("保存自检报告，保留正文", null, { taskContract: reportContract({ sourceMessageId: "source" }) });
assert.deepEqual(report.writeAuthorization.targetDocumentIds, ["report-novel"]);
assert.equal(report.writeAuthorization.state, "commit");
const batch = compileTaskContract({ taskType: "modification", operation: "batch", objective: "修复前三章", semanticSource: "agent", sourceMessageId: "source", persistence: "commit", targetResolution: "exact", deliverables: [1,2,3].map(n=>({id:`chapter-${n}`,kind:"prose",targetDocumentId:`chapter-${n}`})) });
const batchRoute = routeFor("依次修复", null, { taskContract: batch });
assert.equal(batchRoute.writeAuthorization.state, "commit");
assert.deepEqual(batchRoute.writeAuthorization.targetDocumentIds, ["chapter-1", "chapter-2", "chapter-3"]);
const candidate = "第6章 北灵院\n\n夜色落在山门前。";
const draft = routeFor("先写一版看看", agentDecision({intent:"candidate"}));
const bound = bindFormalWriteCandidate(draft.writeAuthorization, { candidate });
assert.ok(bound.candidateHash);
const identity = { sourceMessageId: "source", instruction: "先写一版看看", candidate, targetDocumentIds: [target.documentId], expectedRevisions: { [target.documentId]: target.revision } };
assert.equal(validateFormalWriteAuthorization(bound, identity).valid, true);
for (const mutation of [{sourceMessageId:"other"},{instruction:"另一条指令"},{candidate:candidate+"篡改"},{targetDocumentIds:["chapter-7"]},{expectedRevisions:{[target.documentId]:"newer"}}]) assert.equal(validateFormalWriteAuthorization(bound, {...identity,...mutation}).valid, false);
const adopt = { instruction:"采用此稿",sourceMessageId:"adopt",targetDocumentIds:[target.documentId],expectedRevisions:{[target.documentId]:target.revision},candidate,candidateAuthorization:bound,adoptCandidate:true };
const adopted = createFormalWriteAuthorization(adopt);
assert.equal(adopted.state,"commit");
assert.equal(validateFormalWriteAuthorization(adopted,{candidate,requireBodyMutation:true}).valid,true);
assert.equal(createFormalWriteAuthorization({...adopt,candidate:candidate+"不同"}).state,"none");
assert.equal(createFormalWriteAuthorization({...adopt,sourceMessageId:""}).state,"none");
console.log("Formal write: semantic plan, formal default, report targeting, multi-document contract, candidate identity and stale-proof protection passed");
