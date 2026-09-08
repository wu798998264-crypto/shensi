import { contentRevision } from "./workspace-operations.js";

const value = (input = "") => String(input ?? "");
const fail = (message, code = "DOCUMENT_PATCH_CONFLICT") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const replaceUnique = (source, before, after, label) => {
  const first = source.indexOf(before);
  if (first < 0) fail(`${label}未在磁盘最新版中找到`);
  if (source.indexOf(before, first + before.length) >= 0) fail(`${label}在磁盘最新版中不唯一`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
};

const occurrenceRanges = (source, needle) => {
  if (!needle) return [];
  const ranges = [];
  let cursor = 0;
  while (cursor <= source.length - needle.length) {
    const start = source.indexOf(needle, cursor);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    cursor = start + Math.max(needle.length, 1);
  }
  return ranges;
};

const resolveAnchoredRange = (source, patch) => {
  const original = value(patch.original);
  const matches = occurrenceRanges(source, original);
  const expected = Number(patch.expectedOccurrences);
  if (Number.isInteger(expected) && expected >= 0 && matches.length !== expected) {
    fail(`局部替换命中数量已变化：预期 ${expected}，实际 ${matches.length}`);
  }
  if (!matches.length) fail("局部替换原文未在磁盘最新版中找到");
  const anchors = Array.isArray(patch.anchors) ? patch.anchors : [];
  const narrowed = anchors.length ? matches.filter((range) => anchors.some((anchor) => {
    const prefix = value(anchor?.prefix);
    const suffix = value(anchor?.suffix);
    return (!prefix || source.slice(Math.max(0, range.start - prefix.length), range.start) === prefix)
      && (!suffix || source.slice(range.end, range.end + suffix.length) === suffix);
  })) : matches;
  if (narrowed.length !== 1) fail(narrowed.length ? "局部替换锚点不唯一" : "局部替换锚点无法定位");
  return narrowed[0];
};

const resolvePatchRanges = (source, patch = {}) => {
  switch (patch.type) {
    case "replace_all_exact":
    case "rename": {
      const original = value(patch.original ?? patch.from);
      if (!original) fail("批量精确替换缺少原文");
      const ranges = occurrenceRanges(source, original);
      const expected = Number(patch.expectedOccurrences);
      if (!ranges.length) fail(`批量精确替换原文“${original}”未在磁盘最新版中找到`);
      if (Number.isInteger(expected) && expected >= 0 && ranges.length !== expected) {
        fail(`批量精确替换命中数量已变化：预期 ${expected}，实际 ${ranges.length}`);
      }
      return ranges.map((range, index) => ({
        ...range,
        editId: patch.editId || `replace-${index + 1}`,
        before: original,
        after: value(patch.content ?? patch.to),
      }));
    }
    case "anchored_replace": {
      const range = resolveAnchoredRange(source, patch);
      return [{ ...range, editId: patch.editId || "anchored-replace", before: source.slice(range.start, range.end), after: value(patch.content) }];
    }
    case "range": {
      const start = Number(patch.start);
      const end = Number(patch.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) fail("Range Patch 范围无效");
      const before = source.slice(start, end);
      if (patch.expectedText !== undefined && before !== value(patch.expectedText)) fail("Range Patch 原文已变化");
      return [{ start, end, editId: patch.editId || "range", before, after: value(patch.content) }];
    }
    default:
      return null;
  }
};

export const preflightDocumentPatches = (source, patches = [], { expectedRevision = "" } = {}) => {
  const current = value(source);
  if (expectedRevision && expectedRevision !== contentRevision(current)) fail("Patch 基线已过期", "DOCUMENT_REVISION_CONFLICT");
  const normalized = Array.isArray(patches) ? patches : [];
  const directRanges = [];
  const deferred = [];
  normalized.forEach((patch) => {
    const ranges = resolvePatchRanges(current, patch);
    if (ranges) directRanges.push(...ranges);
    else deferred.push(patch);
  });
  directRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < directRanges.length; index += 1) {
    if (directRanges[index].start < directRanges[index - 1].end) fail("多个局部修改范围互相重叠", "DOCUMENT_PATCH_OVERLAP");
  }
  if (deferred.length && directRanges.length) fail("结构 Patch 与文本范围 Patch 不能在同一原子计划中混用", "DOCUMENT_PATCH_MIXED_MODE");
  return { source: current, ranges: directRanges, deferred, beforeRevision: contentRevision(current) };
};

export const applyDocumentPatchPlan = (source, patches = [], options = {}) => {
  const preflight = preflightDocumentPatches(source, patches, options);
  let content = preflight.source;
  let changeSet = [];
  if (preflight.ranges.length) {
    changeSet = preflight.ranges.map((range) => ({
      editId: range.editId,
      start: range.start,
      end: range.end,
      before: range.before,
      after: range.after,
    }));
    for (const range of [...preflight.ranges].sort((left, right) => right.start - left.start)) {
      content = `${content.slice(0, range.start)}${range.after}${content.slice(range.end)}`;
    }
  } else {
    content = preflight.deferred.reduce((current, patch) => applyDocumentPatch(current, patch), content);
    if (content !== preflight.source) changeSet = [{
      editId: "structured-patch",
      start: 0,
      end: preflight.source.length,
      before: preflight.source,
      after: content,
    }];
  }
  return {
    content,
    changeSet,
    changedCharacterCount: changeSet.reduce((total, change) => total + Math.max(change.before.length, change.after.length), 0),
    beforeRevision: preflight.beforeRevision,
    afterRevision: contentRevision(content),
  };
};

const headingRange = (source, heading) => {
  const lines = source.split("\n");
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, "u");
  const index = lines.findIndex((line) => matcher.test(line));
  if (index < 0) fail(`标题“${heading}”未在磁盘最新版中找到`);
  const level = matcher.exec(lines[index])?.[1].length ?? 6;
  let end = lines.length;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const next = lines[cursor].match(/^(#{1,6})\s+/u);
    if (next && next[1].length <= level) { end = cursor; break; }
  }
  return { lines, index, end };
};

export const applyDocumentPatch = (source, patch = {}) => {
  const current = value(source);
  if (patch.expectedRevision && patch.expectedRevision !== contentRevision(current)) fail("Patch 基线已过期", "DOCUMENT_REVISION_CONFLICT");
  switch (patch.type) {
    case "replace_all_exact":
    case "anchored_replace":
      return applyDocumentPatchPlan(current, [patch]).content;
    case "range": {
      const start = Number(patch.start);
      const end = Number(patch.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > current.length) fail("Range Patch 范围无效");
      if (patch.expectedText !== undefined && current.slice(start, end) !== value(patch.expectedText)) fail("Range Patch 原文已变化");
      return `${current.slice(0, start)}${value(patch.content)}${current.slice(end)}`;
    }
    case "block":
      return replaceUnique(current, value(patch.original), value(patch.content), "Block Patch 锚点");
    case "heading": {
      const { lines, index, end } = headingRange(current, patch.heading);
      const replacement = value(patch.content).split("\n");
      return [...lines.slice(0, index + 1), ...replacement, ...lines.slice(end)].join("\n");
    }
    case "semantic": {
      if (patch.original) return replaceUnique(current, value(patch.original), value(patch.content), "Semantic Patch 原文");
      const before = value(patch.beforeAnchor);
      const after = value(patch.afterAnchor);
      const start = current.indexOf(before);
      const end = start < 0 ? -1 : current.indexOf(after, start + before.length);
      if (start < 0 || end < 0) fail("Semantic Patch 前后锚点无法安全定位");
      return `${current.slice(0, start + before.length)}${value(patch.content)}${current.slice(end)}`;
    }
    case "rename": {
      const before = value(patch.from ?? patch.original);
      const after = value(patch.to ?? patch.content);
      if (!before) fail("Rename Patch 缺少原名称");
      const occurrences = current.split(before).length - 1;
      if (!occurrences) fail(`Rename Patch 原名称“${before}”未在磁盘最新版中找到`);
      if (Number.isInteger(Number(patch.expectedOccurrences)) && Number(patch.expectedOccurrences) >= 0
        && occurrences !== Number(patch.expectedOccurrences)) {
        fail(`Rename Patch 命中数量已变化：预期 ${Number(patch.expectedOccurrences)}，实际 ${occurrences}`);
      }
      return current.split(before).join(after);
    }
    case "append": {
      if (!patch.heading) return `${current}${current.endsWith("\n") || !current ? "" : "\n\n"}${value(patch.content)}`;
      const { lines, end } = headingRange(current, patch.heading);
      lines.splice(end, 0, value(patch.content));
      return lines.join("\n");
    }
    default:
      fail(`不支持的 Document Patch 类型：${patch.type || "unknown"}`, "DOCUMENT_PATCH_UNSUPPORTED");
  }
};

export const applyDocumentPatches = (source, patches = []) => (Array.isArray(patches) ? patches : [])
  .length ? applyDocumentPatchPlan(source, patches).content : value(source);

export const applyDocumentMutation = ({ content = "", title = "", patches = [], requestedTitle = "" } = {}) => ({
  content: applyDocumentPatches(content, patches),
  title: value(requestedTitle).trim() || value(title).trim(),
});
