const splitRow = (line) => {
  let source = String(line ?? "").trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);
  const cells = [];
  let current = "";
  let escaped = false;
  let wikilinkDepth = 0;
  let inlineCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      current += character === "|" ? "|" : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (!inlineCode && source.slice(index, index + 2) === "[[") {
      wikilinkDepth += 1;
      current += "[[";
      index += 1;
      continue;
    }
    if (!inlineCode && wikilinkDepth && source.slice(index, index + 2) === "]]") {
      wikilinkDepth -= 1;
      current += "]]";
      index += 1;
      continue;
    }
    if (character === "`" && !wikilinkDepth) inlineCode = !inlineCode;
    if (character === "|" && !wikilinkDepth && !inlineCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
};

const TABLE_LAYOUT_PATTERN = /^<!--\s*shensi-table-layout:(\{[^\n]*\})\s*-->$/i;
const TABLE_COLUMN_MIN = 64;
const TABLE_COLUMN_MAX = 1600;
const TABLE_ROW_MIN = 28;
const TABLE_ROW_MAX = 1200;

const normalizedDimensionList = (values, count, minimum, maximum) => {
  const source = Array.isArray(values) ? values : [];
  const result = Array.from({ length: Math.max(0, count) }, (_, index) => {
    const value = Number(source[index]);
    return Number.isFinite(value) && value >= minimum && value <= maximum ? Math.round(value) : null;
  });
  while (result.length && result.at(-1) == null) result.pop();
  return result;
};

export const normalizeMarkdownTableLayout = (layout = {}, { columnCount = 0, rowCount = 0 } = {}) => ({
  columnWidths: normalizedDimensionList(layout.columnWidths ?? layout.columns, columnCount, TABLE_COLUMN_MIN, TABLE_COLUMN_MAX),
  rowHeights: normalizedDimensionList(layout.rowHeights ?? layout.rows, rowCount, TABLE_ROW_MIN, TABLE_ROW_MAX),
});

const parseTableLayout = (line = "") => {
  const match = String(line).trim().match(TABLE_LAYOUT_PATTERN);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const tableLayoutComment = (layout, dimensions) => {
  const normalized = normalizeMarkdownTableLayout(layout, dimensions);
  if (!normalized.columnWidths.some(Number.isFinite) && !normalized.rowHeights.some(Number.isFinite)) return "";
  return `<!-- shensi-table-layout:${JSON.stringify({ columns: normalized.columnWidths, rows: normalized.rowHeights })} -->`;
};

const alignment = (cell) => {
  const source = String(cell ?? "").replace(/\s+/g, "");
  if (!/^:?-{3,}:?$/.test(source)) return null;
  if (source.startsWith(":") && source.endsWith(":")) return "center";
  if (source.endsWith(":")) return "right";
  return "left";
};

export const parseMarkdownTable = (block) => {
  const lines = String(block ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const rawLayout = parseTableLayout(lines[0]);
  if (rawLayout) lines.shift();
  if (lines.length < 2 || !lines[0].includes("|") || !lines[1].includes("|")) return null;
  const headers = splitRow(lines[0]);
  const separator = splitRow(lines[1]);
  if (!headers.length || separator.length !== headers.length) return null;
  const alignments = separator.map(alignment);
  if (alignments.some((value) => !value)) return null;
  const rows = lines.slice(2).map(splitRow).map((cells) => [
    ...cells.slice(0, headers.length),
    ...Array(Math.max(0, headers.length - cells.length)).fill(""),
  ]);
  return {
    headers,
    alignments,
    rows,
    layout: normalizeMarkdownTableLayout(rawLayout ?? {}, { columnCount: headers.length, rowCount: rows.length + 1 }),
  };
};

export const markdownTableToHtml = (block, { renderInline = (value) => String(value ?? "") } = {}) => {
  const table = parseMarkdownTable(block);
  if (!table) return "";
  const cell = (tag, value, index) => `<${tag} data-align="${table.alignments[index]}">${renderInline(value)}</${tag}>`;
  const rowHeight = (index) => Number.isFinite(table.layout.rowHeights[index]) ? ` data-row-height="${table.layout.rowHeights[index]}"` : "";
  const columns = table.headers.map((_, index) => Number.isFinite(table.layout.columnWidths[index])
    ? `<col data-column-width="${table.layout.columnWidths[index]}">`
    : "<col>").join("");
  return `<div class="markdown-table-wrap" data-markdown-table="true"><table data-resizable-table="true"><colgroup>${columns}</colgroup><thead><tr${rowHeight(0)}>${table.headers.map((value, index) => cell("th", value, index)).join("")}</tr></thead><tbody>${table.rows.map((row, rowIndex) => `<tr${rowHeight(rowIndex + 1)}>${row.map((value, index) => cell("td", value, index)).join("")}</tr>`).join("")}</tbody></table></div>`;
};

export const escapeMarkdownTableCell = (value) => String(value ?? "")
  .replace(/\r?\n/g, "<br>")
  .replace(/\[\[[^\]]+\]\]|`[^`]*`|\|/g, (token) => (
    token === "|" ? "\\|" : token.startsWith("[[") ? token.replaceAll("|", "\\|") : token
  ))
  .trim();

export const markdownTableRowsToMarkdown = (rows, alignments = [], layout = {}) => {
  const sourceRows = Array.isArray(rows) ? rows.filter(Array.isArray) : [];
  if (!sourceRows.length) return "";
  const columnCount = Math.max(...sourceRows.map((row) => row.length));
  if (!columnCount) return "";
  const normalizedRows = sourceRows.map((row) => [
    ...row.slice(0, columnCount).map(escapeMarkdownTableCell),
    ...Array(Math.max(0, columnCount - row.length)).fill(""),
  ]);
  const separators = Array.from({ length: columnCount }, (_, index) => (
    alignments[index] === "center" ? ":---:" : alignments[index] === "right" ? "---:" : "---"
  ));
  const markdownRow = (row) => `| ${row.join(" | ")} |`;
  const markdown = [markdownRow(normalizedRows[0]), markdownRow(separators), ...normalizedRows.slice(1).map(markdownRow)].join("\n");
  const comment = tableLayoutComment(layout, { columnCount, rowCount: normalizedRows.length });
  return comment ? `${comment}\n${markdown}` : markdown;
};
