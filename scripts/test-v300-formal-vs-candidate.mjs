import assert from "node:assert/strict";
import { agentDecision } from "./fixtures/agent-decision.mjs";
import { readFile } from "node:fs/promises";

import { classifyAssistantOutput } from "../src/assistant-output-kind.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";

const target = { documentId: "chapter-8", title: "未命名", exists: true, revision: "rev-1" };
const routeFor = (text, sourceMessageId, decision) => buildAdaptiveTaskRoute({
  agentDecision: decision,
  text,
  sourceMessageId,
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}, { executionSurface: "chat" });

const directRoute = routeFor("直接续写当前章节并落盘", "user-direct", agentDecision({ operation: "append" }));
assert.equal(directRoute.writeAuthorization.state, "commit");
assert.equal(classifyAssistantOutput({
  instruction: "直接续写当前章节并落盘",
  route: directRoute,
  result: { candidate: "正文第一段。\n\n正文第二段。" },
}).kind, "formal_artifact", "普通正式写作不得被当成多候选");

const candidateRoute = routeFor("先写三版候选，不要落盘", "user-candidates", agentDecision({ intent: "candidate" }));
assert.equal(candidateRoute.writeAuthorization.state, "candidate_only");
assert.equal(classifyAssistantOutput({
  instruction: "先写三版候选，不要落盘",
  route: candidateRoute,
  result: { candidate: "候选一" },
  candidateCount: 3,
}).kind, "candidate_group");

const discussionRoute = routeFor("只分析一下这章的问题，不要改正文", "user-discussion", agentDecision({ mode: "general", intent: "none" }));
assert.equal(discussionRoute.writeAuthorization.state, "none");
assert.equal(classifyAssistantOutput({
  instruction: "只分析一下这章的问题，不要改正文",
  route: discussionRoute,
  result: { content: "节奏需要收紧。" },
}).kind, "discussion");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /import\s+\{\s*classifyAssistantOutput\s*\}/u, "普通 Agent 回复不得再依赖前端关键词输出分类");
assert.match(app, /materializeCandidateDraftBranches\(/u, "原生 Agent 候选事件必须进入候选分支管理");
assert.match(app, /nativeAgentRunId/u, "真实回复处理必须绑定原生 Agent 运行实例");
assert.match(app, /当前没有识别到可直接写入的正式内容。请说明要写入哪条回复或哪一段/u, "没有识别到正式内容时必须主动澄清且不得混用候选稿术语");
assert.match(app, /Agent 已生成正式内容，正在自动落盘/u, "单一正式内容必须显示为正式内容而非候选稿");

console.log("Shensi v3.0 formal content and candidate separation tests passed");
