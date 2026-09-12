import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeUnifiedAgentDecision } from "../src/unified-agent-entry.js";
import {
  agentReadPlanFailureMessage,
  agentSemanticSkillRoutingText,
  materializeAgentOpenDecision,
  reconcileAgentWriteTargetWithTaskContract,
  resolveAgentDocumentReference,
  resolveAgentReadPlan,
  resolveAgentWritePlanTarget,
  validateAgentDecisionResolution,
} from "../src/server/agent-decision-consumption.mjs";

const documents = {
  "doc-current": { title: "第一章" },
  "doc-setting": { title: "世界观设定" },
  "doc-duplicate-a": { title: "人物卡" },
  "doc-duplicate-b": { title: "人物卡" },
  "chapter-1": { title: "第1章" },
  "chapter-2": { title: "第2章" },
  "chapter-3": { title: "第3章" },
  "outline-chapter-3": { title: "第3章章纲" },
  "outline-chapter-4": { title: "第4章章纲" },
  "outline-chapter-5": { title: "第5章章纲" },
  "canon-world": { title: "世界观" },
  "canon-characters": { title: "人物设定" },
  "canon-factions": { title: "势力设定" },
  "canon-relations": { title: "人物关系" },
  "memory-chapters": { title: "章节记忆" },
  "memory-context": { title: "当前上下文包" },
};

assert.deepEqual(resolveAgentDocumentReference({
  reference: "submitted_document",
  documents,
  submittedDocumentId: "doc-current",
}), {
  status: "resolved",
  reference: "submitted_document",
  documentId: "doc-current",
  reason: "submitted_document",
});
assert.equal(resolveAgentDocumentReference({ reference: "世界观设定", documents }).documentId, "doc-setting");
assert.equal(resolveAgentDocumentReference({ reference: "《世界观设定》", documents }).documentId, "doc-setting", "书名号不应阻止精确标题匹配");
assert.equal(resolveAgentDocumentReference({ reference: "人物卡", documents }).status, "ambiguous");

const completeChapterRange = resolveAgentDocumentReference({ reference: "第1～3章正文", documents });
assert.equal(completeChapterRange.status, "resolved");
assert.deepEqual(completeChapterRange.documentIds, ["chapter-1", "chapter-2", "chapter-3"]);
const missingChapterRange = resolveAgentDocumentReference({ reference: "第4～10章正文", documents });
assert.equal(missingChapterRange.status, "unresolved");
assert.deepEqual(missingChapterRange.missingDocumentIds, ["chapter-4", "chapter-5", "chapter-6", "chapter-7", "chapter-8", "chapter-9", "chapter-10"]);
assert.deepEqual(resolveAgentDocumentReference({ reference: "第3～5章章纲", documents }).documentIds,
  ["outline-chapter-3", "outline-chapter-4", "outline-chapter-5"]);
assert.deepEqual(resolveAgentDocumentReference({ reference: "四份正史设定", documents }).documentIds,
  ["canon-world", "canon-characters", "canon-factions", "canon-relations"]);
assert.deepEqual(resolveAgentDocumentReference({ reference: "现有长文记忆", documents }).documentIds,
  ["memory-chapters", "memory-context"]);

const reads = resolveAgentReadPlan({
  readPlan: [
    { reference: "submitted_document", required: true, purpose: "承接正文" },
    { reference: "世界观设定", required: true, purpose: "核对设定" },
    { reference: "attachment:参考全文.md", required: true, purpose: "读取附件" },
    { reference: "不存在的资料", required: false, purpose: "可选参考" },
  ],
  documents,
  submittedDocumentId: "doc-current",
});
assert.deepEqual(reads.requiredDocumentIds, ["doc-current", "doc-setting"]);
assert.deepEqual(reads.externalReferences, ["attachment:参考全文.md"]);
assert.equal(reads.unresolvedRequired.length, 0);

const missingReads = resolveAgentReadPlan({
  readPlan: [{ reference: "不存在的资料", required: true }],
  documents,
});
assert.equal(missingReads.unresolvedRequired[0].reason, "not_found");

const rangeReads = resolveAgentReadPlan({
  readPlan: [{ reference: "第1～3章正文", required: true }],
  documents,
});
assert.deepEqual(rangeReads.requiredDocumentIds, ["chapter-1", "chapter-2", "chapter-3"]);
assert.equal(agentReadPlanFailureMessage({
  agentDecision: { taskKind: "quality_review", skillCapabilities: ["effect_reviewer"] },
  unresolvedRequired: [missingChapterRange],
}), "没有找到第4～10章正文，暂时无法自检。");
assert.equal(agentReadPlanFailureMessage({ unresolvedRequired: missingReads.unresolvedRequired }),
  "没有找到这次需要的内容，暂时无法继续。");

assert.equal(resolveAgentWritePlanTarget({
  writePlan: { intent: "commit", targetKind: "current", targetRef: "submitted_document", operation: "append" },
  documents,
  submittedDocumentId: "doc-current",
}).documentId, "doc-current");
assert.equal(resolveAgentWritePlanTarget({
  writePlan: { intent: "candidate", targetKind: "existing", targetRef: "世界观设定", operation: "replace" },
  documents,
}).documentId, "doc-setting");
assert.equal(resolveAgentWritePlanTarget({
  writePlan: { intent: "commit", targetKind: "new", targetRef: "第二章", operation: "create" },
}).requestedTitle, "第二章");

const authoritativeChapterContract = {
  protocol: "shensi_task_contract_v1",
  taskType: "writing",
  operation: "create",
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "agent",
  deliverables: [{ id: "chapter-1-prose", kind: "prose", targetDocumentId: "chapter-1", required: true }],
};
const reconciledNewChapter = reconcileAgentWriteTargetWithTaskContract({
  semanticWriteTarget: {
    status: "new",
    intent: "commit",
    targetKind: "new",
    documentId: "",
    requestedTitle: "第1章 雾桥吞火",
    reason: "new_document",
  },
  taskContract: authoritativeChapterContract,
});
assert.equal(reconciledNewChapter.status, "resolved", "已冻结合同的唯一章节目标不得被空语义新建目标覆盖");
assert.equal(reconciledNewChapter.documentId, "chapter-1");
assert.equal(reconciledNewChapter.requestedTitle, "第1章 雾桥吞火");
assert.equal(reconciledNewChapter.reason, "authoritative_task_contract_target");

const routingText = agentSemanticSkillRoutingText({ prompt: "继续处理", skillQueries: ["小说正文主笔", "节奏审校"] });
assert.match(routingText, /# Agent 语义能力需求/u);
assert.match(routingText, /小说正文主笔/u);
assert.doesNotMatch(routingText, /继续处理/u, "Skill 自动路由不得再用原始用户关键词二次判断");
assert.equal(agentSemanticSkillRoutingText({ prompt: "安装、写作或其他可触发词", skillQueries: [] }), "", "Agent 未请求 Skill 时不得自动加载");

const normalized = normalizeUnifiedAgentDecision({
  lane: "task_execution",
  writePlan: { intent: "commit", targetKind: "invented-kind", operation: "delete" },
});
assert.equal(normalized.writePlan.targetKind, "unspecified");
assert.equal(normalized.writePlan.operation, "none");

const openDecision = {
  id: "choose-destination",
  question: "这次写入哪一份文档？",
  options: [
    { id: "current", label: "当前文档", entityRefs: ["doc-current"], scopeDelta: "只授权当前文档" },
    { id: "setting", label: "世界观设定", entityRefs: ["doc-setting"], scopeDelta: "只授权设定文档" },
  ],
  allowFreeText: true,
};
const pending = materializeAgentOpenDecision({
  openDecision,
  taskId: "task-12345678",
  conversationId: "conversation-1",
  contractRevision: 3,
  now: 1_000,
  ttlMs: 60_000,
});
const repeated = materializeAgentOpenDecision({
  openDecision,
  taskId: "task-12345678",
  conversationId: "conversation-1",
  contractRevision: 3,
  now: 2_000,
  ttlMs: 60_000,
});
assert.equal(pending.id, repeated.id, "相同任务合同内的决定 ID 必须稳定");
assert.equal(pending.taskId, "task-12345678");
assert.equal(pending.contractRevision, 3);

const selected = validateAgentDecisionResolution({
  pendingDecision: pending,
  resolution: { decisionId: pending.id, taskId: pending.taskId, contractRevision: 3, optionId: "setting" },
  conversationId: "conversation-1",
  contractRevision: 3,
  now: 2_000,
});
assert.equal(selected.ok, true);
assert.equal(selected.resolution.answer, "世界观设定");
assert.deepEqual(selected.resolution.entityRefs, ["doc-setting"]);

const naturalLanguage = validateAgentDecisionResolution({
  pendingDecision: pending,
  resolution: { decisionId: pending.id, taskId: pending.taskId, contractRevision: 3, answer: "新建一份人物关系表" },
  conversationId: "conversation-1",
  contractRevision: 3,
  now: 2_000,
});
assert.equal(naturalLanguage.ok, true);
assert.equal(naturalLanguage.resolution.answer, "新建一份人物关系表");
assert.equal(validateAgentDecisionResolution({
  pendingDecision: pending,
  resolution: { decisionId: pending.id, taskId: pending.taskId, contractRevision: 2, optionId: "current" },
  conversationId: "conversation-1",
  contractRevision: 2,
  now: 2_000,
}).code, "AGENT_DECISION_CONTRACT_STALE");
assert.equal(validateAgentDecisionResolution({
  pendingDecision: pending,
  resolution: { decisionId: pending.id, taskId: pending.taskId, contractRevision: 3, optionId: "current" },
  conversationId: "conversation-1",
  contractRevision: 3,
  now: 70_000,
}).code, "AGENT_DECISION_EXPIRED");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /validateAgentDecisionResolution\(\{/u);
assert.match(serverSource, /materializeAgentOpenDecision\(\{/u);
assert.match(serverSource, /resolveAgentReadPlan\(\{/u);
assert.match(serverSource, /resolveAgentWritePlanTarget\(\{/u);
assert.match(serverSource, /prompt: semanticSkillRoutingPrompt/u);
assert.doesNotMatch(serverSource, /Agent 指定的必读资料无法唯一解析/u, "普通用户不得看到内部读取术语");
assert.ok(
  serverSource.indexOf("resolveAgentReadPlan({") < serverSource.indexOf("compileServerVerifiedContext({", serverSource.indexOf('pathname === "/api/agent/execute"')),
  "Agent readPlan 必须在服务端现场资料编译之前消费",
);

console.log("Agent decision consumption contracts passed");
