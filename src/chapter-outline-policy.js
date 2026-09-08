import { chapterNumberValue } from "./chapter-target.js";
import { documentContentState } from "./version-store.js";

const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
};

const CHAPTER_NUMBER = "(?:\\d+|[零〇一二两三四五六七八九十百千]+)";
const CHAPTER_LABEL = `(?:第\\s*(${CHAPTER_NUMBER})|(?<!\\d)(\\d+))\\s*(?:(?:章\\s*)?[-~～—–至到]\\s*(?:第\\s*)?(${CHAPTER_NUMBER})\\s*章|章)`;
const plainLine = (value = "") => String(value).trim().replace(/^#{1,6}\s*/u, "").replace(/^\*{1,2}|\*{1,2}$/gu, "").trim();

const chapterRangeFromLabel = (value = "") => {
  const source = String(value).trim();
  const matches = [...source.matchAll(new RegExp(CHAPTER_LABEL, "gu"))];
  if (!matches.length) return null;
  // A malformed or discontinuous declaration is not permission to fall back to the ID.
  if (matches.length !== 1) return { invalid: true };
  const match = matches[0];
  const startChapter = positiveInteger(chapterNumberValue(match[1] || match[2]));
  const endChapter = positiveInteger(chapterNumberValue(match[3] || match[1] || match[2]));
  if (!startChapter || endChapter < startChapter) return { invalid: true };
  return { startChapter, endChapter };
};

const isOutlineHeading = (line = "") => {
  if (/^章节范围\s*[：:]/u.test(line)) return true;
  const match = line.match(new RegExp(CHAPTER_LABEL, "u"));
  return match?.index === 0
    && /^(?:\s*[：:·｜|—-]?\s*)(?:《[^》\n]+》\s*)?(?:章纲|细纲|(?:详细)?大纲)(?:[\s：:·｜|—-]|$)/u.test(line.slice(match[0].length));
};

const candidateBinding = (candidate = {}) => {
  const lines = String(candidate.content || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").split(/\r?\n/u).map(plainLine);
  const headingIndex = lines.findIndex(isOutlineHeading);
  const heading = lines[headingIndex] || "";
  const body = lines.filter((line, index) => index !== headingIndex && line !== plainLine(candidate.title)).join("\n");
  if (documentContentState(body, candidate) !== "substantive") return null;
  // The real outline heading may disagree with a stale title/ID after historical imports.
  const contentRange = chapterRangeFromLabel(heading);
  const titleRange = chapterRangeFromLabel(candidate.title);
  const range = contentRange ?? titleRange;
  return { ...candidate, range, source: contentRange ? "content" : titleRange ? "title" : "id" };
};

export const resolveChapterOutlineSource = ({ chapterNumber = 0, candidates = [] } = {}) => {
  const missing = { status: "missing", documentId: "", candidateIds: [], source: "", range: null };
  const number = positiveInteger(chapterNumber);
  if (!number) return missing;
  const substantive = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({ ...candidate, id: String(candidate?.id || "").trim() }))
    .filter((candidate) => candidate.id)
    .map(candidateBinding)
    .filter(Boolean);
  let matches = substantive
    .filter((candidate) => candidate.range
      && number >= candidate.range.startChapter
      && number <= candidate.range.endChapter)
    .sort((left, right) => (left.range.endChapter - left.range.startChapter) - (right.range.endChapter - right.range.startChapter));
  if (matches.length) {
    const width = matches[0].range.endChapter - matches[0].range.startChapter;
    matches = matches.filter(({ range }) => range.endChapter - range.startChapter === width);
  } else {
    matches = substantive.filter((candidate) => !candidate.range && candidate.id === `outline-chapter-${number}`);
  }
  if (!matches.length) return missing;
  const candidateIds = [...new Set(matches.map(({ id }) => id))];
  if (candidateIds.length > 1) return { ...missing, status: "ambiguous", candidateIds };
  return { status: "resolved", documentId: candidateIds[0], candidateIds, source: matches[0].source, range: matches[0].range };
};

export const resolveChapterOutlineSourceId = (options = {}) => resolveChapterOutlineSource(options).documentId;

export const chapterOutlineEndChapter = (candidate = {}) => {
  const binding = candidateBinding(candidate);
  if (!binding) return 0;
  return binding.range ? binding.range.invalid ? 0 : binding.range.endChapter
    : positiveInteger(String(candidate.id || "").match(/^outline-chapter-(\d+)$/)?.[1]);
};
