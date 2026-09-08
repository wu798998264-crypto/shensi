export const proseParagraphs = (value = "") => String(value)
  .replace(/\r\n?/g, "\n")
  .split(/\n+/)
  .map((paragraph) => paragraph.trim())
  .filter(Boolean);

// Clipboard output is intentionally normalized separately from persisted text.
// Some providers return escaped line breaks or block markup in an otherwise
// plain-text result; preserve those paragraph boundaries for paste targets.
export const formatClipboardPlainText = (value = "") => {
  let text = String(value ?? "").replace(/\r\n?/g, "\n");
  if (!text.includes("\n") && /\\(?:r\\n|n|r)/u.test(text)) {
    text = text.replace(/\\r\\n|\\n|\\r/gu, "\n");
  }
  if (/<(?:br|\/?(?:p|div|li|h[1-6]|blockquote))\b[^>]*>/iu.test(text)) {
    text = text
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/giu, "\n")
      .replace(/<[^>]+>/gu, "");
  }
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const joinParagraphFragment = (paragraphs, escapeHtml) => paragraphs
  .map((paragraph) => escapeHtml(paragraph))
  .join("</p><p>");

export const expandMultilineParagraphHtml = (html = "") => String(html).replace(
  /<p([^>]*)>([\s\S]*?)<\/p>/gi,
  (match, attributes, content) => {
    if (!/\r?\n\s*\r?\n/.test(content)) return match;
    const paragraphs = content
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    if (paragraphs.length < 2) return match;
    return paragraphs.map((paragraph) => `<p${attributes}>${paragraph.replace(/\r?\n/g, "<br>")}</p>`).join("");
  },
);

export const stripLeadingHeadingHtml = (html = "") => String(html).replace(
  /^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i,
  "",
);

const comparableHeadingText = (value = "") => String(value)
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase();

export const stripMatchingLeadingHeadingHtml = (html = "", acceptedTitles = []) => {
  const source = String(html ?? "");
  const heading = source.match(/^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i);
  if (!heading) return source;
  const expected = new Set((Array.isArray(acceptedTitles) ? acceptedTitles : [acceptedTitles])
    .map(comparableHeadingText)
    .filter(Boolean));
  return expected.has(comparableHeadingText(heading[1])) ? source.slice(heading[0].length) : source;
};

export const chapterHeadingParts = (documentId = "", title = "") => {
  const idNumber = String(documentId).match(/^chapter-(\d+)$/)?.[1] ?? "";
  const normalized = String(title).trim();
  const titleMatch = normalized.match(/^第(\d+)章(?:[\s　:：·-]+(.+))?$/);
  const number = titleMatch?.[1] || idNumber;
  const chapterTitle = titleMatch?.[2]?.trim() || normalized.replace(/^第\d+章[\s　:：·-]*/, "").trim();
  return {
    numberLabel: number ? `第${number}章` : "章节",
    title: chapterTitle || "未命名",
  };
};
