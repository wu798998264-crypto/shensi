import assert from "node:assert/strict";

import { authorizeFormalMutation } from "../src/formal-mutation-permission.js";
import { reviewDeliveryPolicy, reviewIncludesContentMutation } from "../src/review-delivery-policy.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";

const explicitCanonPlan = {
  primaryTargets: [{ documentId: "canon-characters", moduleId: "canon" }],
};
assert.equal(authorizeFormalMutation({
  instruction: "把最新正文中的人物设定更新到人物设定文档",
  plan: explicitCanonPlan,
  targets: explicitCanonPlan.primaryTargets,
}).ok, true);

assert.equal(authorizeFormalMutation({
  instruction: "正文里出现了新人物",
  targets: [{ documentId: "canon-characters", moduleId: "canon" }],
}).ok, false);

assert.equal(authorizeFormalMutation({
  instruction: "把刚才讨论的内容加入全集大纲第三阶段",
  plan: { primaryTargets: [{ documentId: "outline-series", moduleId: "outline" }] },
  targets: [{ documentId: "outline-series", moduleId: "outline" }],
}).ok, true);

const singleReview = reviewDeliveryPolicy({ text: "请自检第三章" });
assert.equal(singleReview.active, true);
assert.equal(singleReview.target, null);
assert.equal(singleReview.landingEligible, false);
assert.equal(singleReview.kind, "single_unit_diagnostic");
const localReview = reviewDeliveryPolicy({ text: "请检查这段文字的问题" });
assert.equal(localReview.active, true);
assert.equal(localReview.kind, "local_diagnostic");
assert.equal(localReview.target, null);
assert.equal(reviewDeliveryPolicy({ text: "做一次局部小检测" }).kind, "local_diagnostic");
assert.equal(reviewDeliveryPolicy({ text: "对当前内容做单章检测" }).kind, "single_unit_diagnostic");
const batchReview = reviewDeliveryPolicy({ text: "请自检第1章至第5章" });
assert.equal(batchReview.reportRequested, true);
assert.equal(batchReview.landingEligible, true);
assert.equal(batchReview.candidatePreviewRequired, false, "正式自检报告不能被误判为候选稿");
assert.equal(batchReview.target?.documentId, "report-novel");
assert.equal(reviewDeliveryPolicy({ text: "请自检整卷" }).target?.documentId, "report-novel");
assert.equal(reviewDeliveryPolicy({ text: "请检测整卷" }).target?.documentId, "report-novel");
assert.equal(reviewDeliveryPolicy({ text: "请完整自检整个作品" }).target?.documentId, "report-novel");
assert.equal(reviewDeliveryPolicy({ text: "请自检第1集至第3集剧本", contextDomain: "script" }).target?.documentId, "report-script");
const generatedChapterWithInternalReview = reviewDeliveryPolicy({
  text: "现在直接创作第1章正式正文。创作过程中执行小说自检，但只把最终正式正文写入文档，不把自检报告写进正文。自动新建章节文档并落盘。",
});
assert.equal(reviewIncludesContentMutation("现在直接创作第1章正式正文，并在创作过程中执行小说自检"), true);
assert.equal(generatedChapterWithInternalReview.active, true);
assert.equal(generatedChapterWithInternalReview.reportRequested, false, "正文生产内的写后自检不得把新章节误判成待读取的纯审稿任务");
assert.equal(generatedChapterWithInternalReview.target, null, "只交付最终正文时不得擅自增加自检报告文档");
const generatedChapterAndReport = reviewDeliveryPolicy({
  text: "创作第1章正式正文，同时生成一份小说自检报告并保存到报告文档。",
});
assert.equal(generatedChapterAndReport.reportRequested, true, "用户明确要求独立报告时仍必须保留报告交付物");
assert.equal(generatedChapterAndReport.target?.documentId, "report-novel");
assert.equal(reviewDeliveryPolicy({
  text: "请生成小说改编剧本的完整自检报告",
  contextDomain: "script-adaptation",
}).target?.documentId, "report-adaptation");
const chatOnlyReview = reviewDeliveryPolicy({ text: "只使用当前模型自身能力自检当前绑定文档，只在对话中回答一条结论，不修改、不落盘。" });
assert.equal(chatOnlyReview.active, true);
assert.equal(chatOnlyReview.reportRequested, false);
assert.equal(chatOnlyReview.landingEligible, false, "明确不落盘的自检只能回复对话，不能规划报告写入");
assert.equal(chatOnlyReview.target, null);
const batchChatOnlyReview = reviewDeliveryPolicy({ text: "请自检第1章至第5章，只在对话回答，不落盘" });
assert.equal(batchChatOnlyReview.reportRequested, false);
assert.equal(batchChatOnlyReview.landingEligible, false);
assert.equal(batchChatOnlyReview.target, null);
assert.equal(reviewDeliveryPolicy({ text: "小说自检有哪些功能？" }).active, false);
const adaptationReview = reviewDeliveryPolicy({
  text: "请自检小说改编剧本并将报告保存到改编报告",
  contextDomain: "script-adaptation",
});
assert.equal(adaptationReview.reportRequested, true);
assert.equal(adaptationReview.target?.documentId, "report-adaptation");
const adaptationRoute = buildAdaptiveTaskRoute({
  text: "请自检改编剧本并将报告保存到改编报告",
  contextDomain: "script-adaptation",
  targetDocumentId: "report-adaptation",
  targetDocumentIds: ["report-adaptation"],
  targetExists: true,
  sourceMessageId: "adaptation-review-1",
});
assert.equal(adaptationRoute.reviewDelivery.target?.documentId, "report-adaptation");
assert.equal(adaptationRoute.writeAuthorization.state, "commit");
assert.equal(authorizeFormalMutation({
  instruction: "请自检第三章",
  targets: [{ documentId: "report-novel", moduleId: "reports" }],
}).ok, false);
assert.equal(authorizeFormalMutation({
  instruction: "请自检第三章并将自检报告保存到小说自检",
  targets: [{ documentId: "report-novel", moduleId: "reports" }],
}).ok, true);
assert.equal(authorizeFormalMutation({
  instruction: "请自检第三章并将自检报告保存到小说自检",
  targets: [{ documentId: "chapter-3", moduleId: "manuscript" }],
}).ok, false, "自检报告不得误写入正文目标");
assert.equal(authorizeFormalMutation({
  instruction: "请自检改编剧本并将报告保存到改编报告",
  targets: [{ documentId: "report-adaptation", moduleId: "reports" }],
}).ok, true, "改编自检报告必须进入索引绑定的改编报告");

assert.equal(authorizeFormalMutation({
  instruction: "写第四章正文",
  plan: { primaryTargets: [{ documentId: "chapter-4", moduleId: "manuscript" }] },
  targets: [{ documentId: "chapter-4", moduleId: "manuscript" }],
}).ok, true);

assert.equal(authorizeFormalMutation({
  instruction: "请自检第1章至第5章并修改正文",
  targets: Array.from({ length: 5 }, (_, index) => ({ documentId: `chapter-${index + 1}`, moduleId: "manuscript" })),
}).ok, false, "多章节自检的正式报告目标不能从事务中丢失");

assert.equal(authorizeFormalMutation({
  instruction: "请自检第1章至第5章并修改正文",
  targets: [
    ...Array.from({ length: 5 }, (_, index) => ({ documentId: `chapter-${index + 1}`, moduleId: "manuscript" })),
    { documentId: "report-novel", moduleId: "reports" },
  ],
}).ok, true, "多章节自检报告自动进入索引绑定的小说自检文档，正文只修改明确章节");

assert.equal(authorizeFormalMutation({
  instruction: "请自检第1章至第5章并修改正文",
  targets: [{ documentId: "chapter-6", moduleId: "manuscript" }],
}).ok, false, "范围外正文不得混入批量事务");

assert.equal(authorizeFormalMutation({
  instruction: "这些 Skill 分别做什么？",
  targets: [{ documentId: "report-novel", moduleId: "reports" }],
}).ok, false);

console.log("Shensi v2.19 formal mutation permission tests passed");
