import assert from "node:assert/strict";
import { extractDocumentText } from "../src/server/document-extraction.mjs";
import {
  analyzeFullTextImport,
  materializeFullTextImport,
  parseFullTextChapters,
  previewFullTextImport,
} from "../src/server/full-text-import.mjs";

const chapterText = Array.from({ length: 40 }, (_, index) => (
  `第${index + 1}章　御兽契约\n\n沈砚在废墟中抬头，沉默的灵兽蛋第一次回应了他的召唤。`
)).join("\n\n");

const preview = previewFullTextImport({ text: chapterText, sourceName: "玄幻御兽四十章.txt" });
assert.equal(preview.chapterCount, 40);
assert.equal(preview.chapters[0].documentId, "chapter-1");
assert.equal(preview.chapters.at(-1).documentId, "chapter-40");
assert.ok(preview.chapters.every((chapter) => chapter.content.includes("灵兽蛋")));
const compactHeading = parseFullTextChapters("第1章觉醒\n\n灵兽蛋发光\n\n第2章回响\n\n契约完成");
assert.deepEqual(compactHeading.map((chapter) => chapter.title), ["觉醒", "回响"]);

const sectionImport = materializeFullTextImport({
  sourceName: "苍鳞御主-全本.txt",
  candidateId: "zh-section",
  text: "书名：苍鳞御主\n\n序章\n\n退婚书落在桌上。\n\n第一回 觉醒\n\n灵兽蛋发光。\n\n第二回 契约\n\n契约完成。",
});
assert.deepEqual(sectionImport.chapters.map((chapter) => chapter.title), ["序章", "觉醒", "契约"]);
assert.equal(sectionImport.chapters[0].special, true);
assert.ok(sectionImport.bookTitleCandidates.some((candidate) => candidate.title === "苍鳞御主" && candidate.confidence === "high"));
assert.ok(sectionImport.chapters.every((chapter) => !chapter.content.includes("书名：苍鳞御主")), "书名不得混入正文章节内容");

const englishImport = materializeFullTextImport({
  sourceName: "beast-master.txt",
  candidateId: "english-chapter",
  text: "Chapter 1: Awakening\n\nThe egg answered.\n\nChap. 2 - Contract\n\nThe pact was sealed.",
});
assert.deepEqual(englishImport.chapters.map((chapter) => chapter.title), ["Awakening", "Contract"]);

const numericImport = materializeFullTextImport({
  sourceName: "数字章节.txt",
  candidateId: "numeric-heading",
  text: "1. 退婚\n\n婚书被退回。\n\n2、御兽\n\n幼兽睁开双眼。",
});
assert.deepEqual(numericImport.chapters.map((chapter) => chapter.title), ["退婚", "御兽"]);

const ambiguous = analyzeFullTextImport({
  sourceName: "混排全文.txt",
  text: "书名：混排御兽录\n\n序章\n\n开端。\n\n第1章 觉醒\n\n甲。\n\n第2章 契约\n\n乙。\n\nChapter 3: Trial\n\n丙。\n\nChapter 4: Return\n\n丁。\n\n尾声\n\n终局。",
});
assert.equal(ambiguous.requiresCandidateSelection, true);
assert.deepEqual(new Set(ambiguous.candidates.map((candidate) => candidate.id)), new Set(["zh-chapter", "english-chapter"]));
assert.throws(() => materializeFullTextImport({
  sourceName: "混排全文.txt",
  text: "序章\n\n开端。\n\n第1章 觉醒\n\n甲。\n\n第2章 契约\n\n乙。\n\nChapter 3: Trial\n\n丙。\n\nChapter 4: Return\n\n丁。\n\n尾声\n\n终局。",
}), /选择/u);

const largeText = `${"正文内容。".repeat(20_000)}\n\n第1章　起点\n\n第一章正文\n\n第2章　回响\n\n第二章正文`;
const extracted = extractDocumentText({
  bytes: Buffer.from(largeText, "utf8"),
  name: "large-novel.txt",
  mimeType: "text/plain",
  maxCharacters: 4_000_000,
});
assert.equal(extracted.extractionStatus, "extracted");
assert.ok(extracted.text.includes("第2章　回响"), "全文导入专用提取上限不能在 8 万字处截断");

assert.throws(() => parseFullTextChapters("第1章　重复\n\n正文\n\n第1章　重复\n\n正文"), /重复章节/u);
assert.throws(() => parseFullTextChapters("第2章　乱序\n\n正文\n\n第1章　乱序\n\n正文"), /顺序/u);
assert.throws(() => parseFullTextChapters("只有一章正文"), /至少两个/u);

console.log("全文拆分导入解析、长文本提取和异常阻断测试通过");
