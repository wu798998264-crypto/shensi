import assert from "node:assert/strict";
import { choiceQuestionSimilarity } from "../src/server/conversation-agent-service.mjs";

const first = {
  question: "这篇约900字的文章，对同龄人进度应采取哪一种核心立场？请选择唯一主线",
  options: [{ id: "a", label: "保持自己的节奏" }, { id: "b", label: "与同龄人比较" }],
};
const restated = {
  question: "这篇约900字的文章，你希望把哪一种态度作为唯一核心立场？三个方向不混写",
  options: first.options,
};
const different = {
  question: "这篇文章最后需要采用什么标题形式？",
  options: [{ id: "a", label: "叙事标题" }, { id: "b", label: "观点标题" }],
};

assert.ok(choiceQuestionSimilarity(first, restated) >= 0.58, "同一选择问题的改写应被识别为重复");
assert.ok(choiceQuestionSimilarity(first, different) < 0.58, "不同阶段的问题不得被误判为重复");
assert.equal(choiceQuestionSimilarity(
  { question: "选择方向", metadata: { dedupeKey: "outline-focus" } },
  { question: "换一种问法", metadata: { dedupeKey: "outline-focus" } },
), 1, "显式语义键应稳定复用答案");
console.log("conversation choice deduplication regressions passed");
