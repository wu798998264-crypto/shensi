const stripMarkdownDecoration = (value = "") => String(value)
  .replace(/^#{1,6}\s+/, "")
  .replace(/[*_~`]/g, "")
  .trim();

const wikilinkLabel = (target = "", alias = "") => {
  if (String(alias).trim()) return String(alias).trim();
  const normalized = String(target).trim().replace(/\\/g, "/");
  const [notePath, heading = ""] = normalized.split("#", 2);
  const noteName = notePath.split("/").at(-1)?.replace(/\.(?:md|canvas)$/i, "") || "";
  return heading ? `${noteName} · ${heading}` : noteName;
};

export const cleanObsidianInlineMarkdown = (value = "") => String(value)
  .replace(/%%[\s\S]*?%%/g, "")
  .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => wikilinkLabel(target, alias))
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => wikilinkLabel(target, alias))
  .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
  .replace(/`([^`\n]+)`/g, "$1")
  .replace(/\s+\^[a-z0-9-]+\s*$/i, "")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .replace(/\u00A0/g, " ");

const terminalNavigationHeading = /^(?:#{1,6}\s*)?(?:\*{1,2})?(?:相关链接|关联链接|双向链接|反向链接|返回链接|backlinks?|related links?)(?:\*{1,2})?\s*[:：]?\s*$/i;

const navigationOnlyLine = (line = "") => {
  const value = String(line).trim();
  if (!value || /^-{1,3}$/.test(value)) return true;
  if (/^(?:[-*+]\s*)?!?\[\[[^\]]+\]\]\s*$/.test(value)) return true;
  if (/^(?:[-*+]\s*)?\[[^\]]+\]\([^)]+\)\s*$/.test(value)) return true;
  return /^#[^\s#]+(?:\s+#[^\s#]+)*$/.test(value);
};

const removeTerminalNavigation = (lines) => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!terminalNavigationHeading.test(lines[index].trim())) continue;
    if (lines.slice(index + 1).every(navigationOnlyLine)) return lines.slice(0, index);
    break;
  }
  return lines;
};

const removeDuplicateLeadingTitle = (lines, title = "") => {
  const normalizedTitle = stripMarkdownDecoration(title);
  if (!normalizedTitle) return lines;
  const index = lines.findIndex((line) => line.trim());
  if (index < 0 || index > 2 || !/^#{1,6}\s+/.test(lines[index])) return lines;
  const heading = stripMarkdownDecoration(cleanObsidianInlineMarkdown(lines[index]));
  if (heading === normalizedTitle || heading.includes(`《${normalizedTitle}》`)) lines.splice(index, 1);
  return lines;
};

export const cleanObsidianMigrationMarkdown = (markdown = "", { title = "", removeNavigation = true } = {}) => {
  let lines = String(markdown).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/\r\n?/g, "\n").split("\n");
  if (removeNavigation) lines = removeTerminalNavigation(lines);
  lines = removeDuplicateLeadingTitle(lines, title);
  let fenced = false;
  lines = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const cleaned = cleanObsidianInlineMarkdown(line).replace(/^\s*[-*+]\s*$/, "");
    return /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(cleaned) ? "" : cleaned;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

export const cleanGeneratedPlainText = (value = "") => {
  let fenced = false;
  return String(value).replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const cleaned = cleanObsidianInlineMarkdown(line)
      .replace(/^\s{0,3}#{1,6}[ \t]+/, "")
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
      .replace(/^\s*[-*+]\s*$/, "");
    return /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(cleaned) ? "" : cleaned;
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const assistantPreambleLine = /^(?:(?:好的?|当然(?:可以)?|没问题)[，,。！!：:]*)?(?:已(?:经)?(?:为你|按要求|根据要求)?(?:完成|生成|改写|重写|修改|优化|整理|更新|创作)|(?:下面|以下)(?:是|为)|这是(?:为你|按要求)?|根据(?:你的|上述|本轮)?要求|我(?:已经|已|将|会)(?:为你)?)(?:[^\r\n]{0,80})(?:版本|正文|内容|结果|稿件|文档|章节|剧本|提示词|调整|修改)[：:。！!，,]*$/iu;
const assistantClosingLine = /^(?:以上(?:就是|是)?|如需|如果你(?:还|需要)|希望(?:这|以上)|我还可以|已完成(?:本轮)?)(?:[^\r\n]{0,100})(?:内容|版本|正文|调整|修改|优化|创作|生成|帮助)?[。！!]*$/iu;
const assistantOperationalLine = /^(?:抱歉[，,。！!：:]?|我(?:会|将|可以|能|不能|无法|不可以)|先(?:按|确认|检查|读取)|首先(?:会|要|需要)?)[^\r\n]{0,260}(?:自动落盘|落盘|写入文档|候选稿|创作构思流程|校准承接点|再交付|交付正文|不能续写|无法续写|不可以续写|不能为你续写|改写为原创|使用全新人物|使用新的?世界观|后续正文)[^\r\n]*$/iu;
const assistantRefusalLine = /^(?:抱歉[，,。！!：:]*)?(?:我)?(?:不能|无法|不可以|不会)(?:继续|直接|为你)?(?:续写|创作|生成|改写|复刻|照搬)[^\r\n]*$/iu;

export const isAssistantOperationalText = (value = "") => {
  const lines = cleanGeneratedPlainText(value).split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => assistantPreambleLine.test(line)
    || assistantClosingLine.test(line)
    || assistantOperationalLine.test(line)
    || assistantRefusalLine.test(line));
};

// A persisted document receives only the deliverable.  Chat acknowledgements
// stay in the conversation even when a provider placed them inside the text
// candidate, which also prevents a prefixed acknowledgement from exposing an
// older candidate as the apparent landing source.
export const cleanFormalDocumentContent = (value = "") => {
  const lines = cleanGeneratedPlainText(value)
    .replace(/^【(?:候选稿|正式正文|正文|最终稿)】\s*/u, "")
    .split("\n")
    .filter((line) => !/^\s*(?:```|~~~)(?:[a-z0-9_-]+)?\s*$/iu.test(line));
  let start = 0;
  while (start < Math.min(lines.length, 8)) {
    const line = lines[start].trim();
    if (!line) {
      start += 1;
      continue;
    }
    if (!assistantPreambleLine.test(line) && !assistantOperationalLine.test(line) && !assistantRefusalLine.test(line)) break;
    start += 1;
  }
  let end = lines.length;
  while (end > start) {
    const line = lines[end - 1].trim();
    if (!line) {
      end -= 1;
      continue;
    }
    if (!assistantClosingLine.test(line) && !assistantOperationalLine.test(line) && !assistantRefusalLine.test(line)) break;
    end -= 1;
  }
  return lines.slice(start, end).join("\n").replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
};
