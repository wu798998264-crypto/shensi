import { contentRevision } from "./workspace-operations.js";
import { chapterNumberValue } from "./chapter-target.js";

const text = (value = "") => String(value ?? "");
const clean = (value = "") => text(value).trim();

const FULL_REWRITE_PATTERN = /(?:全文|整篇|全部|整体).{0,8}(?:重写|重新生成|重新写|替换)|(?:重写|重新生成|重新写).{0,8}(?:全文|整篇|全部|完整正文)|重新写一版完整/u;
const PATCH_PATTERN = /(?:局部|这段|这句|这些段|以下.{0,4}(?:段|句)|第.{0,8}(?:段|场|章|节)).{0,12}(?:修改|改写|替换|润色|压缩|扩写)|(?:修改|改写|替换|润色|压缩|扩写|改名|更名).{0,16}(?:这段|这句|某段|某场|人物|角色|名字|名称|第\s*[零〇一二两三四五六七八九十百千万\d]+\s*(?:段|场|章|节))|(?:把|将).{1,80}(?:改成|改为|替换成|换成)/u;
const TITLE_PATTERN = /(?:标题|文档名|文件名|章节名|篇名).{0,12}(?:改|修改|更名|重命名|换成|替换)|(?:改|修改|更名|重命名).{0,12}(?:标题|文档名|文件名|章节名|篇名)/u;
const END_CONTINUATION_PATTERN = /(?:续写|继续写|接着写|补写|增补)(?:当前|本|这|该)?(?:章节|章|文档|正文|内容|一段|下一段)?|(?:在|向|追加到|写到).{0,24}(?:文档|文章|正文|章节)?(?:末尾|结尾|最后).{0,12}(?:续写|继续写|接着写|追加|补写|增补|补充|添加|写入)|(?:末尾|结尾|最后).{0,12}(?:续写|继续写|接着写|追加|补写|增补|补充|添加)/u;
const CONTEXTUAL_INSERT_PATTERN = /(?:在|于).{1,180}?(?:之前|前面|之后|后面|中间|之间|前|后).{0,36}(?:插入|插写|补写|增补|补充|增加|添加|加入|追加|写入)|(?:插入|插写|补写|增补|补充|增加|添加|加入|追加).{0,36}(?:在|到|至|进).{1,180}?(?:之前|前面|之后|后面|中间|之间|前|后)/u;
const QUOTED_ANCHOR_PATTERN = /(?:在|于)\s*[“"「『‘]([^”"」』’\n]{1,2000})[”"」』’]\s*(之前|前面|之后|后面|前|后)/u;
const BETWEEN_ANCHORS_PATTERN = /(?:在|于)\s*[“"「『‘]([^”"」』’\n]{1,2000})[”"」』’]\s*(?:与|和|到|至|、)\s*[“"「『‘]([^”"」』’\n]{1,2000})[”"」』’]\s*之间/u;
const PARAGRAPH_ANCHOR_PATTERN = /第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*段\s*(之前|前面|之后|后面|前|后)?/u;
const HEADING_ANCHOR_PATTERN = /第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*(章|节|场|幕|集)\s*(之前|前面|之后|后面|前|后)?/u;
const QUOTED_REPLACEMENT_ANCHOR_PATTERN = /(?:修改|改写|重写|润色|精修|优化|调整|替换|把|将).{0,18}?[“"「『‘]([^”"」』’\n]{1,2000})[”"」』’]/u;

export const terminalContinuationRequested = (instruction = "") => {
  const source = clean(instruction);
  return END_CONTINUATION_PATTERN.test(source) && !CONTEXTUAL_INSERT_PATTERN.test(source.replace(/(?:末尾|结尾|最后)/gu, ""));
};

export const contextualInsertionRequested = (instruction = "") => {
  const source = clean(instruction);
  if (!source || terminalContinuationRequested(source)) return false;
  return CONTEXTUAL_INSERT_PATTERN.test(source);
};

export const documentMutationKindForInstruction = (instruction = "", fallback = "patch") => {
  const source = clean(instruction);
  if (FULL_REWRITE_PATTERN.test(source)) return "replace";
  if (contextualInsertionRequested(source)) return "insert";
  if (terminalContinuationRequested(source)) return "continuation";
  if (PATCH_PATTERN.test(source)) return "patch";
  return fallback;
};

const occurrenceCount = (source, needle) => needle ? text(source).split(needle).length - 1 : 0;

const paragraphRanges = (source = "") => {
  const current = text(source);
  const parts = current.split(/\n\s*\n/gu);
  const ranges = [];
  let cursor = 0;
  for (const part of parts) {
    const start = current.indexOf(part, cursor);
    if (start < 0) continue;
    const end = start + part.length;
    if (part.trim()) ranges.push({ start, end, text: part });
    cursor = end;
  }
  return ranges;
};

const headingAnchor = (source = "", instruction = "") => {
  const match = clean(instruction).match(HEADING_ANCHOR_PATTERN);
  if (!match) return null;
  const number = chapterNumberValue(match[1]);
  if (!number) return null;
  const wanted = new RegExp(`第\\s*${match[1]}\\s*${match[2]}`, "u");
  const lines = text(source).split("\n");
  const line = lines.find((candidate) => wanted.test(candidate));
  return line ? { text: line, direction: /之前|前面|前/u.test(match[3] || "") ? "before" : "after" } : null;
};

const paragraphAnchor = (source = "", instruction = "") => {
  const match = clean(instruction).match(PARAGRAPH_ANCHOR_PATTERN);
  if (!match) return null;
  const number = chapterNumberValue(match[1]);
  const range = paragraphRanges(source)[number - 1];
  return range ? { text: range.text, direction: /之前|前面|前/u.test(match[2] || "") ? "before" : "after" } : null;
};

const insertionAnchor = ({ currentContent = "", instruction = "", selectedText = "" } = {}) => {
  const current = text(currentContent);
  const source = clean(instruction);
  const direction = /(?:之前|前面|前).{0,24}(?:插入|插写|补写|增补|补充|增加|添加|加入|追加|写入)|(?:插入|插写|补写|增补|补充|增加|添加|加入|追加).{0,24}(?:之前|前面|前)/u.test(source)
    ? "before"
    : "after";
  const selected = text(selectedText).trim();
  if (selected) return { text: selected, direction };
  const between = source.match(BETWEEN_ANCHORS_PATTERN);
  if (between) {
    const first = between[1];
    const second = between[2];
    const firstIndex = current.indexOf(first);
    const secondIndex = current.indexOf(second, firstIndex + first.length);
    if (firstIndex >= 0 && secondIndex > firstIndex && occurrenceCount(current, first) === 1 && occurrenceCount(current, second) === 1) {
      return { text: first, direction: "after", followingAnchor: second };
    }
  }
  const quoted = source.match(QUOTED_ANCHOR_PATTERN);
  if (quoted) return { text: quoted[1], direction: /之前|前面|前/u.test(quoted[2]) ? "before" : "after" };
  return paragraphAnchor(current, source) || headingAnchor(current, source);
};

const insertionSeparator = (anchor = "", fragment = "") => {
  const anchorLine = text(anchor).trim();
  const fragmentLine = text(fragment).trim();
  if ((/^\|/u.test(anchorLine) && /^\|/u.test(fragmentLine)) || (/^(?:[-*+] |\d+[.)] )/u.test(anchorLine) && /^(?:[-*+] |\d+[.)] )/u.test(fragmentLine))) return "\n";
  return "\n\n";
};

export const inferContextualInsertionEditPlan = ({
  instruction = "",
  targetDocumentId = "",
  currentContent = "",
  candidateContent = "",
  selectedText = "",
  executionSurface = "chat",
  requestId = "",
  baselineRevision = "",
} = {}) => {
  if (!contextualInsertionRequested(instruction)) return null;
  const current = text(currentContent);
  const fragment = text(candidateContent).trim();
  const anchor = insertionAnchor({ currentContent: current, instruction, selectedText });
  if (!current || !fragment || !anchor?.text || occurrenceCount(current, anchor.text) !== 1) return null;
  if (anchor.followingAnchor && current.indexOf(anchor.followingAnchor, current.indexOf(anchor.text) + anchor.text.length) < 0) return null;
  const separator = insertionSeparator(anchor.text, fragment);
  const replacementText = anchor.direction === "before"
    ? `${fragment}${separator}${anchor.text}`
    : `${anchor.text}${separator}${fragment}`;
  return validateDocumentEditPlan({
    requestId,
    taskId: requestId,
    instruction,
    executionSurface,
    targetDocumentId,
    baselineRevision: baselineRevision || contentRevision(current),
    mode: "patch",
    edits: [{
      editId: "contextual-insert-1",
      kind: "anchored_replace",
      originalText: anchor.text,
      replacementText,
      expectedOccurrences: 1,
      scope: "body",
    }],
  });
};

export const inferContextualReplacementEditPlan = ({
  instruction = "",
  targetDocumentId = "",
  currentContent = "",
  candidateContent = "",
  selectedText = "",
  executionSurface = "chat",
  requestId = "",
  baselineRevision = "",
} = {}) => {
  if (documentMutationKindForInstruction(instruction, "") !== "patch") return null;
  const current = text(currentContent);
  const replacement = text(candidateContent).trim();
  const selected = text(selectedText).trim();
  const quoted = clean(instruction).match(QUOTED_REPLACEMENT_ANCHOR_PATTERN)?.[1] || "";
  const paragraph = paragraphAnchor(current, instruction)?.text || "";
  const original = selected || paragraph || quoted;
  if (!current || !replacement || !original || occurrenceCount(current, original) !== 1 || replacement === original) return null;
  return validateDocumentEditPlan({
    requestId,
    taskId: requestId,
    instruction,
    executionSurface,
    targetDocumentId,
    baselineRevision: baselineRevision || contentRevision(current),
    mode: "patch",
    edits: [{
      editId: "contextual-replace-1",
      kind: "anchored_replace",
      originalText: original,
      replacementText: replacement,
      expectedOccurrences: 1,
      scope: "body",
    }],
  });
};

export const documentMutationOutputInstruction = (instruction = "") => {
  const kind = documentMutationKindForInstruction(instruction, "");
  if (kind === "insert") return "本轮是上下文感知的中间补写：完整阅读目标位置前后文，只输出需要插入的新内容片段，不要复述、重写或省略原文；新片段必须同时承接前文与后文。";
  if (kind === "continuation") return "本轮是末尾续写：阅读目标文档结尾及必要设定，只输出从现有结尾继续的新内容，不要复述或重写已有原文。";
  if (kind === "patch") return "本轮是局部改写：只输出指定选区、段落或锚点的新内容，不要返回整篇文档；未指定的原文必须保持不变。";
  if (kind === "replace") return "本轮已明确要求全文重写或整体覆盖：输出目标文档的完整新内容。";
  return "";
};

export const documentEditModeForInstruction = (instruction = "", fallback = "patch") => {
  const source = clean(instruction);
  if (FULL_REWRITE_PATTERN.test(source)) return "replace";
  if (PATCH_PATTERN.test(source)) return "patch";
  return fallback === "replace" ? "replace" : "patch";
};

export const documentTitleModificationRequested = (instruction = "") => TITLE_PATTERN.test(clean(instruction));

const normalizeKind = (kind = "") => ({
  rename: "replace_all_exact",
  replace_all: "replace_all_exact",
  block: "anchored_replace",
  semantic: "anchored_replace",
  range: "range",
  heading: "heading",
  append: "append",
}[clean(kind).toLowerCase()] || clean(kind).toLowerCase());

const normalizeEdit = (edit = {}, index = 0) => ({
  editId: clean(edit.editId) || `edit-${index + 1}`,
  kind: normalizeKind(edit.kind || edit.type),
  originalText: text(edit.originalText ?? edit.original ?? edit.from),
  replacementText: text(edit.replacementText ?? edit.content ?? edit.to),
  ...(Number.isInteger(Number(edit.expectedOccurrences)) && Number(edit.expectedOccurrences) >= 0
    ? { expectedOccurrences: Number(edit.expectedOccurrences) }
    : {}),
  scope: clean(edit.scope) || "body",
  ...(Number.isInteger(Number(edit.start)) ? { start: Number(edit.start) } : {}),
  ...(Number.isInteger(Number(edit.end)) ? { end: Number(edit.end) } : {}),
  ...(clean(edit.heading) ? { heading: clean(edit.heading) } : {}),
  anchors: (Array.isArray(edit.anchors) ? edit.anchors : [edit.anchor || {
    prefix: edit.beforeAnchor,
    suffix: edit.afterAnchor,
  }]).filter(Boolean).map((anchor) => ({
    prefix: text(anchor.prefix),
    suffix: text(anchor.suffix),
  })).filter((anchor) => anchor.prefix || anchor.suffix),
});

export const normalizeDocumentEditPlan = (plan = {}, defaults = {}) => {
  const instruction = clean(plan.instruction || defaults.instruction);
  const mode = documentEditModeForInstruction(instruction, plan.mode || defaults.mode || "patch");
  return {
    schemaVersion: 1,
    requestId: clean(plan.requestId || defaults.requestId),
    taskId: clean(plan.taskId || defaults.taskId || plan.requestId || defaults.requestId),
    executionSurface: (plan.executionSurface || defaults.executionSurface) === "agent" ? "agent" : "chat",
    targetDocumentId: clean(plan.targetDocumentId || defaults.targetDocumentId),
    baselineRevision: clean(plan.baselineRevision || defaults.baselineRevision),
    mode,
    requestedTitle: documentTitleModificationRequested(instruction)
      ? clean(plan.requestedTitle || defaults.requestedTitle)
      : "",
    instruction,
    edits: (Array.isArray(plan.edits) ? plan.edits : []).map(normalizeEdit),
  };
};

const invalid = (message, code = "DOCUMENT_EDIT_PLAN_INVALID") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

export const validateDocumentEditPlan = (input = {}, defaults = {}) => {
  const plan = normalizeDocumentEditPlan(input, defaults);
  if (!plan.targetDocumentId) invalid("DocumentEditPlan 缺少目标文档");
  if (plan.mode !== "patch") invalid("局部编辑计划必须使用 patch 模式");
  if (!plan.edits.length) invalid("DocumentEditPlan 没有局部编辑项");
  if (plan.edits.length > 200) invalid("单次局部编辑不能超过 200 项");
  const ids = new Set();
  for (const edit of plan.edits) {
    if (ids.has(edit.editId)) invalid(`局部编辑 ID 重复：${edit.editId}`);
    ids.add(edit.editId);
    if (!["replace_all_exact", "anchored_replace", "range", "heading", "append"].includes(edit.kind)) {
      invalid(`不支持的局部编辑类型：${edit.kind || "unknown"}`);
    }
    if (["replace_all_exact", "anchored_replace"].includes(edit.kind) && !edit.originalText) invalid(`${edit.editId} 缺少原文`);
    if (edit.originalText.length > 200_000 || edit.replacementText.length > 200_000) invalid(`${edit.editId} 文本过长`);
  }
  return plan;
};

const exactReplacementPairs = (instruction = "") => {
  const source = text(instruction);
  const quotedPattern = /(?:把|将)\s*[“"]([\s\S]{1,20000}?)[”"]\s*(?:全部|所有|统一)?\s*(?:改成|改为|替换成|替换为|换成)\s*[“"]([\s\S]{0,40000}?)[”"](?=\s*(?:[，。；;]|$))/gu;
  const pattern = /(?:把|将)\s*[“”"'‘’]?([^，。；;\n]{1,40}?)[“”"'‘’]?\s*(?:全部|所有|统一)?\s*(?:改成|改为|替换成|换成)\s*[“”"'‘’]?([^，。；;\n]{1,40}?)[“”"'‘’]?(?=\s*(?:[，。；;]|$))/gu;
  const normalizeOriginal = (value) => clean(value)
    .replace(/^(?:当前)?(?:文档|正文)(?:中|里|里的)?\s*/u, "")
    .replace(/^(?:人物|角色)(?:名字|名称)?[:：]?\s*/u, "");
  const pairs = [...source.matchAll(quotedPattern), ...source.matchAll(pattern)].map((match) => ({
    originalText: normalizeOriginal(match[1]),
    replacementText: clean(match[2]),
  })).filter((item) => item.originalText && item.replacementText && item.originalText !== item.replacementText);
  return pairs.filter((item, index) => pairs.findIndex((candidate) => candidate.originalText === item.originalText && candidate.replacementText === item.replacementText) === index);
};

export const inferExactReplacementEditPlan = ({
  instruction = "",
  targetDocumentId = "",
  currentContent = "",
  executionSurface = "chat",
  requestId = "",
  baselineRevision = "",
} = {}) => {
  if (documentEditModeForInstruction(instruction, "patch") !== "patch") return null;
  const pairs = exactReplacementPairs(instruction);
  if (!pairs.length) return null;
  const edits = pairs.map((pair, index) => ({
    editId: `exact-replace-${index + 1}`,
    kind: "replace_all_exact",
    ...pair,
    expectedOccurrences: occurrenceCount(currentContent, pair.originalText),
    scope: "body",
  }));
  if (edits.some((edit) => edit.expectedOccurrences < 1)) return null;
  return validateDocumentEditPlan({
    requestId,
    taskId: requestId,
    instruction,
    executionSurface,
    targetDocumentId,
    baselineRevision: baselineRevision || contentRevision(text(currentContent)),
    mode: "patch",
    edits,
  });
};

export const patchesFromDocumentEditPlan = (input = {}, defaults = {}) => validateDocumentEditPlan(input, defaults).edits.map((edit) => {
  if (edit.kind === "replace_all_exact") return {
    type: "replace_all_exact",
    editId: edit.editId,
    original: edit.originalText,
    content: edit.replacementText,
    expectedOccurrences: edit.expectedOccurrences,
  };
  if (edit.kind === "anchored_replace") return {
    type: "anchored_replace",
    editId: edit.editId,
    original: edit.originalText,
    content: edit.replacementText,
    anchors: edit.anchors,
    expectedOccurrences: edit.expectedOccurrences,
  };
  return {
    type: edit.kind,
    editId: edit.editId,
    content: edit.replacementText,
    original: edit.originalText,
    ...(edit.start !== undefined ? { start: edit.start } : {}),
    ...(edit.end !== undefined ? { end: edit.end } : {}),
    ...(edit.heading ? { heading: edit.heading } : {}),
  };
});
