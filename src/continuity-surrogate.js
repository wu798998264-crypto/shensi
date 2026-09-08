import { chapterNumberValue } from "./chapter-target.js";

const RANGE_TOKEN = "(\\d+|[零〇一二两三四五六七八九十百千]+)";
const RANGE_PATTERN = new RegExp(`第\\s*${RANGE_TOKEN}\\s*章?\\s*(?:到|至|[-~～—])\\s*第?\\s*${RANGE_TOKEN}\\s*章`);
const SURROGATE_KIND_PATTERN = /事件包|逐章规划|长程规划|章节模拟|长程模拟/;

export const explicitChapterRange = (value = "") => {
  const match = String(value).match(RANGE_PATTERN);
  if (!match) return null;
  const startChapter = chapterNumberValue(match[1]);
  const endChapter = chapterNumberValue(match[2]);
  if (!startChapter || endChapter < startChapter) return null;
  return { startChapter, endChapter };
};

export const continuitySurrogateDocumentIds = ({
  documents = {},
  prompt = "",
  chapterNumbers = [],
  isSubstantive = () => false,
} = {}) => {
  const requiredNumbers = [...new Set(chapterNumbers.map(Number).filter((number) => Number.isInteger(number) && number > 0))];
  const promptRange = explicitChapterRange(prompt);
  if (!requiredNumbers.length || !promptRange || !SURROGATE_KIND_PATTERN.test(String(prompt))) return [];
  if (!requiredNumbers.every((number) => number >= promptRange.startChapter && number <= promptRange.endChapter)) return [];
  return Object.entries(documents)
    .map(([documentId, documentState]) => {
      const title = String(documentState?.title ?? "");
      const range = explicitChapterRange(title);
      return { documentId, documentState, title, range };
    })
    .filter(({ documentId, documentState, title, range }) => (
      documentState?.moduleId === "outline"
      && range
      && SURROGATE_KIND_PATTERN.test(title)
      && requiredNumbers.every((number) => number >= range.startChapter && number <= range.endChapter)
      && isSubstantive(documentId)
    ))
    .sort((left, right) => (
      (left.range.endChapter - left.range.startChapter) - (right.range.endChapter - right.range.startChapter)
      || left.title.localeCompare(right.title, "zh-CN")
    ))
    .map(({ documentId }) => documentId);
};
