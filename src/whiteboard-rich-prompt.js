export const WHITEBOARD_RICH_PROMPT_CARET_GUARD = "\u200B";
export const WHITEBOARD_RICH_PROMPT_MAX_CHARACTERS = 20_000;

export const WHITEBOARD_RICH_PROMPT_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "DT", "DD",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE",
  "TBODY", "THEAD", "TFOOT", "TR", "TD", "TH", "UL",
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const DOCUMENT_FRAGMENT_NODE = 11;

const richPromptChildren = (node) => [...(node?.childNodes || [])];

const richPromptNodeContains = (node, target) => {
  if (!node || !target) return false;
  if (node === target) return true;
  if (typeof node.contains === "function") return node.contains(target);
  return richPromptChildren(node).some((child) => richPromptNodeContains(child, target));
};

const richPromptBlockBoundary = (content) => String(content || "").endsWith("\n")
  ? String(content || "")
  : `${content}\n`;

export const serializeWhiteboardRichPromptNode = (node) => {
  if (!node) return "";
  if (node.nodeType === TEXT_NODE) return String(node.data || "").replaceAll(WHITEBOARD_RICH_PROMPT_CARET_GUARD, "");
  if (![ELEMENT_NODE, DOCUMENT_FRAGMENT_NODE].includes(node.nodeType)) return "";
  if (node.nodeType === ELEMENT_NODE && node.matches?.("[data-rich-mention-token]")) return node.dataset?.richMentionToken || "";
  if (node.nodeType === ELEMENT_NODE && node.tagName === "BR") return "\n";
  const content = richPromptChildren(node).map(serializeWhiteboardRichPromptNode).join("");
  return node.nodeType === ELEMENT_NODE && WHITEBOARD_RICH_PROMPT_BLOCK_TAGS.has(node.tagName)
    ? richPromptBlockBoundary(content)
    : content;
};

// A cloned Range contains the unfinished paragraph that owns the caret. A
// normal full-node serializer appends that paragraph's trailing newline, so a
// visually trailing "@" becomes "@\n" and the mention trigger cannot match.
// Walk to the exact DOM point instead: preceding blocks remain complete, while
// the block containing the caret stays open and contributes no synthetic
// boundary. Real BR/newline content before the caret is still preserved.
export const serializeWhiteboardRichPromptBeforePoint = (root, container, offset) => {
  if (!root || !container || !richPromptNodeContains(root, container)) return "";
  const serializePrefix = (node) => {
    if (node === container) {
      if (node.nodeType === TEXT_NODE) {
        const end = Math.max(0, Math.min(String(node.data || "").length, Number(offset) || 0));
        return String(node.data || "").slice(0, end).replaceAll(WHITEBOARD_RICH_PROMPT_CARET_GUARD, "");
      }
      const children = richPromptChildren(node);
      const end = Math.max(0, Math.min(children.length, Number(offset) || 0));
      return children.slice(0, end).map(serializeWhiteboardRichPromptNode).join("");
    }
    let content = "";
    for (const child of richPromptChildren(node)) {
      if (richPromptNodeContains(child, container)) return content + serializePrefix(child);
      content += serializeWhiteboardRichPromptNode(child);
    }
    return content;
  };
  return serializePrefix(root);
};

export const whiteboardPromptReferenceSequenceAfterInsertion = (
  occurrences = [],
  selectionStart = 0,
  selectionEnd = selectionStart,
  insertedNodeId = "",
) => whiteboardPromptReferenceSequenceAfterReplacement(
  occurrences,
  selectionStart,
  selectionEnd,
  String(insertedNodeId || "").trim() ? [{ id: insertedNodeId, start: 0, end: 0 }] : [],
);

export const whiteboardPromptReferenceSequenceAfterReplacement = (
  occurrences = [],
  selectionStart = 0,
  selectionEnd = selectionStart,
  insertedOccurrences = [],
) => {
  const start = Math.max(0, Math.min(Number(selectionStart) || 0, Number(selectionEnd) || 0));
  const end = Math.max(start, Math.max(Number(selectionStart) || 0, Number(selectionEnd) || 0));
  const normalized = (Array.isArray(occurrences) ? occurrences : [])
    .map((item) => ({
      id: String(item?.id || "").trim(),
      start: Math.max(0, Number(item?.start) || 0),
      end: Math.max(0, Number(item?.end) || 0),
    }))
    .filter((item) => item.id && item.end >= item.start)
    .sort((left, right) => (left.start - right.start) || (left.end - right.end));
  const before = normalized.filter((item) => item.end <= start).map((item) => item.id);
  const after = normalized.filter((item) => item.start >= end).map((item) => item.id);
  const inserted = (Array.isArray(insertedOccurrences) ? insertedOccurrences : [])
    .map((item) => ({
      id: String(item?.id || "").trim(),
      start: Math.max(0, Number(item?.start) || 0),
      end: Math.max(0, Number(item?.end) || 0),
    }))
    .filter((item) => item.id && item.end >= item.start)
    .sort((left, right) => (left.start - right.start) || (left.end - right.end))
    .map((item) => item.id);
  return [...before, ...inserted, ...after];
};

export const whiteboardPromptReferenceIdentityMatches = (expectedIds = [], renderedIds = []) => {
  const expected = (Array.isArray(expectedIds) ? expectedIds : []).map(String).filter(Boolean);
  const rendered = (Array.isArray(renderedIds) ? renderedIds : []).map(String).filter(Boolean);
  return expected.length === rendered.length && expected.every((id, index) => id === rendered[index]);
};

export const whiteboardPromptReferenceReplacementIsSafe = (expected = {}, current = {}) => {
  const occurrenceMatches = ["id", "start", "end", "token"].every((key) => (
    String(expected?.occurrence?.[key] ?? "") === String(current?.occurrence?.[key] ?? "")
  ));
  return String(expected.prompt ?? "") === String(current.prompt ?? "")
    && String(expected.targetNodeId ?? "") === String(current.targetNodeId ?? "")
    && String(expected.documentId ?? "") === String(current.documentId ?? "")
    && String(expected.workspaceId ?? "") === String(current.workspaceId ?? "")
    && Number(expected.occurrenceIndex) === Number(current.occurrenceIndex)
    && occurrenceMatches
    && String(expected.beforeAnchor ?? "") === String(current.beforeAnchor ?? "")
    && String(expected.afterAnchor ?? "") === String(current.afterAnchor ?? "")
    && whiteboardPromptReferenceIdentityMatches(expected.referenceIds, current.referenceIds);
};

export const whiteboardPromptAtomicDropOffset = ({
  start = 0,
  end = start,
  clientX = 0,
  left = 0,
  width = 0,
} = {}) => {
  const normalizedStart = Math.max(0, Number(start) || 0);
  const normalizedEnd = Math.max(normalizedStart, Number(end) || normalizedStart);
  const midpoint = (Number(left) || 0) + Math.max(0, Number(width) || 0) / 2;
  return (Number(clientX) || 0) < midpoint ? normalizedStart : normalizedEnd;
};
