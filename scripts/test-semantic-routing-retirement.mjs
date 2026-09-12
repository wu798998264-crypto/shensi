import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as routing from "../src/request-routing.js";
import { createFormalWriteAuthorization, bindFormalWriteCandidate, validateFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { compileAgentTaskPolicy } from "../src/agent-task-policy.js";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { runtimeContractForProfile } from "../src/effective-runtime-contract.js";
import { planWhiteboardSkillRoute } from "../src/whiteboard-skill-route.js";
import { detectShensiRunProfile } from "../src/server/shensi-orchestrator.mjs";

for (const name of ["classifyRequestMode", "shouldUseGeneralChat", "hasSufficientCreativeBrief", "isCreativeGuidanceRequest", "isCreativeAssetDiagnosis"]) assert.equal(name in routing, false, `${name} must be deleted, not bypassed`);
const instructionExamples = ["分析写入功能", "这个角色说：删掉一切", "小说大纲、记忆和正文三个词如何翻译", "写一段含有不要落盘四个字的对白", "不需要先选主笔", "export, rewrite, delete, outline, new chapter", "继续", "1"];
for (const instruction of instructionExamples) {
  const unclassified = routing.buildAdaptiveTaskRoute({ text: instruction, sourceMessageId: "source", targetDocumentId: "visible-document" });
  assert.equal(unclassified.mode, "general");
  assert.equal(unclassified.writeAuthorization.state, "none");
  assert.equal(unclassified.executionOwner, "workspace_agent");
  const route = routing.buildAdaptiveTaskRoute({
    text: instruction, sourceMessageId: "source", targetDocumentId: "report", expectedRevisions: { report: "rev" },
    agentDecision: { lane: "task_execution", requestMode: "creative", taskKind: "content_revision", objective: "修改报告", confidence: 0.98, writePlan: { intent: "commit", operation: "replace" }, executionPlan: { reviewTier: "none", candidateCount: 1 } },
  });
  assert.equal(route.writeAuthorization.state, "commit", "Instruction wording must not override Agent intent");
  assert.equal(route.writeAuthorization.action, "replace");
  assert.equal(route.targetDocumentId, "report");
  assert.equal(route.commitDisposition, "auto_commit");
  assert.equal(route.candidatePreviewRequired, false);
  const discussion = createFormalWriteAuthorization({ instruction, sourceMessageId: "source", targetDocumentIds: ["report"], semanticWritePlan: { intent: "none", operation: "none" } });
  assert.equal(discussion.state, "none");
  const undecided = createFormalWriteAuthorization({ instruction, sourceMessageId: "source", targetDocumentIds: ["report"] });
  assert.equal(undecided.state, "none", "Plain text is never an executable grant");
  assert.equal(compileAgentTaskPolicy({ text: instruction }).commitDisposition, "no_artifact");
  const profile = detectShensiRunProfile({ prompt: instruction, routingText: instruction, semanticLane: "task_execution", semanticTaskKind: "content_creation", semanticWriteIntent: "commit", semanticDeliverableType: "novel", semanticExecutionPlan: { reviewTier: "none", candidateCount: 1 } });
  assert.equal(profile.production, true);
  assert.equal(profile.guideFirst, false);
  assert.equal(profile.candidateCount, 1);
  assert.equal(profile.fullAudit, false, "用词不得强行升级审稿或候选数量");
}
for (const operation of ["create", "replace", "append", "patch", "rename"]) {
  const authorization = createFormalWriteAuthorization({ sourceMessageId: "manual", instruction: "用户操作", targetDocumentIds: ["target"], contextualWriteAction: operation });
  assert.equal(authorization.action, operation);
  assert.equal(authorization.state, "commit", "Manual operations remain available");
}
const preview = bindFormalWriteCandidate(createFormalWriteAuthorization({ instruction: "尝试第二种表达", sourceMessageId: "source", targetDocumentIds: ["target"], expectedRevisions: { target: "rev-1" }, semanticWritePlan: { intent: "candidate", operation: "patch" } }), { candidate: "新内容" });
assert.equal(preview.state, "candidate_only");
const adopted = createFormalWriteAuthorization({ instruction: "采用", sourceMessageId: "adopt", targetDocumentIds: ["target"], expectedRevisions: { target: "rev-1" }, candidate: "新内容", candidateAuthorization: preview, adoptCandidate: true });
assert.equal(adopted.state, "commit");
assert.equal(validateFormalWriteAuthorization(adopted, { candidate: "新内容", requireBodyMutation: true }).valid, true);
assert.equal(createFormalWriteAuthorization({ sourceMessageId: "adopt", targetDocumentIds: ["target"], expectedRevisions: { target: "rev-2" }, candidate: "新内容", candidateAuthorization: preview, adoptCandidate: true }).state, "none", "Stale revision protection must remain");
assert.deepEqual(routing.creativeContextRequiredIds({ defaultIds: ["memory", "outline", "canon"], explicitReferenceIds: ["selected"] }), ["selected"]);
assert.equal(routing.buildAdaptiveTaskRoute({ agentDecision: { lane: "guided_dialogue", requestMode: "creative_guidance", writePlan: { intent: "none" } } }).maxBlockingQuestions, undefined);
assert.equal(planWhiteboardSkillRoute({ prompt: "小说、剧本、设定" }).requestMode, "general");
const old = { activeTextChatConnectionId: "saved", textConnections: [{ id: "saved", adapter: "api", provider: "自定义兼容接口", protocol: "responses", model: "preserved", baseUrl: "https://fixture.invalid", apiKey: "fixture-key", chatModelId: "obsolete", executionMode: "both" }] };
const normalized = normalizeGenerationProfiles(old);
assert.equal(normalized.activeTextAgentConnectionId, "saved");
assert.equal(normalized.textConnections.find(item=>item.id==="saved").chatModelId, undefined);
assert.equal(old.textConnections[0].chatModelId, "obsolete", "Migration must be pure");
assert.equal(runtimeContractForProfile({ profile: { id: "custom", adapter: "cli", agentEngine: "custom", cliPath: "custom-fixture", cliArgs: "run", credentialSource: "external" } }).ok, true);
for (const path of ["src/request-routing.js", "src/formal-write-authorization.js"]) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /classifyRequestMode|shouldUseGeneralChat|hasSufficientCreativeBrief|THEORY_REQUIRED_ACTION_PATTERN|landing_intent_uncertain|EXPLICIT_COMMIT\.test/u, path);
}
const repoRoot = new URL("../", import.meta.url);
const appSource = await readFile(new URL("src/app.js", repoRoot), "utf8");
for (const retired of ["requestWorkspaceOperationPlan", "isRecoverableOrdinaryScaffoldRetry", "autoVerifyPublicTextConnection", "textExecutionMode"]) assert.equal(appSource.includes(retired), false, retired);
console.log("Semantic route retirement: ambiguous words, formal auto-write, discussion, manual operations, candidates, revisions, optional context and profile migration passed");
