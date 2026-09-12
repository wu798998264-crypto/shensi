import assert from "node:assert/strict";
import { reportContract } from "./fixtures/agent-decision.mjs";

import { requestedArtifactTarget, requestedArtifactTargets } from "../src/artifact-target.js";
import { compileAgentTaskPolicy } from "../src/agent-task-policy.js";
import { automaticLandingDecision, explicitNewDocumentIntent } from "../src/automatic-landing-policy.js";
import { requestedChapterTarget } from "../src/chapter-target.js";
import { compileCreativeMutationPlan, creativeMutationOutputContract } from "../src/creative-mutation-plan.js";
import { normalizeChapterNumbering } from "../src/data.js";
import { buildAdaptiveTaskRoute, creativeDeliverableType, hasExplicitCreativeProductionIntent, hasExplicitFormalAssetWriteIntent } from "../src/request-routing.js";
import { reviewDeliveryPolicy, reviewIncludesContentMutation } from "../src/review-delivery-policy.js";

const inventory = [
  { id: "canon-world", title: "世界观与基础规则", moduleId: "canon", characters: 1200 },
  { id: "outline-series", title: "全集大纲", moduleId: "outline", characters: 900 },
  { id: "outline-chapter-4", title: "第4章章纲", moduleId: "outline", characters: 300 },
  { id: "chapter-1", title: "第一章", moduleId: "manuscript", characters: 2800 },
  { id: "chapter-2", title: "第二章", moduleId: "manuscript", characters: 2600 },
  { id: "chapter-3", title: "第三章", moduleId: "manuscript", characters: 2400 },
];

assert.equal(requestedArtifactTarget("更新第三章细纲")?.documentId, "outline-chapter-3");
assert.equal(requestedArtifactTarget("补充第三章详细大纲")?.documentId, "outline-chapter-3");
assert.equal(requestedChapterTarget("更新第三章细纲"), null, "细纲不能被正文章号路由抢走");
assert.equal(creativeDeliverableType({ text: "更新第三章细纲" }), "novel");

const dualTargetPrompt = "将新增设定补充到全文大纲和设定中";
assert.equal(hasExplicitFormalAssetWriteIntent({ text: dualTargetPrompt }), true);
assert.deepEqual(
  requestedArtifactTargets(dualTargetPrompt).map((target) => target.documentId).sort(),
  ["canon-world", "outline-series"],
);
assert.equal(explicitNewDocumentIntent(dualTargetPrompt).create, false, "新增设定是内容变更，不是新建文档");
assert.equal(explicitNewDocumentIntent("新增一份文档《补充资料》").create, true);

const prosePrompt = "根据当前设定写一段后续正文";
const prosePlan = compileCreativeMutationPlan({
  instruction: prosePrompt,
  boundDocument: { documentId: "canon-world", title: "世界观与基础规则", moduleId: "canon" },
  inventory,
  productionIntent: hasExplicitCreativeProductionIntent({ text: prosePrompt, targetDocumentId: "canon-world" }),
});
assert.deepEqual(prosePlan.contextSources.map((item) => item.documentId), ["canon-world"]);
assert.deepEqual(prosePlan.primaryTargets.map((item) => item.documentId), ["chapter-4"]);
assert.equal(prosePlan.boundDocumentIsTarget, false, "绑定设定只能提供上下文，不得成为泛指正文的写入目标");

const outlineBasedProsePlan = compileCreativeMutationPlan({
  instruction: "根据全集大纲继续写后续正文",
  boundDocument: { documentId: "outline-series", title: "全集大纲", moduleId: "outline" },
  inventory,
  productionIntent: true,
});
assert.deepEqual(outlineBasedProsePlan.contextSources.map((item) => item.documentId), ["outline-series"]);
assert.deepEqual(outlineBasedProsePlan.primaryTargets.map((item) => item.documentId), ["chapter-4"],
  "引用大纲作为读取上下文，不等于授权覆盖大纲");

const explicitBoundPlan = compileCreativeMutationPlan({
  instruction: "修改当前文档中的力量规则",
  boundDocument: { documentId: "canon-world", title: "世界观与基础规则", moduleId: "canon" },
  inventory,
  productionIntent: true,
  formalWriteIntent: true,
  explicitlyRequestsBoundDocument: true,
});
assert.deepEqual(explicitBoundPlan.primaryTargets.map((item) => item.documentId), ["canon-world"]);

const batchPlan = compileCreativeMutationPlan({
  instruction: dualTargetPrompt,
  boundDocument: { documentId: "chapter-3", title: "第三章", moduleId: "manuscript" },
  inventory,
  formalWriteIntent: true,
  productionIntent: true,
});
assert.deepEqual(batchPlan.primaryTargets.map((item) => item.documentId).sort(), ["canon-world", "outline-series"]);
assert.equal(batchPlan.exactTargetSet, true);
assert.equal(batchPlan.boundDocumentIsTarget, false);
assert.match(creativeMutationOutputContract(batchPlan), /canon-world/u);
assert.match(creativeMutationOutputContract(batchPlan), /outline-series/u);

const inquiry = "这些 skill 分别做什么，会不会写入文档？";
const inquiryPlan = compileCreativeMutationPlan({
  instruction: inquiry,
  boundDocument: { documentId: "chapter-3", title: "第三章", moduleId: "manuscript" },
  inventory,
  formalWriteIntent: hasExplicitFormalAssetWriteIntent({ text: inquiry }),
  productionIntent: hasExplicitCreativeProductionIntent({ text: inquiry, targetDocumentId: "chapter-3" }),
});
assert.equal(inquiryPlan.status, "no_mutation_target");
assert.deepEqual(inquiryPlan.primaryTargets, []);

const selfCheckPlan = compileCreativeMutationPlan({
  instruction: "请自检第三章",
  boundDocument: { documentId: "chapter-2", title: "第二章", moduleId: "manuscript" },
  inventory,
  productionIntent: true,
  explicitTargets: [{ documentId: "report-novel", moduleId: "reports", title: "小说自检" }],
});
assert.deepEqual(selfCheckPlan.primaryTargets.map((item) => item.documentId), ["report-novel"], "自检章节是读取范围，正式写入目标必须是自检报告");

const reviewDelivery = reviewDeliveryPolicy({ text: "请自检第三章" });
const reviewPolicy = compileAgentTaskPolicy({
  text: "请自检第三章",
  route: { mode: "creative", reviewDelivery },
  target: reviewDelivery.target,
});
assert.equal(reviewPolicy.action, "generate");
assert.equal(reviewPolicy.commitDisposition, "no_artifact", "自检报告默认只保留在对话区，不能自动写入正式文档");
assert.equal(reviewDelivery.target, null, "未明确保存时，自检没有正式报告落点");
assert.equal(automaticLandingDecision({
  instruction: "请自检第三章",
  result: { candidate: "自检报告正文", engineExecution: { reviewDelivery } },
}).action, "none", "没有正式写入授权的自检报告不得自动落盘");

const batchReviewInstruction = "请自检第1章至第5章";
const batchReviewRoute = buildAdaptiveTaskRoute({
  taskContract: reportContract({ sourceMessageId: "user-batch-review-report" }),
  text: batchReviewInstruction,
  authorizationInstruction: batchReviewInstruction,
  sourceMessageId: "user-batch-review-report",
  targetDocumentId: "chapter-1",
  targetDocumentIds: Array.from({ length: 5 }, (_, index) => `chapter-${index + 1}`),
  expectedRevisions: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`chapter-${index + 1}`, `chapter-rev-${index + 1}`])),
  targetExists: true,
  targetModuleId: "manuscript",
}, { executionSurface: "chat" });
assert.equal(batchReviewRoute.writeAuthorization.state, "commit");
assert.equal(batchReviewRoute.commitDisposition, "auto_commit");
assert.equal(batchReviewRoute.reviewDelivery.target?.documentId, "report-novel");
assert.equal(batchReviewRoute.candidatePreviewRequired, false);
assert.deepEqual(batchReviewRoute.writeAuthorization.targetDocumentIds, ["report-novel"]);
assert.equal(automaticLandingDecision({
  instruction: batchReviewInstruction,
  route: batchReviewRoute,
  target: batchReviewRoute.reviewDelivery.target,
  result: { candidate: "第1章至第5章完整自检报告", engineExecution: { reviewDelivery: batchReviewRoute.reviewDelivery } },
}).action, "land", "多章节自检报告必须直接写入索引绑定的正式报告文档");

const authorizedReviewInstruction = "请自检第三章并将自检报告写入当前文档";
const authorizedReviewRoute = buildAdaptiveTaskRoute({
  taskContract: reportContract({ sourceMessageId: "user-review-report" }),
  text: authorizedReviewInstruction,
  authorizationInstruction: authorizedReviewInstruction,
  sourceMessageId: "user-review-report",
  targetDocumentId: "report-novel",
  targetRevision: "report-rev-1",
  targetDocumentIds: ["report-novel"],
  expectedRevisions: { "report-novel": "report-rev-1" },
  targetExists: true,
  targetModuleId: "reports",
}, { executionSurface: "chat" });
assert.equal(authorizedReviewRoute.writeAuthorization.state, "commit");
assert.equal(automaticLandingDecision({
  instruction: authorizedReviewInstruction,
  route: authorizedReviewRoute,
  target: { documentId: "report-novel" },
  result: { candidate: "自检报告正文", engineExecution: { reviewDelivery: authorizedReviewRoute.reviewDelivery } },
}).action, "land", "只有经过正式写入授权的自检报告才能落盘");

assert.equal(reviewIncludesContentMutation("请自检第1章至第5章并修改正文"), true);
const reviewAndRepairPlan = compileCreativeMutationPlan({
  instruction: "请自检第1章至第5章并修改正文",
  boundDocument: { documentId: "chapter-2", title: "第二章", moduleId: "manuscript" },
  inventory,
  productionIntent: true,
  explicitTargets: [
    ...Array.from({ length: 5 }, (_, index) => ({ documentId: `chapter-${index + 1}`, moduleId: "manuscript", title: `第${index + 1}章` })),
    { documentId: "report-novel", moduleId: "reports", title: "小说自检" },
  ],
});
assert.deepEqual(reviewAndRepairPlan.primaryTargets.map((item) => item.documentId), [
  "chapter-1", "chapter-2", "chapter-3", "chapter-4", "chapter-5", "report-novel",
]);

const legacyChapterNames = {
  structureLanguage: "zh-CN",
  documents: {
    "chapter-1": { title: "第一章 开端", html: "<h1>第一章 开端</h1><p>正文一</p>" },
    "chapter-2": { title: "第二章 追踪", html: "<h1>第二章 追踪</h1><p>正文二</p>" },
    "chapter-3": { title: "第三章 反转", html: "<h1>第三章 反转</h1><p>正文三</p>" },
  },
  moduleItems: { manuscript: [["chapter-1", "第一章 开端"], ["chapter-2", "第二章 追踪"], ["chapter-3", "第3章　反转"]] },
};
assert.equal(normalizeChapterNumbering(legacyChapterNames), true);
assert.deepEqual(legacyChapterNames.moduleItems.manuscript.map((item) => item[1]), ["第1章　开端", "第2章　追踪", "第3章　反转"]);

console.log("Shensi v2.19 core document routing tests passed");
