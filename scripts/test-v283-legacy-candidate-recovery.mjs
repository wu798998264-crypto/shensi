import assert from "node:assert/strict";

import { latestRecoverableCandidate } from "../src/candidate-chapters.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { bindFormalWriteCandidate } from "../src/formal-write-authorization.js";
import { codexAgentCandidatePreview } from "../src/codex-agent-candidate-preview.js";

const target = { documentId: "chapter-6", revision: "revision-6", chapterNumber: 6, explicitChapter: true };
const user = { id: "user-draft", role: "user", content: "先写一版看看" };
const ordinaryAnswer = {
  id: "assistant-analysis",
  role: "assistant",
  content: "第6章 修改建议\n\n这一章的问题主要在节奏。建议先收紧开场，再检查人物动机，但不要改正文。",
  target,
  execution: { sourceMessageId: user.id },
};
assert.equal(latestRecoverableCandidate({ messages: [user, ordinaryAnswer], fallbackTarget: target }), null);

const analysisRoute = buildAdaptiveTaskRoute({
  text: "只分析一下这章应该怎么修改",
  sourceMessageId: "user-analysis",
  target,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}, { executionSurface: "agent" });
const misleadingAnalysis = "第6章 修改建议\n\n这一章的核心问题是开场节奏松散。建议压缩说明、强化人物动机，并保留原文不动。";
assert.equal(codexAgentCandidatePreview({
  text: misleadingAnalysis,
  instruction: "只分析一下这章应该怎么修改",
  route: analysisRoute,
  target,
}), null, "带章节标题的长篇分析也不能取得候选资格");
assert.equal(latestRecoverableCandidate({
  messages: [
    { id: "user-analysis", role: "user", content: "只分析一下这章应该怎么修改" },
    { id: "assistant-analysis-candidate", role: "assistant", candidate: misleadingAnalysis, target, execution: { sourceMessageId: "user-analysis", taskRoute: analysisRoute } },
  ],
  fallbackTarget: target,
}), null, "模型误返回 candidate 字段时仍必须清空恢复入口");

const legacyCandidate = {
  id: "assistant-legacy",
  role: "assistant",
  candidate: "第6章 北灵院\n\n旧候选没有授权合同。",
  target,
  execution: { sourceMessageId: user.id },
};
assert.equal(latestRecoverableCandidate({ messages: [user, legacyCandidate], fallbackTarget: target }), null);

const route = buildAdaptiveTaskRoute({
  text: user.content,
  sourceMessageId: user.id,
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}, { executionSurface: "chat" });
const candidate = "第6章 北灵院\n\n夜色落在北灵院，山门内传来急促的脚步声。";
const authorization = await bindFormalWriteCandidate(route.writeAuthorization, {
  candidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
});
const authorizedMessage = {
  id: "assistant-candidate",
  role: "assistant",
  candidate,
  target,
  execution: {
    sourceMessageId: user.id,
    taskRoute: { ...route, writeAuthorization: authorization },
  },
};
const recovered = latestRecoverableCandidate({ messages: [user, authorizedMessage], fallbackTarget: target });
assert.equal(recovered.candidate.includes("夜色落在北灵院"), true);
assert.equal(recovered.sourceMessageId, user.id);
assert.equal(recovered.authorization.state, "candidate_only");

const wrongTarget = { ...authorizedMessage, target: { ...target, documentId: "chapter-7" } };
assert.equal(latestRecoverableCandidate({ messages: [user, wrongTarget], fallbackTarget: { ...target, documentId: "chapter-7" } }), null);

const recentOrdinary = {
  ...ordinaryAnswer,
  id: "assistant-recent",
  createdAt: new Date(Date.now() + 1000).toISOString(),
};
const stillRecovered = latestRecoverableCandidate({
  messages: [user, authorizedMessage, { id: "user-question", role: "user", content: "这章节奏怎么样？" }, recentOrdinary],
  fallbackTarget: target,
  instruction: "落盘",
});
assert.equal(stillRecovered.sourceMessageId, user.id, "普通回答不能替代最近的合法候选来源");

console.log("Shensi v2.83 legacy candidate recovery tests passed");
