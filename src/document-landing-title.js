const GENERIC_DOCUMENT_TITLES = /^(?:(?:第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*(?:章|集)|(?:Chapter|Episode)\s+\d+)\s*)?(?:未命名(?:文档)?|未命名(?:章节|剧本|笔记)|Untitled(?:\s+(?:document|chapter|episode|note))?|当前文档)$/iu;

export const genericLandingDocumentTitle = (value = "") => GENERIC_DOCUMENT_TITLES.test(String(value || "").trim());

export const leadingFormalDocumentTitle = (content = "") => {
  const source = String(content || "");
  const marked = source.match(/^\s*(?:#{1,6}\s+|<h1\b[^>]*>)([^\r\n<]+)(?:<\/h1>)?/iu)?.[1]?.trim();
  if (marked) return marked.slice(0, 100);
  return source.match(/^\s*(第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*(?:章|集)[\s　:：·—-]+[^\r\n<]{1,100})/u)?.[1]
    ?.trim()
    .slice(0, 100) || "";
};

// A sequenced title may be returned as a plain first line instead of a
// Markdown heading. Keep the number out of the stored title field while
// retaining the human-readable chapter/episode name for the directory label.
export const leadingSequencedDocumentTitle = (content = "") => String(content || "")
  .replace(/^\s*(?:#{1,6}\s*)?/u, "")
  .match(/^第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*(?:章|集)[\s　:：·—-]+([^\r\n]{1,100})/u)?.[1]
  ?.trim()
  .slice(0, 100) || "";

const TITLE_META_LINE = /(?:自动落盘|候选稿|创作构思流程|校准承接点|抱歉|不能续写|无法续写|我会|我可以|先按)/u;
const INTERNAL_TITLE_META_LINE = /^(?:target_?document_?id|targetdocumentid|target_?revision|targetrevision|operation|content_?format|contentformat|target_?directory(?:_?id)?|navigation_?target|receipt_?verified)\s*[:：]/iu;

export const generatedDocumentTitleFromContent = (content = "", { fallback = "本章正文" } = {}) => {
  const heading = leadingFormalDocumentTitle(content);
  if (heading && !genericLandingDocumentTitle(heading)) return heading;
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+)/u, "").trim())
    .filter((line) => line && !TITLE_META_LINE.test(line) && !INTERNAL_TITLE_META_LINE.test(line) && !/^[“”‘’"']/u.test(line));
  for (const line of lines) {
    const explicit = line.match(/^第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*(?:章|集)[\s　:：·—-]+(.{1,60})$/u)?.[1]?.trim();
    if (explicit && !genericLandingDocumentTitle(explicit)) return explicit.slice(0, 40);
    const clause = line.split(/[，。！？；：:]/u)[0].replace(/[《》「」『』“”‘’"']/gu, "").trim();
    if (clause.length >= 4) return clause.slice(0, 24);
  }
  return String(fallback || "本章正文").trim().slice(0, 40) || "本章正文";
};

export const landingDocumentTitle = ({ target = null, content = "", chapterNumber = 0, episodeNumber = 0 } = {}) => {
  // Sequenced chapter/episode titles are handled atomically by the structural
  // document creator. A generic heading must never overwrite that identity.
  if (Number(chapterNumber) > 0 || Number(episodeNumber) > 0) return "";
  const requested = String(target?.requestedDocumentTitle || "").trim();
  const inferred = target?.inferredFromOutput === true ? String(target?.title || "").trim() : "";
  const heading = leadingFormalDocumentTitle(content);
  const title = requested || inferred || heading;
  return title && !genericLandingDocumentTitle(title) ? title : "";
};
