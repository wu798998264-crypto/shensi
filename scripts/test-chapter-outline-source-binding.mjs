import assert from "node:assert/strict";
import { resolveChapterOutlineSource, resolveChapterOutlineSourceId } from "../src/chapter-outline-policy.js";

const content = "章节功能：建立目标与阻力；场景节拍：调查者核对记录后发现矛盾。";
const resolve = (chapterNumber, candidates) => resolveChapterOutlineSourceId({ chapterNumber, candidates });
const source = (id, title, body = content) => ({ id, title, content: body });

const shifted = [
  source("outline-chapter-1", "第1章章纲", ""),
  source("outline-chapter-2", "第2章章纲", "\n "),
  source("outline-chapter-3", "第3章章纲", `第一章章纲｜《多出来的一个人》\n\n${content}`),
  source("outline-chapter-4", "第4章章纲", `第二章章纲｜《照片少了一块》\n\n${content}`),
  source("outline-chapter-5", "第5章章纲", `第三章章纲｜《两条毛巾》\n\n${content}`),
];
assert.deepEqual([1, 2, 3].map((chapter) => resolve(chapter, shifted)), [
  "outline-chapter-3", "outline-chapter-4", "outline-chapter-5",
], "真实章纲标题必须覆盖错位的内部ID和旧元标题");
assert.equal(resolve(4, shifted), "", "正文明确属于第二章时不能按ID冒充第四章章纲");
assert.equal(resolve(5, shifted), "");

assert.equal(resolve(12, [source("chapter-plan", "第十二章章纲")]), "chapter-plan");
assert.equal(resolve(103, [source("chapter-plan", "第一百零三章章纲")]), "chapter-plan");
assert.equal(resolve(12, [source("chapter-plan", "第0012章章纲")]), "chapter-plan");
assert.equal(resolve(12, [source("chapter-plan", "12章章纲")]), "chapter-plan");
assert.equal(resolve(2, [source("outline-chapter-2", "调查继续")]), "outline-chapter-2", "无明确章号时保留正常ID兜底");
assert.equal(resolve(2, [source("outline-chapter-2", "第1章章纲")]), "", "明确不匹配时不能退回ID");
assert.equal(resolve(2, [source("outline-chapter-2", "普通章纲"), source("semantic", "第二章章纲")]), "semantic", "语义绑定优先于泛化ID兜底");
assert.equal(resolve(1, [source("outline-chapter-1", "第1章章纲", "等待生成")]), "");
assert.equal(resolve(1, [source("outline-chapter-1", "第1章章纲", "# 第1章章纲\n\n暂无内容")]), "");
assert.equal(resolve(1, [source("outline-chapter-1", "第1章章纲", "# 第1章章纲")]), "", "只有标题不是可读章纲");
assert.equal(resolve(1, [null, source("", "第1章章纲")]), "");
assert.equal(resolve(0, shifted), "");

const ranges = [
  source("range-wide", "第十至十五章章纲"),
  source("range-narrow", "第11章—第13章章纲"),
  source("single", "第十二章章纲"),
];
assert.equal(resolve(10, ranges), "range-wide");
assert.equal(resolve(11, ranges), "range-narrow");
assert.equal(resolve(12, ranges), "single", "单章来源比跨章范围更精确");
assert.equal(resolve(16, ranges), "");
assert.equal(resolve(2, [source("plain-range", "1-3章章纲")]), "plain-range");
assert.equal(resolve(2, [source("body-range", "章纲", `章节范围：第一章至第三章\n\n${content}`)]), "body-range");
assert.equal(resolve(2, [source("body-range", "章纲", `# 第一至三章章纲\n\n${content}`)]), "body-range");
assert.equal(resolve(2, [source("outline-chapter-2", "第3至1章章纲")]), "", "无效范围不得降级为ID匹配");
assert.equal(resolve(2, [source("outline-chapter-2", "第1章及第3章章纲")]), "", "不把不连续章号猜成连续范围");

const duplicates = [source("one", "第一章章纲"), source("two", "第1章章纲")];
assert.equal(resolve(1, duplicates), "", "多个同等精确来源不能按数组顺序任选");
assert.equal(resolve(1, duplicates.toReversed()), "");
const ambiguous = resolveChapterOutlineSource({ chapterNumber: 1, candidates: duplicates });
assert.equal(ambiguous.status, "ambiguous");
assert.equal(ambiguous.documentId, "");
assert.deepEqual(ambiguous.candidateIds, ["one", "two"]);
assert.equal(resolveChapterOutlineSource({ chapterNumber: 6, candidates: shifted }).status, "missing");
assert.equal(resolveChapterOutlineSource({ chapterNumber: 2, candidates: shifted }).source, "content");
assert.deepEqual(resolveChapterOutlineSource({ chapterNumber: 2, candidates: shifted }).range, { startChapter: 2, endChapter: 2 });

assert.equal(resolve(2, [source("outline-chapter-2", "普通章纲", `本章承接第一章章纲中的线索。\n${content}`)]), "outline-chapter-2", "正文提及他章不应改绑定");
assert.equal(resolve(1, [source("outline-chapter-2", "普通章纲", `本章承接第一章章纲中的线索。\n${content}`)]), "");
assert.equal(resolve(2, [source("outline-chapter-2", "普通章纲", `下一章章纲将在调查之后确认。\n${content}`)]), "outline-chapter-2", "下一章不是第一章");
assert.equal(resolve(1, [source("body-heading", "第9章章纲", `# 总体说明\n\n## 第一章章纲\n${content}`)]), "body-heading");
assert.equal(resolve(1, [source("body-heading", "第9章章纲", `---\ntitle: 第9章章纲\n---\n\n**第一章章纲**\n${content}`)]), "body-heading");

console.log("Chapter outline source binding tests passed");
