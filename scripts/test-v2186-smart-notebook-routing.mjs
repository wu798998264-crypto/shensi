import assert from "node:assert/strict";

import { compileAgentTaskPolicy } from "../src/agent-task-policy.js";
import { codexAgentCandidatePreview, codexAgentCompletionNeedsLandingProof } from "../src/codex-agent-candidate-preview.js";
import { buildAdaptiveTaskRoute, contextualCreativeRepairFollowup } from "../src/request-routing.js";
import {
  normalizeNotebookNarrativeRelationships,
  notebookSameWorkDocumentIds,
} from "../src/notebook-work-scope.js";
import { synchronizeDocumentDirectoryLabels } from "../src/document-title-policy.js";
import {
  agentPromptRequestsExecutionProvenance,
  agentPromptRequiresSkillSelection,
  agentSkillPromptIntent,
} from "../src/server/agent-skill-context.mjs";

const documents = {
  "note-1785861948844": { title: "第一章\u00a0北灵院", moduleId: "manuscript", contextDomain: "general" },
  "chapter-2": { title: "北灵台", moduleId: "manuscript", contextDomain: "novel", customSequenceTitle: true },
  "chapter-3": { title: "北苍来客", moduleId: "manuscript", contextDomain: "novel" },
  "chapter-4": { title: "洛字为警", moduleId: "manuscript", contextDomain: "novel" },
  "chapter-5": { title: "叛影", moduleId: "manuscript", contextDomain: "novel" },
  "unrelated-note": { title: "会议记录", moduleId: "manuscript", contextDomain: "general" },
  "script-episode-1": { title: "系统说我们是男生", moduleId: "manuscript", contextDomain: "script", workspaceView: "script" },
};
const volumeOptions = {
  workspaceView: "novel",
  contextDomain: "general",
  folderId: "manuscript-volume:第001卷-未命名",
  volumeFolder: "第001卷-未命名",
};
const moduleItems = {
  manuscript: [
    ["chapter-3", "第3章　北苍来客", { ...volumeOptions }],
    ["chapter-4", "第4章　洛字为警", { ...volumeOptions }],
    ["chapter-5", "第5章　叛影", { ...volumeOptions }],
    ["chapter-2", "北灵台", { ...volumeOptions, customSequenceTitle: true }],
    ["note-1785861948844", "第一章\u00a0北灵院", { workspaceView: "novel", contextDomain: "general" }],
    ["script-episode-1", "第1集　系统说我们是男生", { workspaceView: "script", contextDomain: "script" }],
    ["unrelated-note", "会议记录", { workspaceView: "novel", contextDomain: "general" }],
  ],
};

const normalizedDocuments = structuredClone(documents);
const normalizedItems = structuredClone(moduleItems);
assert.equal(normalizeNotebookNarrativeRelationships({
  documents: normalizedDocuments,
  moduleItems: normalizedItems,
}), true);
assert.equal(normalizedDocuments["note-1785861948844"].title, "北灵院");
assert.equal(normalizedDocuments["note-1785861948844"].sequenceNumber, 1);
assert.equal(normalizedDocuments["chapter-2"].sequenceNumber, 2);
assert.equal(normalizedDocuments["chapter-2"].customSequenceTitle, false);
assert.equal(normalizedDocuments["chapter-3"].previousDocumentId, "chapter-2");
assert.equal(normalizedDocuments["chapter-3"].nextDocumentId, "chapter-4");
assert.equal(
  normalizedDocuments["note-1785861948844"].workGroupId,
  normalizedDocuments["chapter-5"].workGroupId,
);
assert.equal(normalizedItems.manuscript.find(([id]) => id === "note-1785861948844")[1], "第1章　北灵院");
assert.equal(normalizedItems.manuscript.find(([id]) => id === "chapter-2")[1], "第2章　北灵台");
assert.equal(synchronizeDocumentDirectoryLabels({
  documents: normalizedDocuments,
  moduleItems: normalizedItems,
  language: "zh-CN",
}), false, "目录标题同步不得再次撤销规范化章节标签");
assert.equal(normalizedItems.manuscript.find(([id]) => id === "script-episode-1")[1], "第1集　系统说我们是男生");

const continuationContext = notebookSameWorkDocumentIds({
  currentDocumentId: "chapter-2",
  targetDocumentId: "chapter-4",
  documents: normalizedDocuments,
  moduleItems: normalizedItems,
});
assert.ok(continuationContext.includes("chapter-3"), "续写第四章必须读取已存在的第三章");
assert.ok(continuationContext.includes("note-1785861948844"), "非标准 ID 的第一章应通过章节序列被识别");
assert.ok(!continuationContext.includes("unrelated-note"), "无章节关系的普通笔记不得混入小说上下文");

const provenanceQuestion = "这几章分别调用了哪些资料和skill";
assert.equal(agentSkillPromptIntent(provenanceQuestion), "provenance_query");
assert.equal(agentPromptRequestsExecutionProvenance(provenanceQuestion), true);
assert.equal(agentPromptRequiresSkillSelection(provenanceQuestion), false);
assert.equal(agentPromptRequiresSkillSelection("你刚才使用了哪些 Skill？"), false);
assert.equal(agentPromptRequiresSkillSelection("Skill 是什么？"), false);
assert.equal(agentPromptRequiresSkillSelection("使用写作 Skill 续写第四章"), true);
assert.equal(agentPromptRequiresSkillSelection("不要使用 Skill，直接续写第四章"), false);
const provenancePolicy = compileAgentTaskPolicy({ text: provenanceQuestion, route: { mode: "general" } });
assert.equal(provenancePolicy.action, "analyze");
assert.equal(provenancePolicy.commitOwner, "none");
assert.equal(provenancePolicy.commitDisposition, "no_artifact");

const blockedContinuation = "无法可靠续写第四章，因为当前上下文没有读取到已经存在的第三章。请先打开第三章或补充相关资料后再试。";
assert.equal(codexAgentCandidatePreview({
  text: blockedContinuation,
  instruction: "续写第四章",
  route: {
    candidatePreviewRequired: true,
    action: "generate",
    commitOwner: "shensi_transaction",
    commitDisposition: "auto_commit",
  },
  target: { documentId: "chapter-4", chapterNumber: 4, explicitChapter: true },
}), null, "阻塞说明和补资料请求不得作为正式章节落盘");
assert.equal(codexAgentCandidatePreview({
  text: "这里只是在回答问题，不应写进任何文档。",
  instruction: provenanceQuestion,
  route: {
    candidatePreviewRequired: true,
    action: "analyze",
    commitOwner: "none",
    commitDisposition: "no_artifact",
  },
  target: { documentId: "chapter-4", chapterNumber: 4, explicitChapter: true },
}), null, "只读任务即使错误携带候选标记也必须被落盘防火墙拒绝");
const formalModificationRoute = {
  candidatePreviewRequired: true,
  action: "modify",
  commitOwner: "shensi_transaction",
  commitDisposition: "auto_commit",
};
assert.equal(codexAgentCompletionNeedsLandingProof({
  route: formalModificationRoute,
  runStatus: "completed",
  previewed: false,
}), true, "模型口头宣称完成但没有正式候选时必须拒绝完成状态");
assert.equal(codexAgentCompletionNeedsLandingProof({
  route: formalModificationRoute,
  runStatus: "completed",
  previewed: true,
}), false, "已进入候选和事务链时由磁盘回执继续裁决");
assert.equal(codexAgentCompletionNeedsLandingProof({
  route: provenancePolicy,
  runStatus: "completed",
  previewed: false,
}), false, "普通问答不需要落盘回执");

const batchRepairFollowup = contextualCreativeRepairFollowup({
  text: "依次修复",
  previousUserText: "自检1-5章",
  previousAssistantText: "自检结论：1-5章存在玉简规则、人物代价和动机铺垫不足的问题。",
});
assert.ok(batchRepairFollowup);
assert.equal(batchRepairFollowup.batchRequest.count, 5);
assert.deepEqual(batchRepairFollowup.batchRequest.documentIds, ["chapter-1", "chapter-2", "chapter-3", "chapter-4", "chapter-5"]);
assert.match(batchRepairFollowup.expandedPrompt, /一次批量落盘事务/u);
assert.match(batchRepairFollowup.expandedPrompt, /每章都要保存修改前历史版本/u);
const batchRepairRoute = buildAdaptiveTaskRoute({
  text: batchRepairFollowup.expandedPrompt,
  sourceMessageId: "user-batch-repair",
  contextualWriteAction: "replace",
  workspaceOperation: false,
  landing: true,
  targetDocumentId: "note-1785861948844",
  targetRevision: "rev-note-1",
  targetDocumentIds: ["note-1785861948844", "chapter-2", "chapter-3", "chapter-4", "chapter-5"],
  expectedRevisions: {
    "note-1785861948844": "rev-note-1",
    "chapter-2": "rev-2",
    "chapter-3": "rev-3",
    "chapter-4": "rev-4",
    "chapter-5": "rev-5",
  },
  targetModuleId: "manuscript",
  workspaceKind: "notebook",
  continuesCreativeThread: true,
  batch: true,
}, { executionSurface: "agent" });
assert.equal(batchRepairRoute.shensiLed, true);
assert.equal(batchRepairRoute.action, "modify");
assert.equal(batchRepairRoute.commitOwner, "shensi_transaction");
assert.equal(batchRepairRoute.commitDisposition, "auto_commit");
assert.equal(batchRepairRoute.candidatePreviewRequired, false, "单一正式修复任务应直接进入受控事务，不应被旧候选预览门禁拦截");

const batchCandidate = codexAgentCandidatePreview({
  text: Array.from({ length: 5 }, (_, index) => `第${index + 1}章　修订标题${index + 1}\n\n${`这是第${index + 1}章修订后的完整正文内容，所有自检问题均在对应场景内完成修复。`.repeat(5)}`).join("\n\n"),
  instruction: batchRepairFollowup.expandedPrompt,
  route: batchRepairRoute,
  target: {
    documentId: "note-1785861948844",
    chapterNumber: 1,
    explicitChapter: true,
    batchRequest: {
      ...batchRepairFollowup.batchRequest,
      documentIds: ["note-1785861948844", "chapter-2", "chapter-3", "chapter-4", "chapter-5"],
    },
  },
});
assert.ok(batchCandidate);
assert.equal(batchCandidate.target.kind, "chapter-batch");
assert.equal(batchCandidate.target.incompleteBatch, false);
assert.deepEqual(batchCandidate.candidateDocuments.map((document) => document.target.documentId), [
  "note-1785861948844",
  "chapter-2",
  "chapter-3",
  "chapter-4",
  "chapter-5",
]);

console.log("Shensi v2.18.8 smart notebook routing and commit firewall tests passed");
