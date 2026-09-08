import { chapterNumberValue } from "./chapter-target.js";

const NUMBER_TOKEN = "\\d+|[零〇一二两三四五六七八九十百千万]+";

const headingText = (value = "") => String(value)
  .trim()
  .replace(/^#{1,6}\s*/, "")
  .replace(/<\/?(?:div|p|h[1-6]|strong|b)\b[^>]*>/gi, "")
  .trim();

export const parseEpisodeHeading = (value = "") => {
  const source = headingText(value);
  const chinese = source.match(new RegExp(`^第\\s*(${NUMBER_TOKEN})\\s*集(?:[\\t 　:：·—-]+(.+))?$`));
  const english = source.match(new RegExp(`^Episode\\s+(${NUMBER_TOKEN})(?:[\\t 　:：·—-]+(.+))?$`, "i"));
  const match = chinese ?? english;
  if (!match) return null;
  const number = chapterNumberValue(match[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return {
    number,
    title: String(match[2] || "").trim().replace(/^[-—:：·\s　]+/, "").slice(0, 100) || "未命名",
    language: english ? "en-US" : "zh-CN",
  };
};

export const episodeHeadingParts = (documentId = "", title = "") => {
  const parsed = parseEpisodeHeading(title);
  const idNumber = Number(String(documentId).match(/^script-episode-(\d+)$/)?.[1] || 0);
  const number = parsed?.number || idNumber || 1;
  const normalized = String(title || "").trim();
  const fallbackTitle = normalized
    .replace(new RegExp(`^(?:第\\s*${NUMBER_TOKEN}\\s*集|Episode\\s+${NUMBER_TOKEN})[\\t 　:：·—-]*`, "i"), "")
    .trim();
  return {
    number,
    title: parsed?.title || fallbackTitle || "未命名",
    language: parsed?.language || (/^Episode\b/i.test(normalized) ? "en-US" : "zh-CN"),
  };
};

export const canonicalEpisodeTitle = ({ documentId = "", title = "", episodeNumber = 0, episodeTitle = "", language = "" } = {}) => {
  const parts = episodeHeadingParts(documentId, title);
  const number = Number(episodeNumber) || parts.number;
  const name = String(episodeTitle || parts.title || "未命名").trim() || "未命名";
  const resolvedLanguage = language || parts.language;
  return resolvedLanguage === "en-US" ? `Episode ${number} ${name}` : `第${number}集　${name}`;
};

export const episodeMarkdownFileName = (documentId = "", title = "", { language = "" } = {}) => {
  const parts = episodeHeadingParts(documentId, title);
  const resolvedLanguage = language || parts.language;
  return resolvedLanguage === "en-US"
    ? `Episode ${String(parts.number).padStart(3, "0")}-${parts.title}.md`
    : `第${String(parts.number).padStart(3, "0")}集-${parts.title}.md`;
};
