import assert from "node:assert/strict";
import { agentDecision } from "./fixtures/agent-decision.mjs";
import {
  classifyDocumentWriteIntent,
  extractFormalArtifacts,
  extractFormalArtifactsWithRetry,
  formalArtifactLandingPolicy,
  semanticSectionPatch,
} from "../src/formal-artifact-extractor.js";
import { chapterInsertionIndex } from "../src/chapter-document.js";
import { resolveGenerationAttemptReviewGate } from "../src/server/generation-attempt-store.mjs";
import { determineFinalCandidateVerdict } from "../src/server/shensi-orchestrator.mjs";
import { codexAgentCandidatePreview } from "../src/codex-agent-candidate-preview.js";
import { splitCandidateChapters } from "../src/candidate-chapters.js";
import { genericLandingDocumentTitle, leadingFormalDocumentTitle, leadingSequencedDocumentTitle } from "../src/document-landing-title.js";
import { freeDocumentTitle } from "../src/document-title-policy.js";
import { verifiedLandingDocumentLinksForManifest } from "../src/landing-document-links.js";
import { requestedArtifactTargets } from "../src/artifact-target.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { bindFormalWriteCandidate } from "../src/formal-write-authorization.js";

const pollutedInstruction = "重写第二章并覆盖原文";
const pollutedResponse = "下面是修改后的版本：\n\n第二章 北灵台\n\n月光落在窗前。\n\n修改说明：\n已增强节奏并完成自检。";
const polluted = extractFormalArtifacts({
  instruction: pollutedInstruction,
  response: pollutedResponse,
});
assert.equal(polluted.artifacts.length, 1);
assert.equal(polluted.artifacts[0].content, "第二章 北灵台\n\n月光落在窗前。");
assert.equal(polluted.landingPolicy.shouldLand, false, "没有授权合同时即使内容像正文也不能落盘");
const pollutedRoute = buildAdaptiveTaskRoute({
  agentDecision: agentDecision({ operation: "append" }),
  text: pollutedInstruction,
  sourceMessageId: "user-polluted",
  target: { documentId: "chapter-2", revision: "revision-2" },
  targetDocumentIds: ["chapter-2"],
  expectedRevisions: { "chapter-2": "revision-2" },
}, { executionSurface: "chat" });
const pollutedAuthorization = await bindFormalWriteCandidate(pollutedRoute.writeAuthorization, {
  candidate: pollutedResponse,
  targetDocumentIds: ["chapter-2"],
  expectedRevisions: { "chapter-2": "revision-2" },
});
assert.equal(extractFormalArtifacts({
  instruction: pollutedInstruction,
  response: pollutedResponse,
  writeAuthorization: pollutedAuthorization,
}).landingPolicy.shouldLand, true);
assert.equal(extractFormalArtifacts({ response: "```markdown\n正式正文\n```", instruction: "写正文" }).artifacts[0].content, "正式正文");
const retried = await extractFormalArtifactsWithRetry({
  response: "修改说明：",
  instruction: "写正文",
  retryExtractor: async () => "正式正文（从原响应重新提取）",
});
assert.equal(retried.extractionAttempts, 2);
assert.equal(retried.artifacts[0].content, "正式正文（从原响应重新提取）");

const foundationInstruction = "现在把确认内容写入当前作品的资料、设定和全书大纲，并记录必要伏笔与信息台阶；不写正文。";
const foundationTargets = requestedArtifactTargets(foundationInstruction).map((target) => target.documentId);
assert.deepEqual(
  ["canon-world", "outline-series", "memory-foreshadowing", "memory-release", "library-reference"].filter((id) => foundationTargets.includes(id)),
  ["canon-world", "outline-series", "memory-foreshadowing", "memory-release", "library-reference"],
);
const sectionedFoundation = extractFormalArtifacts({
  instruction: foundationInstruction,
  response: `《雾都铜心》作品资料

架空晚清长安被煤雾封锁，修钟匠叶昭追查父亲失踪与气税真相。

《雾都铜心》正史设定

长安被煤雾封锁，九座巨炉以人的寿数维持全城供气。

《雾都铜心》全书大纲

第一幕追查铜心，第二幕揭露皇历造假，第三幕由百姓决定炉权。

《雾都铜心》伏笔总表

城楼钟每到子时倒走七格，第十八章回收阿满的假背叛。

《雾都铜心》信息释放表

先公开气税，再揭示寿数燃料，最后公开主炉真相。`,
});
assert.equal(sectionedFoundation.structuredResponse, true);
assert.deepEqual(sectionedFoundation.artifacts.map((artifact) => artifact.targetDocumentId), [
  "library-reference",
  "canon-world",
  "outline-series",
  "memory-foreshadowing",
  "memory-release",
]);
assert.ok(sectionedFoundation.artifacts.every((artifact) => artifact.content.length > 20));

const refusalInsteadOfContinuation = [
  "我会延续当前玄幻学院线：完成北灵台决战的收束，并让玉简与‘北苍’线索正式进入主线。先按创作构思流程校准承接点，再交付可自动落盘的第三章全文。抱歉，我不能续写《大主宰》角色与情节的后续正文。",
  "我可以立刻改写为原创第三章：保留学院擂台决战、少年突破、神秘玉简指向远方的高层设定，但使用全新人物、世界观与剧情。",
].join("\n");
const rejectedContinuation = extractFormalArtifacts({
  response: refusalInsteadOfContinuation,
  instruction: "续写第三章",
  target: { documentId: "chapter-3", chapterNumber: 3 },
});
assert.equal(rejectedContinuation.artifacts.length, 0, "说明、承诺和拒绝文本不得伪装成正式正文");
assert.equal(rejectedContinuation.landingPolicy.shouldLand, false);
assert.equal(codexAgentCandidatePreview({
  text: refusalInsteadOfContinuation,
  instruction: "续写第三章",
  route: { candidatePreviewRequired: true },
  target: { documentId: "chapter-3", chapterNumber: 3, explicitChapter: true },
}), null, "Agent 候选入口必须在建档前拒绝非正式内容");

const untitledContinuation = splitCandidateChapters(
  "雨停以后，牧尘从断裂的石阶上站起。\n\n北灵台上残留的灵光正向玉简汇聚，新的敌人已经穿过山门。",
  { documentId: "chapter-3", chapterNumber: 3, chapterTitle: "未命名", explicitChapter: true },
);
assert.equal(untitledContinuation.length, 1);
assert.equal(genericLandingDocumentTitle(untitledContinuation[0].target.chapterTitle), false);
assert.match(untitledContinuation[0].target.chapterTitle, /雨停以后/u);
assert.equal(genericLandingDocumentTitle("第8章　未命名"), true);

const titledContinuation = splitCandidateChapters(
  "第8章　渠底暗门\n\n风从北灵台尽头涌来，玉简在掌心裂开。",
  { documentId: "chapter-8", chapterNumber: 8, chapterTitle: "未命名", explicitChapter: true },
);
assert.equal(titledContinuation[0].target.chapterTitle, "渠底暗门");
assert.equal(titledContinuation[0].content, "风从北灵台尽头涌来，玉简在掌心裂开。");
assert.equal(leadingFormalDocumentTitle("第8章　渠底暗门\n\n正文"), "第8章　渠底暗门");
assert.equal(leadingSequencedDocumentTitle("第8章　渠底暗门\n\n正文"), "渠底暗门");

const headingOnlyContinuation = splitCandidateChapters("第三章\n\n风从北灵台尽头涌来，玉简在掌心裂开。", null);
assert.equal(genericLandingDocumentTitle(headingOnlyContinuation[0].target.chapterTitle), false);
assert.match(headingOnlyContinuation[0].target.chapterTitle, /风从北灵台尽头涌来/u);

const singleLowercaseObject = extractFormalArtifacts({
  instruction: "写入文档并覆盖原正文",
  response: `我会直接写入。\n\n\`\`\`json
{
  "targetdocumentid": "note-1786442256356",
  "operation": "replacedocumentbody",
  "contentformat": "shensishortdramascript",
  "title": "第十六个女孩不需要变漂亮",
  "content": "第1集\\n\\n1-1 日 内 实验室\\n人物：林夏\\n林夏推门而入。"
}
\`\`\``,
});
assert.equal(singleLowercaseObject.artifacts.length, 1);
assert.equal(singleLowercaseObject.artifacts[0].targetDocumentId, "note-1786442256356");
assert.equal(singleLowercaseObject.artifacts[0].operation, "replace");
assert.equal(singleLowercaseObject.artifacts[0].contentType, "shensishortdramascript");
assert.equal(singleLowercaseObject.artifacts[0].title, "第十六个女孩不需要变漂亮");
assert.equal(singleLowercaseObject.artifacts[0].content, "第1集\n\n1-1 日 内 实验室\n人物：林夏\n林夏推门而入。");
assert.doesNotMatch(singleLowercaseObject.artifacts[0].content, /targetdocumentid|replacedocumentbody/u);

const yamlLikeAgentDelivery = extractFormalArtifacts({
  instruction: "续写第三章",
  response: `我会先校准承接点，再交付可自动落盘的第三章全文。

targetdocumentid: chapter-3
targetrevision: hostmustreadcurrent
operation: replace_content
title: 第三章 | 北灵台之战
content: |
# 第三章 | 北灵台之战

**柳阳盯着牧尘，冷意终于褪去。**

\`\`\`
风从北灵台尽头涌来，石阶缝隙里的残光沿着玉简一寸寸亮起，新的脚步声穿过山门。
\`\`\``,
});
assert.equal(yamlLikeAgentDelivery.structuredResponse, true);
assert.equal(yamlLikeAgentDelivery.artifacts.length, 1);
assert.equal(yamlLikeAgentDelivery.artifacts[0].targetDocumentId, "chapter-3");
assert.equal(yamlLikeAgentDelivery.artifacts[0].operation, "replace");
assert.equal(yamlLikeAgentDelivery.artifacts[0].title, "第三章 | 北灵台之战");
assert.equal(yamlLikeAgentDelivery.artifacts[0].content, "柳阳盯着牧尘，冷意终于褪去。\n\n风从北灵台尽头涌来，石阶缝隙里的残光沿着玉简一寸寸亮起，新的脚步声穿过山门。");
assert.doesNotMatch(yamlLikeAgentDelivery.artifacts[0].content, /targetdocumentid|targetrevision|replace_content|我会先|```|\*\*/u);
assert.equal(freeDocumentTitle({ documentId: "chapter-3", title: yamlLikeAgentDelivery.artifacts[0].title }), "北灵台之战");

const pipeHeadingChapter = splitCandidateChapters("第三章 | 北灵台之战\n\n风从北灵台尽头涌来。", null);
assert.equal(pipeHeadingChapter[0].target.documentId, "chapter-3");
assert.equal(pipeHeadingChapter[0].target.chapterTitle, "北灵台之战");

const chapterLandingLinks = verifiedLandingDocumentLinksForManifest({
  manifest: {
    schemaVersion: 2,
    workspaceKind: "project",
    workspacePath: "E:/ShensiUserData/作品/北灵台",
    segments: [{
      documentId: "chapter-3",
      title: "北灵台之战",
      receiptVerified: true,
      navigationTarget: { documentId: "chapter-3", workspaceKind: "project", workspacePath: "E:/ShensiUserData/作品/北灵台" },
    }],
    batchLandingReceipt: {
      verified: true,
      failed: 0,
      results: [{
        targetDocumentId: "chapter-3",
        title: "北灵台之战",
        verified: true,
        writtenHash: "verified-content",
        verifiedHash: "verified-content",
        workspaceKind: "project",
        workspacePath: "E:/ShensiUserData/作品/北灵台",
      }],
    },
  },
  documents: { "chapter-3": { title: "北灵台之战", titleLanguage: "zh-CN" } },
});
assert.equal(chapterLandingLinks[0].title, "第3章　北灵台之战");

assert.equal(formalArtifactLandingPolicy({ instruction: "只在对话中给我三个候选版本", candidateCount: 3 }).shouldLand, false);
assert.equal(formalArtifactLandingPolicy({ instruction: "为什么这一段节奏慢？" }).shouldLand, false);
assert.equal(formalArtifactLandingPolicy({ instruction: "本次续写实际读取了哪些内容？" }).shouldLand, false);
assert.equal(formalArtifactLandingPolicy({ instruction: "通用问答会不会自动覆盖当前文档？" }).shouldLand, false);
assert.equal(classifyDocumentWriteIntent({ instruction: "把林夏改成林秋", targetExists: true }).operation, "patch");
assert.equal(classifyDocumentWriteIntent({ instruction: "全文重写并覆盖", targetExists: true }).operation, "replace");
assert.equal(classifyDocumentWriteIntent({ instruction: "续写下一段", targetExists: true }).operation, "append");
assert.equal(classifyDocumentWriteIntent({ instruction: "新建文档《人物设定》", targetExists: false }).operation, "create");
assert.equal(classifyDocumentWriteIntent({ instruction: "批量生成", artifactCount: 3 }).operation, "batch");
assert.equal(chapterInsertionIndex([["outline-index", "目录"], ["chapter-1", "第一章"], ["chapter-3", "第三章"]], 2), 2);
assert.equal(chapterInsertionIndex([["outline-index", "目录"], ["chapter-1", "第一章"], ["chapter-3", "第三章"]], 7), 3);

const current = "第一场 室内\n旧内容甲。\n\n第二场 天台\n旧内容乙。\n\n第三场 街道\n旧内容丙。";
const scenePatch = semanticSectionPatch({ currentContent: current, candidate: "第二场 天台\n新内容乙。", instruction: "只修改第二场" });
assert.ok(scenePatch);
assert.match(scenePatch.content, /第一场 室内\n旧内容甲/u);
assert.match(scenePatch.content, /第二场 天台\n新内容乙/u);
assert.match(scenePatch.content, /第三场 街道\n旧内容丙/u);
assert.doesNotMatch(scenePatch.content, /旧内容乙/u);

const advisoryReview = resolveGenerationAttemptReviewGate({
  selfCheckRequested: true,
  hasPersistedCandidate: true,
  reviewMatchesCandidate: false,
  reviewAllowsLanding: false,
  requestedLandingEligible: true,
  requestedValidationStatus: "passed",
  requestedLandingStatus: "committed",
});
assert.equal(advisoryReview.landingEligible, true);
assert.equal(advisoryReview.validationStatus, "warning");
assert.equal(advisoryReview.landingStatus, "committed");

const warningVerdict = determineFinalCandidateVerdict({
  candidate: "正式正文",
  prompt: "自检修改后直接落盘",
  evaluation: { pass: false, issues: ["节奏仍可优化"], findings: [], repairInstruction: "" },
  memoryCheck: { hardConflict: true, hardConflicts: ["设定存在疑问"], softRisks: [] },
  formatCheck: { pass: false, issues: [{ message: "格式建议" }] },
  artifactCheck: { pass: true, issues: [], violations: [] },
  languageGuardEnabled: false,
});
assert.equal(warningVerdict.outcome, "soft_warning");
assert.equal(warningVerdict.landingStatus, "ready");

console.log("v2.4.0 formal artifact landing tests passed");
