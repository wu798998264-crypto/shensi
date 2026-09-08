import { chapterNumberValue } from "../chapter-target.js";

const MAX_CHAPTERS = 2_000;
const MAX_CHAPTER_TEXT = 4_000_000;
const NUMBER_TOKEN = "\\d{1,6}|[零〇一二两三四五六七八九十百千万两]+";
const TITLE_SEPARATOR = "[\\t 　:：·—|｜-]+";
const SPECIAL_HEADING = /^(?:#{1,6}\s*)?(序章|楔子|引子|前言|终章|尾声|后记|番外(?:[零〇一二两三四五六七八九十百千万两\d]+)?)(?:[\t 　:：·—|｜-]+(.+?))?\s*$/u;

const strategies = [
  {
    id: "zh-chapter",
    label: "中文章标题（第N章）",
    pattern: new RegExp(`^\\s*(?:#{1,6}\\s*)?第\\s*(${NUMBER_TOKEN})\\s*章(?:(?:${TITLE_SEPARATOR})(.+?)|([\\u4e00-\\u9fff].{0,99}))?\\s*$`, "u"),
  },
  {
    id: "zh-section",
    label: "中文回/节标题（第N回、节）",
    pattern: new RegExp(`^\\s*(?:#{1,6}\\s*)?第\\s*(${NUMBER_TOKEN})\\s*(?:回|节)(?:(?:${TITLE_SEPARATOR})(.+?)|([\\u4e00-\\u9fff].{0,99}))?\\s*$`, "u"),
  },
  {
    id: "english-chapter",
    label: "英文章标题（Chapter N）",
    pattern: /^\s*(?:#{1,6}\s*)?(?:chapter|chap\.?|ch\.?)\s*(\d{1,6})(?:[\t 　:：·—|｜-]+(.+?))?\s*$/iu,
  },
  {
    id: "numeric-heading",
    label: "纯数字章标题（N. 标题）",
    pattern: /^\s*(?:#{1,6}\s*)?(\d{1,6})[.、:：)）\t 　-]+(.+?)\s*$/u,
  },
];

const normalizeSourceText = (text = "") => {
  const normalized = String(text ?? "").replace(/\r\n?/gu, "\n").replace(/^\uFEFF/u, "").trim();
  if (!normalized) throw new Error("全文附件没有可导入的文字");
  if (normalized.length > MAX_CHAPTER_TEXT) throw new Error("全文附件超过 400 万字，已停止拆分");
  return normalized;
};

const normalizedTitle = (value = "", fallback = "未命名") => String(value || "")
  .replace(/[\s　]+/gu, " ")
  .replace(/^[\s　:：·—|｜-]+/u, "")
  .trim()
  .slice(0, 100) || fallback;

const specialHeadingFor = (line = "") => {
  const match = String(line).trim().match(SPECIAL_HEADING);
  if (!match) return null;
  const label = normalizedTitle(match[1], "特别章节");
  const detail = normalizedTitle(match[2], "");
  return { special: true, number: 0, title: detail ? `${label} ${detail}` : label, heading: detail ? `${label}　${detail}` : label };
};

const numberedHeadingFor = (line, strategy) => {
  const match = String(line).replace(/^\uFEFF/u, "").match(strategy.pattern);
  if (!match) return null;
  const number = chapterNumberValue(match[1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const title = normalizedTitle(match[2] || match[3], `第${number}章`);
  return { special: false, number, title, heading: `第${number}章　${title}` };
};

const headingsFor = (lines, strategy) => lines.map((line, index) => {
  const heading = numberedHeadingFor(line, strategy) || specialHeadingFor(line);
  return heading ? { ...heading, index } : null;
}).filter(Boolean);

const candidateChapters = (lines, headings, strategy) => {
  if (headings.length < 2) throw new Error("未识别到至少两个独立章节标题");
  if (headings.length > MAX_CHAPTERS) throw new Error(`单次最多拆分 ${MAX_CHAPTERS} 个章节`);
  const seen = new Set();
  let previousNumber = 0;
  return headings.map((heading, index) => {
    if (!heading.special) {
      if (seen.has(heading.number)) throw new Error(`检测到重复章节：第${heading.number}章`);
      if (previousNumber && heading.number <= previousNumber) throw new Error("章节标题顺序不是递增顺序，已停止导入以避免正文错位");
      seen.add(heading.number);
      previousNumber = heading.number;
    }
    const nextIndex = headings[index + 1]?.index ?? lines.length;
    const content = lines.slice(heading.index + 1, nextIndex).join("\n").trim();
    if (!content) throw new Error(`${heading.heading}没有正文内容`);
    const specialId = String(heading.title || "special")
      .normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32) || "special";
    return {
      number: heading.number,
      sequenceNumber: heading.special ? index + 1 : heading.number,
      importOrder: index + 1,
      special: heading.special,
      title: heading.title,
      documentId: heading.special ? `fulltext-special-${specialId}-${index + 1}` : `chapter-${heading.number}`,
      heading: heading.heading,
      content,
      characters: content.length,
      strategyId: strategy.id,
    };
  });
};

const chapterGaps = (chapters) => {
  const numbers = chapters.filter((chapter) => !chapter.special).map((chapter) => chapter.number);
  const gaps = [];
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] > numbers[index - 1] + 1) gaps.push(`${numbers[index - 1]}→${numbers[index]}`);
  }
  return gaps;
};

const safeSourceTitle = (sourceName = "") => String(sourceName || "")
  .replaceAll("\\", "/").split("/").at(-1)
  .replace(/\.[a-z0-9]{1,8}$/iu, "")
  .replace(/[（(]?(?:全文|全本|完结|精校|校对版|完整版)[）)]?$/u, "")
  .trim().slice(0, 100);

const titleCandidatesFor = ({ lines, sourceName, earliestHeadingIndex }) => {
  const candidates = [];
  const add = (title, source, confidence) => {
    const value = normalizedTitle(title, "");
    if (!value || value.length > 100 || candidates.some((candidate) => candidate.title === value)) return;
    candidates.push({ id: `${source}-${candidates.length + 1}`, title: value, source, confidence });
  };
  const preamble = lines.slice(0, Math.max(0, earliestHeadingIndex)).map((line) => line.trim()).filter(Boolean);
  for (const line of preamble) {
    const explicit = line.match(/^(?:书名|作品名|小说名|title)\s*[：:]\s*(.{1,100})$/iu)?.[1];
    if (explicit) add(explicit, "explicit", "high");
  }
  const standalone = preamble.find((line) => line.length <= 80
    && !/^(?:作者|著|文|简介|内容简介|类型|标签|更新时间|https?:)/u.test(line)
    && !/^[-=*#>\s]+$/u.test(line));
  if (standalone) add(standalone.replace(/^#{1,6}\s*/u, ""), "preamble", "medium");
  add(safeSourceTitle(sourceName), "filename", "medium");
  return candidates;
};

export const analyzeFullTextImport = ({ text = "", sourceName = "" } = {}) => {
  const normalized = normalizeSourceText(text);
  const lines = normalized.split("\n");
  const candidates = [];
  const errors = [];
  let earliestHeadingIndex = lines.length;
  for (const strategy of strategies) {
    const headings = headingsFor(lines, strategy);
    if (!headings.some((heading) => !heading.special) || headings.length < 2) continue;
    earliestHeadingIndex = Math.min(earliestHeadingIndex, headings[0].index);
    try {
      const chapters = candidateChapters(lines, headings, strategy);
      const gaps = chapterGaps(chapters);
      candidates.push({
        id: strategy.id,
        label: strategy.label,
        chapterCount: chapters.length,
        characters: chapters.reduce((total, chapter) => total + chapter.characters, 0),
        firstHeading: chapters[0].heading,
        lastHeading: chapters.at(-1).heading,
        gaps,
        warnings: gaps.length ? [`检测到章节跳号：${gaps.join("、")}`] : [],
        chapterTitles: chapters.slice(0, 200).map((chapter) => ({ number: chapter.number, special: chapter.special, heading: chapter.heading, characters: chapter.characters })),
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!candidates.length) {
    if (errors.length) throw new Error(errors[0]);
    throw new Error("未识别到至少两个独立章节标题；请使用“第1章 标题”等常见独立行标题");
  }
  return {
    sourceName: String(sourceName || "未命名全文").trim() || "未命名全文",
    characters: normalized.length,
    candidates,
    requiresCandidateSelection: candidates.length > 1,
    bookTitleCandidates: titleCandidatesFor({ lines, sourceName, earliestHeadingIndex }),
  };
};

export const materializeFullTextImport = ({ text = "", sourceName = "", candidateId = "" } = {}) => {
  const normalized = normalizeSourceText(text);
  const lines = normalized.split("\n");
  const analysis = analyzeFullTextImport({ text: normalized, sourceName });
  const selectedId = String(candidateId || (analysis.candidates.length === 1 ? analysis.candidates[0].id : ""));
  if (!selectedId) throw new Error("检测到多个章节识别方案，请先选择后再导入");
  if (!analysis.candidates.some((candidate) => candidate.id === selectedId)) throw new Error("章节识别方案无效或已过期");
  const strategy = strategies.find((item) => item.id === selectedId);
  const chapters = candidateChapters(lines, headingsFor(lines, strategy), strategy);
  return { ...analysis, selectedCandidateId: selectedId, chapterCount: chapters.length, chapters };
};

export const parseFullTextChapters = (text = "") => materializeFullTextImport({ text }).chapters;

export const previewFullTextImport = ({ text = "", sourceName = "" } = {}) => {
  const materialized = materializeFullTextImport({ text, sourceName });
  return {
    sourceName: materialized.sourceName,
    chapterCount: materialized.chapterCount,
    characters: materialized.chapters.reduce((total, chapter) => total + chapter.characters, 0),
    chapters: materialized.chapters,
  };
};
