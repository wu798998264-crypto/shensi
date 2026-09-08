import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  normalizeUnifiedAgentDecision,
  unifiedAgentEntrySystemPrompt,
} from "../src/unified-agent-entry.js";
import {
  compareLibraryArchiveCandidates,
  createLibraryArchiveSnapshot,
  libraryArchivePlanningOutputContract,
  parseLibraryArchivePlan,
} from "../src/library-archive-plan.js";

const workflowDecision = normalizeUnifiedAgentDecision({
  lane: "task_execution",
  workflow: "library_archive",
  objective: "读取当前作品资料库并拆分归档到设定和大纲",
  requestMode: "workspace_operation",
  readPlan: [{ reference: "当前作品资料库", required: true, purpose: "提取有证据的信息" }],
  writePlan: { intent: "candidate", targetKind: "unspecified", operation: "patch" },
});
assert.equal(workflowDecision.workflow, "library_archive");
assert.equal(normalizeUnifiedAgentDecision({ lane: "direct_reply", workflow: "library_archive", reply: "普通回答" }).workflow, "",
  "闲聊通道不得携带资料库归档工作流");
assert.equal(normalizeUnifiedAgentDecision({ lane: "task_execution", workflow: "invented" }).workflow, "",
  "未知工作流必须被规范化层拒绝");

const entryPrompt = unifiedAgentEntrySystemPrompt();
assert.match(entryPrompt, /完整意图是读取当前作品或笔记本内的资料库来源/u);
assert.match(entryPrompt, /普通资料问答、引用资料续写正文/u,
  "普通资料读取不得被关键词误判为归档事务");
assert.match(entryPrompt, /宿主读取可信资料库快照/u);

const planningContract = libraryArchivePlanningOutputContract({ targetDocumentIds: ["canon-world", "outline-series"] });
assert.match(planningContract, /"candidates"/u);
assert.doesNotMatch(planningContract, /"artifacts"/u,
  "规划阶段必须返回候选计划，而不是误用执行阶段交付物合同");

const documents = {
  "library-reference": { title: "资料", revision: "source-r1", moduleId: "library", markdown: "旧港位于北岸。旧港每逢月蚀封航。" },
  "canon-world": { title: "世界观", revision: "target-r1", moduleId: "canon", markdown: "# 世界观\n\n旧港位于北岸。" },
};
const snapshot = createLibraryArchiveSnapshot({
  documents,
  sourceDocumentIds: ["library-reference"],
  projectId: "archive-flow-test",
});
const duplicatePlan = parseLibraryArchivePlan({
  schema: "shensi.library-archive-plan.v1",
  candidates: [{
    sourceDocumentId: "library-reference",
    sourceQuote: "旧港位于北岸。",
    targetDocumentId: "canon-world",
    targetSection: "世界观",
    disposition: "duplicate",
    operation: "patch",
    content: "",
  }],
}, {
  snapshot,
  documents,
  allowedTargetDocumentIds: ["canon-world"],
});
assert.equal(duplicatePlan.candidates.length, 1, "无写入正文的重复项也必须保留在确认摘要中");
assert.equal(duplicatePlan.candidates[0].disposition, "duplicate");

const unsafeCreate = parseLibraryArchivePlan({
  schema: "shensi.library-archive-plan.v1",
  candidates: [{
    sourceDocumentId: "library-reference",
    sourceQuote: "旧港每逢月蚀封航。",
    targetDocumentId: "canon-world",
    disposition: "new",
    operation: "create",
    content: "## 航运规则\n\n旧港每逢月蚀封航。",
  }],
}, {
  snapshot,
  documents,
  allowedTargetDocumentIds: ["canon-world"],
});
const compared = compareLibraryArchiveCandidates({ plan: unsafeCreate, documents });
assert.equal(compared.candidates[0].operation, "patch", "已有目标不得被 create 操作覆盖");
assert.equal(compared.candidates[0].disposition, "update");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const workflowBranch = serverSource.indexOf('agentDecision.workflow === "library_archive"');
const genericDecisionBranch = serverSource.indexOf('agentDecision.openDecision?.question', workflowBranch);
assert.ok(workflowBranch > 0 && genericDecisionBranch > workflowBranch,
  "归档专用计划必须先于通用固定决定面板执行");
assert.match(serverSource, /runAgentLibraryArchivePlanning\(\{/u);
assert.match(serverSource, /libraryArchiveConfirmationDecision\(prepared\)/u);
assert.match(serverSource, /allowFreeText:\s*false/u, "归档提交确认不得被自由文本误触发");
assert.match(serverSource, /workflowPayload:\s*\{[\s\S]{0,500}plan:\s*prepared\.plan/u);
assert.match(serverSource, /const \{ workflowPayload: _privateWorkflowPayload, \.\.\.publicPendingDecision \} = pendingDecision/u,
  "完整归档计划只能保存在服务端待确认合同中，首次确认面板不得泄漏可篡改载荷");
assert.match(appSource, /fetch\("\/api\/workspace\/library-archive\/commit"/u);
assert.match(appSource, /const decisionResolutionActive = Boolean\(decisionResolution\?\.decisionId\)/u,
  "已签发的归档确认不得因为模型连接暂时不可用而回退成普通本地回复");
assert.match(appSource, /!hasActiveGenerationRuntime && !decisionResolutionActive/u,
  "只有没有待确认合同的消息才允许走无 Agent 连接的本地兜底");
assert.match(appSource, /normalizedWorkspacePath\(commitWorkspacePath\)[\s\S]{0,160}normalizedWorkspacePath\(taskWorkspaceScope\.workspacePath\)/u,
  "提交前必须再次核对任务发送时锁定的工作区");
assert.match(appSource, /libraryArchiveWorkspaceMutation\?\.status === "completed"[\s\S]{0,700}flushWorkspaceSave\(\{ throwOnError: true, recoverConflict: true \}\)/u,
  "原子提交后必须用冲突感知保存合并完成回执，不能让旧内存快照覆盖新文档");

console.log("Library archive conversation workflow contracts passed");
