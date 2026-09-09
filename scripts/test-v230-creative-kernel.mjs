import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeSmartLandingPath,
  associatedDocumentId,
  automaticLandingDecision,
  conversationAssociationRoutingAnchorId,
  createTurnContextSnapshot,
  explicitNewDocumentIntent,
  toggleConversationDocumentAssociation,
  updateConversationDocumentAssociation,
} from "../src/automatic-landing-policy.js";
import { compileAgentTaskPolicy, requestsMultipleCandidates } from "../src/agent-task-policy.js";
import { buildUnifiedCreativeTask, creativeCommitAuthorization } from "../src/creative-task.js";
import { detectShensiRunProfile } from "../src/server/shensi-orchestrator.mjs";
import { applyDocumentMutation, applyDocumentPatch } from "../src/document-patch-engine.js";
import { contextCompilationBudget } from "../src/context-compiler.js";
import { blockingCreativeContextIds, buildAdaptiveTaskRoute, canonicalNovelChapterRequestTarget, freshNovelOpeningTarget, hasExplicitCreativeProductionIntent, hasExplicitFormalAssetWriteIntent } from "../src/request-routing.js";
import { explicitlyDefersCandidateLanding, isGenerationAndLandingRequest, requestedChapterTarget } from "../src/chapter-target.js";
import { buildConversationCapsule, conversationMessageEligibleForModel, conversationMessagesForActiveAssociation, explicitHistoricalContinuityAnchors, extractAcceptedConversationPlans, rebuildConversationDerivedContext } from "../src/conversation-context.js";
import { hasSubstantiveVersionContent } from "../src/version-store.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { explicitWorkspaceTransitionIntent, planNotebookContentPromotion, resolveWorkspaceLandingScope } from "../src/workspace-scope-policy.js";
import { creativeGuidanceQuestion, normalizeCreativeGuidanceState } from "../src/creative-guidance-contract.js";
import { creativeGuidanceDepthPrompt, normalizePendingCreativeDecision, pendingDecisionIsActionable } from "../src/pending-decision-policy.js";
import { authorCockpitDecisionEditorHtml, authorCockpitOverviewHtml, authorCockpitPendingDocumentHtml, pendingDecisionDisplay, pendingDecisionItems } from "../src/author-cockpit.js";
import { stripInternalAssistantProtocol } from "../src/assistant-visible-content.js";
import { generationResultMayDefaultLand } from "../src/generation-attempt-client.js";
import { latestRecoverableCandidate } from "../src/candidate-chapters.js";
import { explicitReviewReportReference } from "../src/review-delivery-policy.js";
import { createBlankProjectState } from "../src/data.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { loadTypeTheoryContext } from "../src/server/shensi-context.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { generationAttemptCandidateVariants } from "../src/server/generation-attempt-store.mjs";

const lazyCockpitWorkspace = createBlankProjectState({ name: "驾驶舱按需建档验收" });
for (const documentId of ["report-novel", "report-script", "report-adaptation", "index-pending", "index-update-log"]) {
  assert.equal(Boolean(lazyCockpitWorkspace.documents[documentId]), false, `${documentId} 没有实际内容时不得创建空占位文档`);
}
assert.equal(Boolean(lazyCockpitWorkspace.documents["report-compile"]), true, "项目总览是实时派生视图，应继续存在");
assert.equal(Boolean(lazyCockpitWorkspace.documents["index-language-blacklist"]), true, "创作合同提供固定可填写表单，应继续存在");
assert.equal(explicitReviewReportReference("打开小说自检报告"), true);
assert.equal(explicitReviewReportReference("把这份多余报告塞入编译报告"), false, "编译报告板块不能成为任意报告的兜底目标");
assert.deepEqual(
  explicitNewDocumentIntent("先不要写正文、不要创建空占位文档；请只提出四个具体问题。"),
  { create: false, title: "", reason: "not_requested" },
  "禁止创建占位文档的约束不能反向触发新建文档",
);
assert.equal(
  explicitNewDocumentIntent("不要创建空占位文档；有正式内容以后再新建文档，命名为第一章 雾桥吞火").title,
  "第一章 雾桥吞火",
  "同一指令稍后的明确新建要求仍应正常生效",
);
const guidanceOnlyRoute = buildAdaptiveTaskRoute({
  text: "我们要在当前新作品中创作一部长篇中文小说。现在开启创作引导：先不要写正文、不要创建空占位文档，只向我提出四个具体问题。",
  targetDocumentId: "chapter-1",
  targetModuleId: "manuscript",
  workspaceKind: "project",
});
assert.equal(guidanceOnlyRoute.mode, "creative_guidance", "明确只做创作引导的新作请求不得进入正文生产链");
assert.equal(guidanceOnlyRoute.commitDisposition, "no_artifact", "纯创作引导不得获得自动落盘授权");
const recoveredGuidancePrompt = "请继续刚才的创作引导，只问一个问题，不生成正文；不要创建或修改任何文档。";
assert.equal(buildAdaptiveTaskRoute({
  text: recoveredGuidancePrompt,
  targetDocumentId: "chapter-1",
  targetModuleId: "manuscript",
  workspaceKind: "project",
  continuesCreativeThread: true,
}, { executionSurface: "agent" }).mode, "creative_guidance", "失败后继续引导不得因 chapter-1 目标或否定分句改道正文生产");
assert.equal(hasExplicitFormalAssetWriteIntent({ text: recoveredGuidancePrompt }), false, "恢复引导中的否定正文/文档动作不得取得正式写入授权");
assert.equal(buildUnifiedCreativeTask({ instruction: "只追问，不写正文", operation: "assist" }).commitPolicy.defaultDisposition, "no_artifact");
assert.equal(detectShensiRunProfile({
  prompt: "请继续追问人物关系和秘密揭示次序，不写正文。",
  routingText: "创作长篇小说",
  requestMode: "creative_guidance",
}).explicitGuidanceOnly, true);
assert.equal(detectShensiRunProfile({
  prompt: "先不要写正文、不要创建空占位文档；请像责任编辑一样，围绕主角欲望和核心冲突向我提出四个具体问题。",
  routingText: "创作长篇小说",
  requestMode: "creative_guidance",
}).explicitGuidanceOnly, true, "禁止正文与提问要求分处两个分句时仍必须停留在创作引导");
assert.equal(detectShensiRunProfile({
  prompt: "把确认内容写入资料、设定和全书大纲，不写正文。",
  routingText: "创作长篇小说",
  requestMode: "creative_guidance",
}).explicitGuidanceOnly, false, "明确写入非正文正式资产时不能被“不写正文”误判成纯讨论");
assert.equal(creativeGuidanceQuestion({
  state: { ready: true, deliverableType: "novel" },
  proposedQuestion: "叶昭最不能失去什么？",
  force: true,
}), "叶昭最不能失去什么？", "纯引导轮次即使模型误把合同标为完成，也必须返回可见问题");
assert.equal(normalizeCreativeGuidanceState({ deliverableType: "novel", prompt: "直接写" }).interactionMode, "direct", "明确直写必须跳过机械选择");

const firstChapterLandingPrompt = [
  "现在直接创作《雾都铜心》第1章《雾桥吞火》的正式中文小说正文。",
  "本章至少1500个汉字，必须有可感知的场景、人物行动、对白、冲突、转折和改变后续局面的章节结尾。",
  "自动新建或定位标题为“第1章 雾桥吞火”的章节文档并落盘；只处理本章，不覆盖其他章节。",
].join("\n");
const parsedFirstChapter = requestedChapterTarget(firstChapterLandingPrompt);
assert.deepEqual(parsedFirstChapter, { chapterNumber: 1, documentId: "chapter-1", chapterTitle: "雾桥吞火" });
assert.equal(explicitNewDocumentIntent(firstChapterLandingPrompt).create, true, "明确新建与明确章节可以同时成立");
assert.equal(explicitNewDocumentIntent(firstChapterLandingPrompt).title, "第1章 雾桥吞火", "中文引号后的‘章节文档’不能进入真实标题");
assert.equal(isGenerationAndLandingRequest(firstChapterLandingPrompt), true);
assert.equal(hasExplicitCreativeProductionIntent({ text: firstChapterLandingPrompt, targetDocumentId: "chapter-1" }), true);
const guardedSingleChapterPrompt = `${firstChapterLandingPrompt}\n只处理本章，不覆盖其他章节，不生成多个候选稿。`;
assert.equal(requestsMultipleCandidates(guardedSingleChapterPrompt), false, "禁止多个候选不能反向触发多候选模式");
assert.equal(explicitlyDefersCandidateLanding(guardedSingleChapterPrompt), false, "保护其他章节不能阻止当前章节落盘");
assert.equal(
  compileAgentTaskPolicy({
    text: guardedSingleChapterPrompt,
    route: { mode: "creative" },
    target: { documentId: "chapter-1" },
    candidateCount: 1,
  }).commitDisposition,
  "auto_commit",
  "单章生产中的否定保护约束必须保留自动落盘授权",
);
const isolatedFormalBodyPrompt = `${guardedSingleChapterPrompt}\n只把最终正式正文写入文档，不把说明、检查过程、协议字段、Markdown符号或自检报告写进正文。`;
assert.equal(explicitlyDefersCandidateLanding(isolatedFormalBodyPrompt), false, "成品隔离要求不能被误判为延期落盘");
const isolatedFormalBodyRoute = buildAdaptiveTaskRoute({
  text: isolatedFormalBodyPrompt,
  sourceMessageId: "v230-isolated-formal-body",
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  targetRevision: "revision-1",
  expectedRevisions: { "chapter-1": "revision-1" },
  workspaceKind: "project",
});
const sequentialRevisionVariants = generationAttemptCandidateVariants({
  candidates: [
    { stage: "creative", index: 0, text: "初稿正文" },
    { stage: "finished", index: 0, text: "自检修订后的正式正文" },
  ],
  adoptedCandidate: "自检修订后的正式正文",
  landingEligible: true,
});
assert.equal(sequentialRevisionVariants.length, 1, "内部初稿与终稿是串行修订，不得伪装成多个候选稿");
assert.equal(sequentialRevisionVariants[0].selectionRequired, false);
assert.equal(
  automaticLandingDecision({
    instruction: isolatedFormalBodyPrompt,
    result: { candidate: "自检修订后的正式正文", generationAttempt: { candidateVariants: sequentialRevisionVariants } },
    route: isolatedFormalBodyRoute,
  }).action,
  "land",
  "用户只要一份正文时，自检修订次数不得阻止自动落盘",
);
const parallelCandidateVariants = generationAttemptCandidateVariants({
  candidates: [
    { stage: "creative", index: 0, text: "方案一正文" },
    { stage: "creative", index: 1, text: "方案二正文" },
  ],
  adoptedCandidate: "方案一正文",
  landingEligible: true,
});
assert.equal(parallelCandidateVariants.length, 2);
assert.ok(parallelCandidateVariants.every((variant) => variant.selectionRequired === true), "真正并行生成的方案仍需作者选择");
const finalizedGuidanceAssetWrite = "最终决定：阿满在第九章背叛是假，第十八章才揭示。现在把确认内容正式写入资料、设定、全书大纲、伏笔与信息台阶，不写正文。";
assert.equal(hasExplicitFormalAssetWriteIntent({ text: finalizedGuidanceAssetWrite }), true);
const finalizedGuidanceAssetRoute = buildAdaptiveTaskRoute({
  text: finalizedGuidanceAssetWrite,
  sourceMessageId: "v230-finalized-guidance-asset",
  targetDocumentId: "memory-foreshadowing",
  targetModuleId: "memory",
  workspaceKind: "project",
});
assert.equal(finalizedGuidanceAssetRoute.mode, "creative", "明确写入正式资产时，“不写正文”不得把任务降级为创作引导");
assert.equal(finalizedGuidanceAssetRoute.commitDisposition, "auto_commit", "明确写入正式资产必须获得自动提交授权");
assert.equal(hasExplicitCreativeProductionIntent({ text: finalizedGuidanceAssetWrite }), true);
assert.equal(requestedChapterTarget(finalizedGuidanceAssetWrite), null, "故事设定中的章节揭示时点不得被当成落盘目标章节");
const canonicalFirstChapter = canonicalNovelChapterRequestTarget({
  currentTarget: {
    documentId: "chapter-1",
    moduleId: "canon",
    contextDomain: "novel",
    title: "人物关系",
    sourceAssociationDocumentId: "",
  },
  explicitChapterTarget: parsedFirstChapter,
  freshOpeningTarget: freshNovelOpeningTarget({ text: firstChapterLandingPrompt, workspaceKind: "project", deliverableType: "novel" }),
});
assert.equal(canonicalFirstChapter.documentId, "chapter-1");
assert.equal(canonicalFirstChapter.moduleId, "manuscript");
assert.equal(canonicalFirstChapter.title, "第1章 雾桥吞火");
assert.equal(canonicalFirstChapter.chapterTitle, "雾桥吞火");
assert.equal(canonicalFirstChapter.explicitArtifact, true);

const conversation = {
  boundDocumentId: "chapter-1",
  autoAssociateActiveDocument: true,
  intentTarget: { documentId: "huanjin-old" },
  constraintIndex: [{ text: "幻烬旧约束" }],
  contextCapsule: { text: "幻烬旧摘要" },
  contextBudget: { includedCount: 9 },
};
assert.equal(toggleConversationDocumentAssociation(conversation, "chapter-1"), false);
assert.equal(conversation.associationAnchorDocumentId, "chapter-1");
assert.equal(updateConversationDocumentAssociation(conversation, "chapter-2"), true);
assert.equal(conversation.autoAssociateActiveDocument, false);
assert.equal(conversation.boundDocumentId, "chapter-2");
assert.equal(associatedDocumentId(conversation, "chapter-2"), null);
assert.equal(conversationAssociationRoutingAnchorId(conversation, "chapter-2"), null, "取消关联后不得把旧绑定作为隐藏路由锚点");
assert.equal(conversation.associationRevision, 2);
assert.equal(conversation.intentTarget, null);
assert.deepEqual(conversation.constraintIndex, []);
assert.equal(conversation.contextCapsule, null);
assert.equal(conversation.contextBudget, null);
const turnSnapshot = createTurnContextSnapshot({
  conversation,
  workspaceKind: "notebook",
  workspacePath: "E:/神思/笔记/灵感",
  activeDocumentId: "chapter-2",
  documents: { "chapter-2": { title: "北灵台", revision: "r2" } },
});
assert.equal(turnSnapshot.activeDocumentId, "chapter-2");
assert.equal(turnSnapshot.associationEnabled, false);
assert.equal(turnSnapshot.documentRevision, "r2");

const isolatedMessages = conversationMessagesForActiveAssociation([
  { id: "old-user", role: "user", content: "写幻烬", turnContextSnapshot: { workspacePath: "E:/神思/作品", boundDocumentId: "huanjin", associationRevision: 0 } },
  { id: "old-assistant", role: "assistant", content: "幻烬旧内容" },
  { id: "new-user", role: "user", content: "续写上文", turnContextSnapshot: { workspacePath: "E:/神思/作品", boundDocumentId: "beilingtai", associationRevision: 1 } },
]);
assert.deepEqual(isolatedMessages.map((message) => message.id), ["new-user"]);

assert.equal(explicitWorkspaceTransitionIntent({ instruction: "在当前笔记本里写一篇小说", currentWorkspaceKind: "notebook" }).explicit, false);
assert.deepEqual(resolveWorkspaceLandingScope({ workspaceKind: "notebook", workspacePath: "E:/笔记/灵感", instruction: "写小说正文" }), {
  workspaceKind: "notebook",
  workspacePath: "E:/笔记/灵感",
  workspaceName: "",
  crossWorkspace: false,
  authorized: true,
  operation: "stay",
  reason: "current_workspace_is_authoritative",
});
const promoted = planNotebookContentPromotion({
  title: "北灵台资料",
  requestedProjectName: "北灵台",
  content: "人物设定：牧尘害怕失去妹妹。\n\n故事大纲：第一幕进入北灵院。\n\n第一章 北灵台\n风从院墙外吹来。",
});
assert.equal(promoted.preserveSource, true);
assert.equal(promoted.createEmptySections, false);
assert.ok(promoted.documents.every((document) => document.content.trim()));
assert.ok(promoted.documents.some((document) => document.moduleId === "library"));
assert.ok(promoted.documents.some((document) => document.moduleId === "manuscript"));

assert.equal(analyzeSmartLandingPath({
  instruction: "写入当前空白文档",
  result: { candidate: "第一章\n风从北灵台吹来。" },
  boundDocumentId: "blank",
  documents: { blank: { title: "第一章", html: "" } },
}).reason, "blank_bound_document");
assert.equal(analyzeSmartLandingPath({
  instruction: "续写",
  result: { candidate: "第三章\n雨停了。" },
  boundDocumentId: "chapter-2",
  documents: { "chapter-2": { title: "第二章", markdown: "这是已经存在的第二章正文。" } },
}).reason, "ambiguous_continuation_requires_choice", "未说明续写当前章还是下一章时不得替用户猜测目标");
assert.equal(analyzeSmartLandingPath({
  instruction: "续写当前文档",
  result: { candidate: "雨停了。" },
  boundDocumentId: "chapter-2",
  documents: { "chapter-2": { title: "第二章", markdown: "这是已经存在的第二章正文。" } },
}).target, "bound");

assert.equal(compileAgentTaskPolicy({ text: "这里的节奏太慢了", route: { mode: "creative" }, target: { documentId: "chapter-2" } }).action, "modify");
assert.equal(compileAgentTaskPolicy({ text: "帮我看看这个设定", route: { mode: "creative" }, target: { documentId: "canon-world" } }).action, "analyze");
assert.equal(compileAgentTaskPolicy({ text: "本次续写实际读取了哪些内容？", route: { mode: "creative" }, target: { documentId: "chapter-3" } }).action, "analyze");
assert.equal(compileAgentTaskPolicy({ text: "通用问答会不会自动覆盖当前文档？", route: { mode: "creative" }, target: { documentId: "chapter-3" } }).commitDisposition, "no_artifact");
assert.equal(compileAgentTaskPolicy({ text: "生成第三章正文", route: { mode: "creative" }, target: { documentId: "chapter-3" } }).commitDisposition, "auto_commit");
assert.equal(compileAgentTaskPolicy({ text: "生成三个候选版本", route: { mode: "creative" }, target: { documentId: "chapter-3" }, candidateCount: 3 }).commitDisposition, "defer_multiple");
assert.equal(compileAgentTaskPolicy({ text: "生成第三章正文，但先不要落盘", route: { mode: "creative" }, target: { documentId: "chapter-3" } }).commitDisposition, "defer_explicit");

assert.equal(creativeCommitAuthorization({ candidate: "正式正文", selfCheckStatus: "blocked" }).allowed, true);
assert.equal(creativeCommitAuthorization({ candidate: "正式正文", selfCheckStatus: "warning" }).code, "AUTHORIZED_WITH_REVIEW_WARNING");
assert.equal(creativeCommitAuthorization({ candidate: "正式正文", multipleCandidates: true }).allowed, false);
assert.equal(creativeCommitAuthorization({ candidate: "" }).code, "NO_VALID_ARTIFACT");
assert.equal(generationResultMayDefaultLand({
  candidate: "正式正文",
  engineExecution: { validationStatus: "blocked", landingStatus: "ready" },
}), true);

const task = buildUnifiedCreativeTask({
  instruction: "自检并修改后写入",
  context: { associatedDocumentId: "chapter-2", initialBoundDocumentId: "chapter-1", associationEnabled: false },
  target: { documentId: "chapter-2" },
  operation: "patch",
});
assert.equal(task.context.associationEnabled, false);
assert.equal(task.context.initialBoundDocumentId, "chapter-1");
assert.equal(task.qualityPolicy.maxRepairRounds, 2);
assert.equal(task.commitPolicy.subjectiveReviewBlocksCommit, false);

const renamed = applyDocumentPatch("林夏走进房间。林夏抬起头。", { type: "rename", from: "林夏", to: "林雪", expectedOccurrences: 2 });
assert.equal(renamed, "林雪走进房间。林雪抬起头。");
assert.throws(() => applyDocumentPatch("林夏走进房间。", { type: "rename", from: "林夏", to: "林雪", expectedOccurrences: 2 }), /命中数量已变化/u);
assert.deepEqual(applyDocumentMutation({ content: "旧名出现", title: "旧标题", patches: [{ type: "rename", from: "旧名", to: "新名" }], requestedTitle: "新标题" }), { content: "新名出现", title: "新标题" });

assert.equal(hasSubstantiveVersionContent(""), false);
assert.equal(hasSubstantiveVersionContent("<p>在右侧对话中确定创作意图后开始填写。</p>"), false);
assert.equal(hasSubstantiveVersionContent("<h1>第二章 北灵台</h1>", { title: "第二章 北灵台" }), false);
assert.equal(hasSubstantiveVersionContent("<p>第一章正式正文。</p>"), true);

assert.equal(pendingDecisionIsActionable("继续优化人物"), false);
assert.equal(pendingDecisionIsActionable("暂无明确硬冲突，当前状态正常"), false);
assert.equal(pendingDecisionIsActionable("是否需要新增一份设定出场节奏表"), false);
assert.equal(pendingDecisionIsActionable("女主是否在第二场就知道父亲隐瞒了失踪真相？"), true);
const pendingDecision = normalizePendingCreativeDecision({
  question: "女主是否在第二场就知道父亲隐瞒了失踪真相？",
  source: "第二章第二场",
  sourcePath: "04_正文/小说/第一卷/第二章.md",
  options: [{ label: "立即知情", impact: "会提前改变父女冲突" }, { label: "暂不知情", impact: "保留后续揭示" }],
  recommendation: "暂不知情",
  affectedScopes: ["设定", "大纲", "正文"],
});
assert.equal(pendingDecision.options.length, 2);
assert.equal(pendingDecision.sourcePath, "04_正文/小说/第一卷/第二章.md");
assert.equal(pendingDecisionDisplay(pendingDecision).sourcePath, "04_正文/小说/第一卷/第二章.md");
assert.equal(pendingDecisionDisplay(pendingDecision).question, "女主是否在第二场就知道父亲隐瞒了失踪真相？");
const legacyPendingDocument = {
  markdown: [
    "# 待确认事项",
    "| 内容 | 来源 | 需要确认的问题 |",
    "| --- | --- | --- |",
    "| 暂无明确硬冲突 | 09_索引/检查.md | 当前状态正常，无需确认 |",
    "| 女主知情边界 | 04_正文/小说/第一卷/第二章.md | 女主是否在第二场就知道父亲隐瞒了失踪真相？ |",
    "| 设定出场节奏记录 | 02_正史设定/人物设定.md | 是否需要新增一份设定出场节奏表 |",
  ].join("\n"),
};
const legacyPendingItems = pendingDecisionItems(legacyPendingDocument);
assert.equal(legacyPendingItems.length, 1);
assert.equal(legacyPendingItems[0].sourcePath, "04_正文/小说/第一卷/第二章.md");
assert.match(legacyPendingItems[0].question, /女主知情边界/u);
const pendingMarkup = authorCockpitPendingDocumentHtml({
  documentState: { cockpitDecisionItems: [pendingDecision] },
});
assert.ok(pendingMarkup.indexOf("04_正文/小说/第一卷/第二章.md") < pendingMarkup.indexOf("女主是否在第二场"));
assert.doesNotMatch(pendingMarkup, /建议处理|暂不知情/u);
assert.match(pendingMarkup, /data-confirm-cockpit-decision="[^"]+" disabled/u);
const confirmedPendingMarkup = authorCockpitPendingDocumentHtml({
  documentState: {
    cockpitDecisionItems: [{
      ...pendingDecision,
      status: "confirmed",
      opinion: "保留为后续伏笔，先同步信息台阶与全集大纲。",
    }],
  },
});
assert.match(confirmedPendingMarkup, /data-state="confirmed"/u);
assert.match(confirmedPendingMarkup, /已确认 1/u);
assert.match(confirmedPendingMarkup, /textarea[^>]+readonly/u);
assert.match(confirmedPendingMarkup, /data-edit-cockpit-decision/u);
assert.match(confirmedPendingMarkup, /执行已确认项目（1）/u);
assert.doesNotMatch(confirmedPendingMarkup, /type="checkbox"|data-select-cockpit-decision/u);
assert.doesNotMatch(confirmedPendingMarkup, /data-send-cockpit-decision/u);
const pendingOverviewMarkup = authorCockpitOverviewHtml({
  documents: { "index-pending": { cockpitDecisionItems: [pendingDecision] } },
  decision: { status: "attention", metrics: { actionCount: 1 } },
});
assert.match(pendingOverviewMarkup, /data-open-cockpit-decision=/u);
assert.match(pendingOverviewMarkup, /data-run-integrity-scan/u, "索引总览必须提供手动一致性扫描入口");
assert.match(pendingOverviewMarkup, /检查作品一致性/u);
assert.doesNotMatch(pendingOverviewMarkup, /data-cockpit-decision-opinion|data-confirm-cockpit-decision|type="checkbox"/u);
const pendingDialogMarkup = authorCockpitDecisionEditorHtml({ item: pendingDecision, index: 0 });
assert.match(pendingDialogMarkup, /data-cockpit-decision-opinion/u);
assert.match(pendingDialogMarkup, /data-confirm-cockpit-decision/u);
assert.equal(normalizePendingCreativeDecision({ ...pendingDecision, status: "editing", draftOpinion: "保留草稿" }).status, "pending");
const editedPendingDecision = normalizePendingCreativeDecision({
  ...pendingDecision,
  status: "pending",
  opinion: "原确认批示",
  draftOpinion: "修改后的第一段。\n\n修改后的第二段。",
});
assert.equal(editedPendingDecision.draftOpinion, "修改后的第一段。\n\n修改后的第二段。");
assert.match(authorCockpitDecisionEditorHtml({ item: editedPendingDecision, index: 0 }), /修改后的第一段。[\s\S]*修改后的第二段。/u);
assert.equal(pendingDecisionItems({ cockpitDecisionItems: [{ ...pendingDecision, status: "confirmed", opinion: "采用方案" }] })[0].status, "confirmed");
assert.deepEqual(pendingDecisionItems({
  markdown: legacyPendingDocument.markdown,
  cockpitDecisionItems: [{ question: "暂无明确硬冲突，当前状态正常", sourcePath: "09_索引/检查.md" }],
}), []);
assert.match(creativeGuidanceDepthPrompt(), /对白表层信息与潜台词/u);
assert.match(creativeGuidanceDepthPrompt(), /讨论|开放式问题/u, "创作引导必须采用讨论优先规则");

assert.equal(conversationMessageEligibleForModel({ role: "assistant", content: "已撤回", rolledBack: true }), false);
assert.equal(conversationMessageEligibleForModel({ role: "assistant", candidate: "未采用稿", candidateSelected: false }), false);
assert.equal(conversationMessageEligibleForModel({ role: "assistant", content: "活动回答" }), true);
const staleConversation = {
  contextCapsule: { text: "包含已撤回内容" },
  contextConstraintIndex: { items: [{ text: "旧约束" }] },
  candidateBranchGroups: [{ id: "g1", versions: [{ messageId: "removed" }] }],
};
rebuildConversationDerivedContext(staleConversation, [{ id: "active", role: "user", content: "当前问题" }]);
assert.equal(staleConversation.contextCapsule, null);
assert.equal(staleConversation.candidateBranchGroups.length, 0);
assert.doesNotMatch(stripInternalAssistantProtocol("正式正文。\n\n```yaml\ntarget_document_id: chapter-2\noperation: append_content\n```"), /target_document_id/u);
assert.deepEqual(explicitHistoricalContinuityAnchors("继续前面的故事，保留周岑、雾港、铜铃三个关键设定并推进结局。"), ["周岑", "雾港", "铜铃"]);

const budget = contextCompilationBudget({ modelContextCharacters: 160_000, selectedDocumentCount: 12 });
assert.ok(Number.isFinite(budget.maxCharacters));
assert.ok(Number.isFinite(budget.perDocumentLimit));
assert.ok(budget.maxCharacters <= 180_000 && budget.perDocumentLimit <= 24_000);
assert.deepEqual(blockingCreativeContextIds({
  text: "续写当前章节",
  targetDocumentId: "chapter-8",
  missingRequiredIds: ["outline-series", "canon-characters", "chapter-7"],
}), []);
assert.deepEqual(blockingCreativeContextIds({
  text: "修改当前章节",
  targetDocumentId: "chapter-8",
  missingRequiredIds: ["chapter-8", "outline-series"],
  existingAssetIntent: true,
}), ["chapter-8"]);

const messages = [
  { id: "u1", role: "user", content: "请给出自动落盘和上下文优化方案。" },
  { id: "a1", role: "assistant", content: "实施方案：正式文稿默认自动落盘；建立任务路由、候选稿账本、最小上下文、历史版本和验收流程。".repeat(4) },
  { id: "u2", role: "user", content: "ok" },
  ...Array.from({ length: 16 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", content: `中间话题 ${index}` })),
];
const plans = extractAcceptedConversationPlans(messages);
assert.equal(plans.length, 1);
assert.equal(plans[0].planMessageId, "a1");
const capsule = buildConversationCapsule(messages, { recentLimit: 6, maxChars: 12_000 });
assert.match(capsule.text, /用户已经确认的较早执行方案/u);
assert.match(capsule.text, /正式文稿默认自动落盘/u);

const candidateHistory = [
  { id: "formal-request", role: "user", content: "直接生成新版正文" },
  { id: "formal", role: "assistant", candidate: "第一章\n雨落在长街上，这是本轮最新正式正文。", target: { documentId: "chapter-1" }, execution: { sourceMessageId: "formal-request", endedAt: 100, taskRoute: { writeAuthorization: bindFormalWriteCandidate(createFormalWriteAuthorization({ instruction: "直接生成新版正文", sourceMessageId: "formal-request", targetDocumentIds: ["chapter-1"], targetExists: true }), { candidate: "第一章\n雨落在长街上，这是本轮最新正式正文。" }) } } },
  { id: "review-request", role: "user", content: "直接生成这篇正文的自检报告" },
  { id: "review", role: "assistant", candidate: "自检报告：节奏可以加强。", target: { documentId: "chapter-1" }, execution: { sourceMessageId: "review-request", endedAt: 200, taskRoute: { writeAuthorization: bindFormalWriteCandidate(createFormalWriteAuthorization({ instruction: "直接生成这篇正文的自检报告", sourceMessageId: "review-request", targetDocumentIds: ["chapter-1"], targetExists: true }), { candidate: "自检报告：节奏可以加强。" }) } } },
];
assert.match(latestRecoverableCandidate({ messages: candidateHistory, instruction: "写入文档" }).candidate, /最新正式正文/u);
assert.equal(latestRecoverableCandidate({ messages: candidateHistory, instruction: "把自检报告写入编译报告" }).deliverableType, "review_report");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const verifierSource = await readFile(new URL("../src/server/server-context-verifier.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const exactReplacementPlannerSource = appSource.slice(appSource.indexOf("const localEditPlan"), appSource.indexOf("const contextualReplacementPlan"));
assert.match(exactReplacementPlannerSource, /inferExactReplacementEditPlan\(\{[\s\S]{0,700}requestId:\s*candidateTarget\?\.generationAttemptRequestId\s*\|\|\s*uid\("local-patch"\)/u,
  "局部替换规划器必须使用本轮候选或独立生成的 Request ID，不能依赖已移除的 Chat 变量",
);
assert.doesNotMatch(appSource, /compileContextSections\([\s\S]{0,900}maxCharacters:\s*Number\.POSITIVE_INFINITY/u);
assert.doesNotMatch(verifierSource, /maxCharacters:\s*Number\.POSITIVE_INFINITY/u);
assert.doesNotMatch(appSource, /updateConversationDocumentAssociation\(selectedConversation, documentId\)/u,
  "切换浏览文档不得重新绑定或切换当前对话");
assert.match(serverSource, /requestSnapshot\s*=\s*\{[\s\S]{0,1500}skillRuntime:\s*publicSkillRuntime/u);
assert.match(serverSource, /contextManifest:\s*verifiedContextManifest/u);
assert.match(serverSource, /const targetMutationImpossible = contextGateRoute\.existingAssetIntent === true/u);
assert.doesNotMatch(serverSource, /if \(contextDependencyReport\.terminal\) \{/u);
assert.doesNotMatch(appSource, /<small>\$\{index \+ 1\}<\/small>/u);
assert.match(appSource, /cockpitDecision:\s*\{ itemId, decisionType, opinion: normalizedOpinion \}/u);
assert.match(appSource, /status:\s*"confirmed"[\s\S]{0,260}confirmedDecision:\s*opinion/u);
assert.match(appSource, /item\.status === "confirmed"[\s\S]{0,180}String\(item\.opinion/u);
assert.doesNotMatch(appSource, /authorCockpitSelectedDecisionIds|data-select-cockpit-decision/u);
assert.match(appSource, /const selected = pendingDecisionItems\(pendingDocument\)\.filter\(\(item\) => \([\s\S]{0,160}item\.status === "confirmed"[\s\S]{0,160}String\(item\.opinion/u);
assert.match(appSource, /status:\s*"pending"[\s\S]{0,180}draftOpinion:\s*item\.draftOpinion \|\| item\.opinion/u);
assert.match(appSource, /persistCockpitDecisionDraftSoon\(\)/u);
assert.match(appSource, /renderContextChips\(\);\s+scheduleConversationQueueDrain\(conversation\.id\);/u);
assert.match(appSource, /authorCockpitDecisionDialog\.showModal\(\)/u);
assert.doesNotMatch(appSource, /closeAuthorCockpitDecisionDialogFooter/u);
assert.match(appSource, /伏笔信息确认[\s\S]{0,500}严禁修改任何正文/u);
assert.doesNotMatch(appSource, /data-send-cockpit-decision/u);
assert.match(appSource, /const updateCockpitDecisionDraftFromTextarea[\s\S]{0,500}draftOpinion/u);
assert.match(appSource, /applyWorkspaceOperationPlan\(completion\.id, \{ automatic: true, confirmed: true \}\)/u);
assert.match(appSource, /来源文档：\$\{display\.sourcePath\}[\s\S]{0,180}具体问题：\$\{display\.question\}/u);
const cockpitProcessSource = appSource.slice(appSource.indexOf("const processCockpitDecisionItem"), appSource.indexOf("const processCockpitDecisionBatchWithAgent"));
assert.doesNotMatch(cockpitProcessSource, /hasModelConfiguration\(\)|ui\.generating\s*\|\|\s*ui\.operationApplying/u);
assert.match(stylesSource, /\.generation-order-list\s*\{[\s\S]{0,500}background:\s*var\(--surface-primary, #fff\)/u);
assert.match(stylesSource, /\.text-dialog\.author-cockpit-decision-dialog\s*\{[\s\S]{0,300}width:\s*min\(1000px/u);
assert.match(stylesSource, /\.author-cockpit-decision-dialog-body \.author-cockpit-decision-directive textarea\s*\{[\s\S]{0,160}min-height:\s*320px/u);
assert.doesNotMatch(stylesSource, /\.dreamina-account-metrics > span \+ span::before/u);

const bundledShensiRoot = fileURLToPath(new URL("../packaging/bundled/skill/\u795e\u601d/", import.meta.url));
const projectRoutedTheory = await loadTypeTheoryContext({
  shensiRoot: bundledShensiRoot,
  prompt: "\u7ee7\u7eed\u5199\u5f53\u524d\u7ae0\u8282",
  projectContext: "\u4f5c\u54c1\u7c7b\u578b\uff1a\u79d1\u5e7b\u7f51\u6587\uff1b\u5f53\u524d\u7ae0\u8282\u4e3a\u7b2c\u5341\u4e8c\u7ae0\u3002",
  workspaceKind: "project",
});
assert.equal(projectRoutedTheory.matched, true, "\u7528\u6237\u4e0d\u91cd\u590d\u9898\u6750\u65f6\uff0c\u5e94\u4ece\u4f5c\u54c1\u4e0a\u4e0b\u6587\u8def\u7531 Skill \u7406\u8bba");
assert.equal(projectRoutedTheory.family, "novel");
assert.match(projectRoutedTheory.label, /\u79d1\u5e7b/u);
assert.ok(projectRoutedTheory.ruleCount >= 2);

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v230-transaction-"));
try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "workspace");
  const initial = createBlankProjectState("v230事务验收");
  initial.documents["chapter-1"] = { title: "旧标题", markdown: "旧标题", html: "<h1>旧标题</h1>", moduleId: "manuscript" };
  initial.moduleItems.manuscript.push(["chapter-1", "旧标题", { workspaceView: "novel" }]);
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: initial });
  const firstTransactionCandidate = "林夏走进雨巷。";
  const firstTransactionAuthorization = {
    ...bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction: "直接替换当前文档正文",
    sourceMessageId: "v230-first-write",
    targetDocumentIds: ["chapter-1"],
    targetExists: true,
    }), { candidate: firstTransactionCandidate }),
    allowTitleMutation: true,
  };
  await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: { executionSurface: "chat", operation: "replace", instruction: "直接替换当前文档正文", authorizedCandidate: firstTransactionCandidate, writeAuthorization: firstTransactionAuthorization, target: { documentId: "chapter-1" } },
    operations: [{ operationId: "first-write", type: "replace", targetDocumentId: "chapter-1", requestedTitle: "新标题", content: firstTransactionCandidate }],
  });
  let loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(loaded.state.documents["chapter-1"].title, "新标题");
  assert.equal(loaded.state.histories["chapter-1"]?.length || 0, 0, "只有标题的占位文档首次写入不得产生历史版本");
  const patchTransactionCandidate = "林雪";
  const patchTransactionAuthorization = {
    ...bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction: "直接改写当前章节",
    sourceMessageId: "v230-patch",
    targetDocumentIds: ["chapter-1"],
    targetExists: true,
    hasSelection: true,
    }), { candidate: patchTransactionCandidate }),
    allowTitleMutation: true,
  };
  await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: { executionSurface: "agent", operation: "patch", instruction: "直接改写当前章节", authorizedCandidate: patchTransactionCandidate, writeAuthorization: patchTransactionAuthorization, target: { documentId: "chapter-1" } },
    operations: [{ operationId: "rename-character", type: "patch", targetDocumentId: "chapter-1", requestedTitle: "第一章 雨巷", patches: [{ type: "rename", from: "林夏", to: "林雪", expectedOccurrences: 1 }] }],
  });
  loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.match(loaded.state.documents["chapter-1"].markdown, /林雪/u);
  assert.equal(loaded.state.documents["chapter-1"].title, "雨巷");
  assert.equal(loaded.state.histories["chapter-1"].length, 1);
  assert.match(loaded.state.histories["chapter-1"][0].content, /林夏/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Shensi v2.3.0 creative task kernel contracts passed");
