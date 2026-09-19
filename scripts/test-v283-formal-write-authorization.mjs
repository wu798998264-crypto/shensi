import assert from "node:assert/strict";

import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import {
  bindFormalWriteCandidate,
  validateFormalWriteAuthorization,
} from "../src/formal-write-authorization.js";
import { compileTaskContract } from "../src/task-contract.js";

const target = {
  documentId: "chapter-6",
  revision: "revision-6",
  chapterNumber: 6,
  explicitChapter: true,
};

const routeFor = (text, executionSurface = "chat", extra = {}) => buildAdaptiveTaskRoute({
  text,
  sourceMessageId: extra.sourceMessageId || `user-${executionSurface}`,
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  ...extra,
}, { executionSurface });

for (const text of [
  "只分析一下这章应该怎么修改",
  "告诉我应该如何修改这一章，不要改正文",
  "给修改建议、不要动原文",
  "讨论如何续写",
  "这章哪里需要调整",
]) {
  const chatRoute = routeFor(text, "chat", { sourceMessageId: "user-shared" });
  const agentRoute = routeFor(text, "agent", { sourceMessageId: "user-shared" });
  assert.equal(chatRoute.taskPolicy.action, "analyze", text);
  assert.equal(chatRoute.taskPolicy.commitDisposition, "no_artifact", text);
  assert.equal(chatRoute.writeAuthorization.state, "none", text);
  assert.equal(agentRoute.writeAuthorization.state, "none", text);
  assert.deepEqual(agentRoute.writeAuthorization, chatRoute.writeAuthorization, `Chat 与 Agent 必须采用同一授权结论：${text}`);
}

const appendRoute = routeFor("续写当前章节", "chat", { sourceMessageId: "user-append" });
assert.equal(appendRoute.writeAuthorization.state, "commit");
assert.equal(appendRoute.writeAuthorization.action, "append");
assert.equal(appendRoute.writeAuthorization.allowBodyMutation, true);
assert.equal(appendRoute.writeAuthorization.allowTitleMutation, false);

const existingBlankPublicAccountRoute = routeFor("生成一篇公众号文章", "chat", {
  sourceMessageId: "user-public-account-existing",
  targetDocumentId: "public-account-article",
  targetDocumentIds: ["public-account-article"],
  targetTitle: "公众号文章",
  targetExists: true,
  expectedRevisions: { "public-account-article": "revision-empty" },
});
assert.equal(existingBlankPublicAccountRoute.writeAuthorization.state, "commit");
assert.equal(existingBlankPublicAccountRoute.writeAuthorization.action, "generate", "已有空白正式文档应写入原目标，不得再次创建同名文档");

const missingPublicAccountRoute = routeFor("生成一篇公众号文章", "chat", {
  sourceMessageId: "user-public-account-missing",
  targetDocumentId: "public-account-new",
  targetDocumentIds: ["public-account-new"],
  targetExists: false,
  expectedRevisions: { "public-account-new": "" },
});
assert.equal(missingPublicAccountRoute.writeAuthorization.state, "commit");
assert.equal(missingPublicAccountRoute.writeAuthorization.action, "create", "目标不存在时仍应创建正式文档");

const explicitNewPublicAccountRoute = routeFor("新建一个公众号文章文档", "chat", {
  sourceMessageId: "user-public-account-explicit-new",
  targetDocumentId: "public-account-new",
  targetDocumentIds: ["public-account-new"],
  targetExists: true,
  expectedRevisions: { "public-account-new": "revision-placeholder" },
});
assert.equal(explicitNewPublicAccountRoute.writeAuthorization.state, "commit");
assert.equal(explicitNewPublicAccountRoute.writeAuthorization.action, "create", "明确要求新建文档时仍应执行创建事务");

const questionTitleFormalLandingRoute = buildAdaptiveTaskRoute({
  text: "请创作一篇约800字的公众号科普短文《为什么清晨的光让人更清醒》。不要先询问方向，直接完成正式内容并新建同名文档落盘；如果已有同名文档，创建数字后缀副本。",
  sourceMessageId: "user-question-title-formal-landing",
  targetDocumentId: "",
  targetDocumentIds: [],
  targetExists: false,
  expectedRevisions: {},
}, { executionSurface: "agent" });
assert.equal(questionTitleFormalLandingRoute.writeAuthorization.state, "commit",
  "标题中的‘为什么’不得与后文‘落盘’跨句拼成写入能力询问");
assert.equal(questionTitleFormalLandingRoute.writeAuthorization.action, "create");
assert.equal(questionTitleFormalLandingRoute.intentEnvelope.writeMode, "formal_auto");
assert.equal(questionTitleFormalLandingRoute.intentEnvelope.deliverables.length, 1,
  "明确新建并落盘的未解析目标必须保留待创建交付物");

const genuineWriteCapabilityQuestionRoute = buildAdaptiveTaskRoute({
  text: "为什么这篇文章无法落盘？",
  sourceMessageId: "user-genuine-write-capability-question",
  targetDocumentId: "",
  targetDocumentIds: [],
  targetExists: false,
  expectedRevisions: {},
}, { executionSurface: "agent" });
assert.equal(genuineWriteCapabilityQuestionRoute.writeAuthorization.state, "none",
  "真正的落盘能力询问仍不得授权正式写入");

const uncertainLandingRoute = routeFor("继续完善这个故事", "chat", {
  sourceMessageId: "user-uncertain-landing",
  continuesCreativeThread: true,
});
assert.equal(uncertainLandingRoute.writeAuthorization.state, "candidate_only");
assert.equal(uncertainLandingRoute.writeAuthorization.reason, "landing_intent_uncertain");
assert.equal(uncertainLandingRoute.landingConfirmationRequired, true, "不确定是否落盘时必须生成候选并询问用户");

const analysisOnlyRoute = routeFor("只分析一下公众号文章的问题", "chat", {
  sourceMessageId: "user-public-account-analysis",
});
assert.equal(analysisOnlyRoute.writeAuthorization.state, "none", "明确分析说明仍不得写入正式文档");

const singlePassContract = compileTaskContract({
  taskType: "modification",
  operation: "batch",
  objective: "分析前三章的问题，然后直接修改并保存",
  deliverables: [1, 2, 3].map((number) => ({
    id: `chapter-${number}-revision`,
    kind: "prose",
    targetDocumentId: `chapter-${number}`,
  })),
  requiredContextDocumentIds: ["chapter-1", "chapter-2", "chapter-3"],
  skillIds: ["novel-review"],
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "agent",
});
const singlePassRoute = routeFor("分析前三章的问题，然后直接修改并保存", "agent", {
  sourceMessageId: "user-single-pass",
  taskContract: singlePassContract,
  targetDocumentIds: ["chapter-1", "chapter-2", "chapter-3"],
  expectedRevisions: { "chapter-1": "r1", "chapter-2": "r2", "chapter-3": "r3" },
});
assert.equal(singlePassRoute.writeAuthorization.state, "commit");
assert.equal(singlePassRoute.taskPolicy.action, "modify");
assert.equal(singlePassRoute.taskPolicy.commitDisposition, "auto_commit");
assert.equal(singlePassRoute.landingConfirmationRequired, false);
assert.equal(singlePassRoute.candidatePreviewRequired, false);
assert.equal(singlePassRoute.intentEnvelope.targetResolution, "exact", "合同中的批量明确目标不是歧义目标");
assert.deepEqual(singlePassRoute.intentEnvelope.skillIds, ["novel-review"]);
assert.equal(singlePassRoute.confidence, 1);

const semanticOverrideRoute = routeFor("继续完善这个故事", "chat", {
  sourceMessageId: "user-semantic-override",
  taskContract: compileTaskContract({
    taskType: "modification",
    operation: "replace",
    deliverables: [{ kind: "prose", targetDocumentId: "chapter-6" }],
    persistence: "commit",
    targetResolution: "exact",
    semanticSource: "model",
  }),
});
assert.equal(semanticOverrideRoute.writeAuthorization.state, "commit", "模型已明确落盘时不得再由关键词触发二次确认");
assert.equal(semanticOverrideRoute.landingConfirmationRequired, false);

const patchRoute = routeFor("直接改写选区", "chat", {
  sourceMessageId: "user-patch",
  inlineEdit: true,
  hasSelection: true,
});
assert.equal(patchRoute.writeAuthorization.state, "commit");
assert.equal(patchRoute.writeAuthorization.action, "patch");
assert.equal(patchRoute.writeAuthorization.allowBodyMutation, true);

const bodyOnlyRoute = routeFor("直接改写选区，不要改标题", "chat", {
  sourceMessageId: "user-body-only",
  inlineEdit: true,
  hasSelection: true,
});

const formalBodyIsolationRoute = routeFor([
  "现在直接创作第1章正式正文并落盘。",
  "只把最终正式正文写入文档，不把说明、检查过程、自检报告写进正文。",
].join("\n"), "chat", {
  sourceMessageId: "user-formal-body-isolation",
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  targetRevision: "revision-1",
  expectedRevisions: { "chapter-1": "revision-1" },
});
assert.equal(formalBodyIsolationRoute.writeAuthorization.state, "commit", "排除检查过程不能把正式写作误判成只读检查");
assert.equal(formalBodyIsolationRoute.writeAuthorization.allowBodyMutation, true);
const protectedOtherChaptersRoute = routeFor([
  "现在直接创作第1章正式正文并落盘。",
  "只处理本章，不覆盖其他章节，不生成多个候选稿。",
  "只把最终正式正文写入文档，不把说明、检查过程、自检报告写进正文。",
].join("\n"), "chat", {
  sourceMessageId: "user-protect-other-chapters",
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  targetRevision: "revision-1",
  expectedRevisions: { "chapter-1": "revision-1" },
});
assert.equal(protectedOtherChaptersRoute.writeAuthorization.state, "commit",
  "保护其他章节和排除过程文本不得否定当前章节的明确落盘要求");
assert.equal(bodyOnlyRoute.writeAuthorization.state, "commit");
assert.equal(bodyOnlyRoute.writeAuthorization.allowBodyMutation, true);
assert.equal(bodyOnlyRoute.writeAuthorization.allowTitleMutation, false);

const bodyCommitWithTitleProtectionRoute = routeFor(
  "将当前正文完整替换为新的正式内容并直接落盘，不要修改标题。",
  "chat",
  { sourceMessageId: "user-body-commit-title-protected" },
);
assert.equal(bodyCommitWithTitleProtectionRoute.writeAuthorization.state, "commit",
  "标题保护只限制标题字段，不得把正文正式落盘降级为候选");
assert.equal(bodyCommitWithTitleProtectionRoute.writeAuthorization.action, "replace");
assert.equal(bodyCommitWithTitleProtectionRoute.writeAuthorization.allowBodyMutation, true);
assert.equal(bodyCommitWithTitleProtectionRoute.writeAuthorization.allowTitleMutation, false);

const titleOnlyRoute = routeFor("请把当前标题改名为北灵院，不要修改正文", "chat", {
  sourceMessageId: "user-title-only",
});
assert.equal(titleOnlyRoute.writeAuthorization.state, "commit");
assert.equal(titleOnlyRoute.writeAuthorization.action, "rename");
assert.equal(titleOnlyRoute.writeAuthorization.allowBodyMutation, false);
assert.equal(titleOnlyRoute.writeAuthorization.allowTitleMutation, true);

const candidateRoute = routeFor("先写一版看看", "chat", { sourceMessageId: "user-draft" });
assert.equal(candidateRoute.writeAuthorization.state, "candidate_only");
assert.equal(candidateRoute.taskPolicy.commitDisposition, "candidate_only");

const noLandingRoute = routeFor("生成新版但不落盘", "agent", { sourceMessageId: "user-no-landing" });
assert.equal(noLandingRoute.writeAuthorization.state, "candidate_only");
assert.equal(noLandingRoute.taskPolicy.commitDisposition, "candidate_only");

const multipleRoute = routeFor("给三版候选，不要落盘", "agent", { sourceMessageId: "user-options" });
assert.equal(multipleRoute.writeAuthorization.state, "candidate_only");
assert.equal(multipleRoute.writeAuthorization.allowBodyMutation, false);
assert.equal(multipleRoute.writeAuthorization.allowTitleMutation, false);

const candidate = "第6章 北灵院\n\n夜色压在山门上，牧尘沿石阶继续向前。";
const boundCandidate = await bindFormalWriteCandidate(candidateRoute.writeAuthorization, {
  candidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
});
assert.ok(boundCandidate.candidateHash);
assert.equal(validateFormalWriteAuthorization(boundCandidate, {
  requiredState: "candidate_only",
  sourceMessageId: "user-draft",
  instruction: "先写一版看看",
  candidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}).valid, true);
assert.equal(validateFormalWriteAuthorization(boundCandidate, {
  requiredState: "candidate_only",
  sourceMessageId: "other-message",
  instruction: "先写一版看看",
  candidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}).valid, false, "候选授权不能跨消息复用");
assert.equal(validateFormalWriteAuthorization(boundCandidate, {
  requiredState: "candidate_only",
  sourceMessageId: "user-draft",
  instruction: "先写一版看看",
  candidate: `${candidate}\n篡改`,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}).valid, false, "候选授权必须绑定候选哈希");

const adoptedRoute = routeFor("按这个落盘", "chat", {
  sourceMessageId: "user-adopt",
  candidate,
  candidateAuthorization: boundCandidate,
});
assert.equal(adoptedRoute.writeAuthorization.state, "commit");
assert.equal(adoptedRoute.writeAuthorization.sourceMessageId, "user-adopt");
assert.equal(validateFormalWriteAuthorization(adoptedRoute.writeAuthorization, {
  requiredState: "commit",
  sourceMessageId: "user-adopt",
  instruction: "按这个落盘",
  candidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  requireBodyMutation: true,
}).valid, true);

const mismatchedAdoption = routeFor("按这个落盘", "chat", {
  sourceMessageId: "user-adopt-wrong",
  candidate: `${candidate}\n不同候选`,
  candidateAuthorization: boundCandidate,
});
assert.equal(mismatchedAdoption.writeAuthorization.state, "none", "不能采用与来源证明不一致的候选");

console.log("Shensi v2.83 formal write authorization tests passed");
