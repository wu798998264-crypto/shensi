import assert from "node:assert/strict";

import { reviewDeliveryPolicy, reviewScopeFromInstruction } from "../src/review-delivery-policy.js";

const batchScope = reviewScopeFromInstruction({ text: "用强剧情自检检查前三章的质量" });
assert.deepEqual(batchScope, {
  kind: "chapters",
  startChapter: 1,
  endChapter: 3,
  documentIds: ["chapter-1", "chapter-2", "chapter-3"],
});

const singleScope = reviewScopeFromInstruction({ text: "请自检第三章" });
assert.deepEqual(singleScope?.documentIds, ["chapter-3"]);

assert.equal(reviewScopeFromInstruction({ text: "请自检全书" })?.kind, "all_chapters");
assert.equal(reviewScopeFromInstruction({ text: "请自检当前绑定文档" })?.kind, "bound_document");

const batchReview = reviewDeliveryPolicy({ text: "用强剧情自检检查前三章的质量" });
assert.equal(batchReview.active, true);
assert.equal(batchReview.reportRequested, true);
assert.equal(batchReview.target?.documentId, "report-novel", "多章节自检必须把报告写入小说自检，章节仍只作为读取范围");

const savedReview = reviewDeliveryPolicy({ text: "请自检前三章并将报告保存到小说自检" });
assert.equal(savedReview.reportRequested, true);
assert.equal(savedReview.target?.documentId, "report-novel");

console.log("Review context scope contract passed");
