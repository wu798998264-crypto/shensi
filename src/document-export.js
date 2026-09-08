const normalizeMarkdown = (value = "") => String(value)
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n")
  .trim();

const markdownVisibleText = (value = "", title = "") => {
  const normalizedTitle = String(title || "").replace(/\s+/g, "").trim();
  const lines = normalizeMarkdown(value).split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex >= 0) {
    const firstContent = lines[firstContentIndex]
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+/g, "")
      .trim();
    if (normalizedTitle && firstContent === normalizedTitle) lines.splice(firstContentIndex, 1);
  }
  return lines.join("\n")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[ \t]*[-+*>#]+\s*/gm, "")
    .replace(/[`*_~|]/g, "")
    .replace(/\s+/g, "");
};

export const preferredDocumentExportMarkdown = ({
  title = "",
  markdown = "",
  htmlMarkdown = "",
} = {}) => {
  const stored = normalizeMarkdown(markdown);
  const editor = normalizeMarkdown(htmlMarkdown);
  if (!stored) return editor;
  if (!editor) return stored;
  const storedScore = markdownVisibleText(stored, title).length;
  const editorScore = markdownVisibleText(editor, title).length;
  return editorScore > storedScore ? editor : stored;
};

