import assert from "node:assert/strict";
import { agentDecision } from "./fixtures/agent-decision.mjs";
import { requestsMultipleCandidates } from "../src/agent-task-policy.js";
import { multiCandidateGenerationInstruction } from "../src/multi-candidate-plan.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { requestedCandidateVariantCount } from "../src/server/shensi-orchestrator.mjs";

assert.equal(requestsMultipleCandidates("继续写这一章"), false);
assert.equal(requestsMultipleCandidates("给我三版候选稿进行比较"), true);
assert.equal(requestsMultipleCandidates("给我四个候选版本"), true);
assert.equal(requestsMultipleCandidates("为当前文档生成3份候选稿"), true);
assert.equal(requestsMultipleCandidates("不要多个候选，只给一版"), false);
assert.equal(requestedCandidateVariantCount("给我两份不同候选稿"), 2);
assert.equal(requestedCandidateVariantCount("给我三版候选稿"), 3);
assert.equal(requestedCandidateVariantCount("给我四个候选版本"), 4);
assert.equal(requestedCandidateVariantCount("正常续写本章"), 0);

const configuredInstruction = multiCandidateGenerationInstruction({
  prompt: "写三份候选稿",
  count: 3,
  direction: "pacing",
});
const configuredRoute = buildAdaptiveTaskRoute({
  agentDecision: agentDecision({ intent: "candidate" }),
  text: configuredInstruction,
  sourceMessageId: "user-candidate-configured",
  target: { documentId: "chapter-1", revision: "revision-1" },
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
}, { executionSurface: "agent" });
assert.equal(configuredRoute.mode, "creative", "候选配置中的不自动落盘约束不得把创作任务降级为普通问答");
assert.equal(configuredRoute.candidatePreviewRequired, true, "多候选任务必须建立候选查看窗口");
assert.equal(configuredRoute.writeAuthorization.state, "candidate_only");
assert.equal(configuredRoute.commitDisposition, "candidate_only");

console.log("multi-candidate request routing regressions passed");
