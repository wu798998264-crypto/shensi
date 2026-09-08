import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { mergeAgentExecutionTaskRoute } from "../src/agent-task-route-merge.js";
import { classifyAssistantOutput } from "../src/assistant-output-kind.js";
import { latestRecoverableCandidate } from "../src/candidate-chapters.js";
import { codexAgentCandidatePreview } from "../src/codex-agent-candidate-preview.js";
import { assistantChoicePrompt } from "../src/conversation-choice-panel.js";
import { resolveDocumentTarget } from "../src/document-target-resolver.js";
import { bindFormalWriteCandidate } from "../src/formal-write-authorization.js";
import { formalArtifactCommitEligibility } from "../src/formal-artifact-extractor.js";
import { fullTextImportInstructionRequested } from "../src/full-text-import-contract.js";
import { buildAdaptiveTaskRoute, resolveRequestedMode } from "../src/request-routing.js";
import { compileTaskContract, normalizeTaskContract } from "../src/task-contract.js";

const authoritativeContract = compileTaskContract({
  taskType: "writing",
  operation: "create",
  objective: "创作第一章并直接落盘",
  deliverables: [{ id: "chapter-one", kind: "prose", targetDocumentId: "chapter-1" }],
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "model",
  sourceMessageId: "user-write-chapter",
});

const normalized = normalizeTaskContract(authoritativeContract, {
  operation: "replace",
  sourceMessageId: "runtime-message",
});
assert.equal(normalized.operation, "create", "下游参数不得改写权威合同的操作类型");
assert.equal(normalized.sourceMessageId, "user-write-chapter", "下游不得把合同重新绑定到另一条消息");

const preparedRoute = buildAdaptiveTaskRoute({
  text: "创作第一章并直接落盘",
  sourceMessageId: "user-write-chapter",
  target: { documentId: "chapter-1", moduleId: "manuscript", revision: "revision-1" },
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
  taskContract: authoritativeContract,
}, { executionSurface: "agent" });

assert.equal(preparedRoute.runtimeRerouteAllowed, false, "权威 TaskContract 生成后不得再做运行时语义重路由");
const mergedRoute = mergeAgentExecutionTaskRoute({
  preparedRoute,
  runtimeRoute: {
    mode: "general",
    recommendedMode: "general",
    action: "analyze",
    targetDocumentId: "chapter-9",
    targetRevision: "runtime-revision",
    commitDisposition: "no_artifact",
    commitOwner: "none",
    writeAuthorization: { state: "none", action: "analyze" },
    taskPolicy: { action: "analyze", commitDisposition: "no_artifact", commitOwner: "none" },
    runtimeRerouteAllowed: true,
  },
});
assert.equal(mergedRoute.mode, preparedRoute.mode, "运行时结果不得覆盖权威合同确定的任务模式");
assert.equal(mergedRoute.action, preparedRoute.action, "运行时结果不得覆盖权威合同确定的动作");
assert.equal(mergedRoute.targetDocumentId, "chapter-1", "运行时结果不得改写权威目标文档");
assert.equal(mergedRoute.targetRevision, "revision-1", "运行时结果不得改写权威目标版本");
assert.equal(mergedRoute.commitDisposition, preparedRoute.commitDisposition, "运行时结果不得取消已授权事务");
assert.equal(mergedRoute.commitOwner, preparedRoute.commitOwner, "运行时结果不得接管提交责任");
assert.equal(mergedRoute.writeAuthorization.state, "commit", "运行时结果不得撤销或替换正式写入授权");
assert.equal(mergedRoute.runtimeRerouteAllowed, false);

const invalidContract = compileTaskContract({
  taskType: "writing",
  operation: "create",
  objective: "创作第一章并落盘",
  deliverables: [{ id: "wrong-type", kind: "setting", targetDocumentId: "chapter-1" }],
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "model",
  sourceMessageId: "user-invalid-contract",
});
const blockedRoute = buildAdaptiveTaskRoute({
  text: "创作第一章并直接落盘",
  sourceMessageId: "user-invalid-contract",
  target: { documentId: "chapter-1", moduleId: "manuscript" },
  taskContract: invalidContract,
}, { executionSurface: "agent" });
assert.equal(blockedRoute.hardBlocked, true);
assert.equal(blockedRoute.mode, "general", "无效的权威合同必须进入中性阻断态，不能回退到关键词创作路由");
assert.equal(blockedRoute.action, "discuss", "无效的权威合同不能被关键词重新解释成生成任务");
assert.equal(blockedRoute.commitDisposition, "no_artifact");
assert.equal(blockedRoute.runtimeRerouteAllowed, false);

const discussionContract = compileTaskContract({
  taskType: "discussion",
  operation: "assist",
  objective: "只回答当前问题，不修改、保存或落盘任何文档",
  deliverables: [],
  persistence: "none",
  targetResolution: "unresolved",
  semanticSource: "model",
  sourceMessageId: "user-discussion-only",
});
const discussionRoute = buildAdaptiveTaskRoute({
  text: "请只回答：你真正想让读者记住的判断或情绪是什么？不要修改、保存或落盘任何文档。",
  sourceMessageId: "user-discussion-only",
  target: { documentId: "report-source-preview", moduleId: "reports" },
  taskContract: discussionContract,
});
assert.equal(discussionRoute.mode, "general");
assert.equal(discussionRoute.commitDisposition, "no_artifact");
assert.equal(resolveRequestedMode({
  requestedMode: "creative_guidance",
  text: "【上一轮创作目标】生成正文\n【本轮要求】只回答当前问题，不落盘",
  targetDocumentId: "report-source-preview",
  hasResources: true,
  continuesCreativeThread: true,
  taskContract: discussionContract,
}), "general", "服务端不得用历史关键词或残留引导状态覆盖权威的仅对话合同");
const staleFormalRuntimeRoute = {
  ...discussionRoute,
  action: "generate",
  commitDisposition: "auto_commit",
  commitOwner: "shensi_transaction",
  formalArtifactExpected: true,
  writeAuthorization: {
    state: "commit",
    action: "replace",
    sourceMessageId: "user-discussion-only",
    targetDocumentIds: ["report-source-preview"],
    expectedRevisions: { "report-source-preview": "revision-old" },
  },
};
assert.deepEqual(classifyAssistantOutput({
  instruction: "只回答，不落盘",
  route: staleFormalRuntimeRoute,
  result: { candidate: "即使下游错误返回一段很长的所谓正式内容，也不能升级合同。".repeat(20) },
}), { kind: "discussion", landingEligible: false, reason: "task_contract_has_no_artifact" });
assert.deepEqual(formalArtifactCommitEligibility({ route: staleFormalRuntimeRoute, runStatus: "completed" }), {
  eligible: false,
  reason: "task_contract_has_no_artifact",
});
assert.equal(codexAgentCandidatePreview({
  text: "这是一段不应成为候选的长回答。".repeat(30),
  route: staleFormalRuntimeRoute,
  target: { documentId: "report-source-preview", moduleId: "reports" },
  instruction: "只回答，不落盘",
}), null, "Agent 下游即使残留正式标志，也不得为仅对话合同建立候选");

assert.equal(fullTextImportInstructionRequested("请生成第一章完整小说正文并直接落盘"), false);
assert.equal(fullTextImportInstructionRequested("分析前三章完整小说正文的问题，然后修改并落盘"), false);
assert.equal(fullTextImportInstructionRequested("请把附件中的小说全文导入"), true);
assert.equal(fullTextImportInstructionRequested("请将附件全文拆分并落盘"), true);

const manuscript = { documentId: "chapter-1", moduleId: "manuscript", contextDomain: "novel", title: "第一章" };
const chapterOutline = { documentId: "outline-chapter-1", moduleId: "outline", contextDomain: "outline", title: "第1章章纲" };
const worldSetting = { documentId: "canon-world", moduleId: "canon", contextDomain: "setting", title: "世界观与基础规则" };
assert.equal(resolveDocumentTarget({
  instruction: "生成第1章章纲",
  boundTarget: manuscript,
  semanticTargets: [manuscript, chapterOutline],
  inventory: [manuscript, chapterOutline],
}).target?.documentId, "outline-chapter-1", "章号不能让章纲误入正文域");
assert.equal(resolveDocumentTarget({
  instruction: "更新世界观设定",
  boundTarget: manuscript,
  semanticTargets: [manuscript, worldSetting],
  inventory: [manuscript, worldSetting],
}).target?.documentId, "canon-world", "真实 canon 文档必须被识别为设定域");

assert.equal(
  assistantChoicePrompt("你真正想让读者记住的判断或情绪是什么？"),
  null,
  "信息型开放问题不得按‘或’机械拆成选择框",
);
assert.equal(assistantChoicePrompt("请选择科幻或悬疑。"), null, "前端不得再根据回复文本自动推断选择题");

const candidateContract = compileTaskContract({
  taskType: "writing",
  operation: "create",
  objective: "先生成第一章候选稿",
  deliverables: [{ id: "chapter-one-candidate", kind: "prose", targetDocumentId: "chapter-1" }],
  persistence: "candidate_only",
  targetResolution: "exact",
  semanticSource: "model",
  sourceMessageId: "user-prose-candidate",
});
const candidateRoute = buildAdaptiveTaskRoute({
  text: "先生成第一章候选稿",
  sourceMessageId: "user-prose-candidate",
  target: { ...manuscript, revision: "revision-1" },
  expectedRevisions: { "chapter-1": "revision-1" },
  taskContract: candidateContract,
});
const proseCandidate = "第一章 三相初醒\n\n这是已经通过候选授权的旧正文内容。";
const candidateAuthorization = await bindFormalWriteCandidate(candidateRoute.writeAuthorization, {
  candidate: proseCandidate,
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
});
const candidateMessages = [
  { id: "user-prose-candidate", role: "user", content: "先生成第一章候选稿" },
  {
    id: "assistant-prose-candidate",
    role: "assistant",
    candidate: proseCandidate,
    target: manuscript,
    execution: {
      sourceMessageId: "user-prose-candidate",
      endedAt: 100,
      taskRoute: { ...candidateRoute, writeAuthorization: candidateAuthorization },
    },
  },
];
assert.equal(latestRecoverableCandidate({
  messages: candidateMessages,
  fallbackTarget: manuscript,
  instruction: "执行小说自检并生成自检报告",
}), null, "明确请求自检报告时不得恢复旧正文候选");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(app, /currentCandidateAuthorization:\s*null/u, "新对话记录必须显式初始化候选授权");
assert.match(app, /state\.currentCandidateAuthorization\s*=\s*null/u, "切入新对话必须清空活动候选授权");
assert.match(app, /pendingConversationChoice\.kind\s*!==\s*"media_connection"[\s\S]{0,160}closeConversationChoicePanel/u,
  "新对话必须清空非媒体选择状态且不改动媒体配置链路");
assert.doesNotMatch(app, /手动保存历史版本[\s\S]{0,650}offerPostLandingMaterialsUpdate/u,
  "手动保存版本后不得自动弹出资料更新选择");
assert.doesNotMatch(app, /queueMicrotask\(\(\)\s*=>\s*offerPostLandingMaterialsUpdate\(message\)\)/u,
  "正式候选落盘后不得自动弹出资料更新选择");
assert.match(app, /只分析当前内容/u, "续写歧义框必须提供非续写退出路径");
assert.match(app, /取消本次任务/u, "续写歧义框必须允许直接取消");
assert.match(app, /章节增量覆盖/u, "记忆指标必须说明只统计章节增量");
assert.match(app, /语义完整性(?:仍需|未)验收/u, "记忆面板不得把基础覆盖率冒充语义完整率");
assert.match(app, /const requestMode = authoritativeTaskContract[\s\S]{0,140}\? taskRoute\.mode/u,
  "客户端残留创作引导状态不得覆盖权威 TaskContract 的运行模式");
assert.match(app, /conversationOnlyExecution[\s\S]{0,700}"对话协作"/u,
  "仅对话任务的执行面板不得继续显示为正式正文链");
assert.match(app, /const guidedExecution = execution\.strength === "guidance"[\s\S]{0,420}const conversationOnlyExecution = !guidedExecution/u,
  "创作引导必须从普通仅对话展示语义中单独识别");
assert.match(app, /defaultExpanded = pending \|\| agentExecution \|\| guidedExecution/u,
  "创作引导执行详情默认应展开，便于核对实际 Skill");
assert.match(server, /taskContract:\s*submittedCreativeTask\.taskContract\s*\?\?\s*null/u,
  "服务端必须把冻结后的 TaskContract 传入创作任务路由");

console.log("Shensi semantic orchestration simplification tests passed");
