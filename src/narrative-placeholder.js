const NARRATIVE_DOCUMENT_PATTERN = /^(?:chapter|script-episode)-/u;

const LEGACY_NARRATIVE_PLACEHOLDERS = Object.freeze([
  "在右侧对话中确定这一章节的具体内容。",
  "在右侧对话中确定这一章的具体内容。",
  "请在右侧对话中确定这一章节的具体内容。",
  "请在右侧对话中确定这一章的具体内容。",
  "在右侧对话中确定这一文档的具体内容。",
  "请在右侧对话中确定这一文档的具体内容。",
  "在右侧对话中确定这一集的具体内容。",
  "请在右侧对话中确定这一集的具体内容。",
  "在右侧对话中确定创作意图后开始填写。",
  "本章正文尚未展开，可在右侧对话中继续确定章节意图。",
  "Define this chapter's content in the chat panel.",
  "Define this chapter's intent in the chat panel before drafting.",
  "Define this document's purpose in the chat panel before filling it in.",
  "Define this episode's content in the chat panel.",
]);

const decodeBasicEntities = (value) => String(value ?? "")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&lt;/giu, "<")
  .replace(/&gt;/giu, ">")
  .replace(/&quot;/giu, '"')
  .replace(/&#39;|&apos;/giu, "'");

const readableBody = (value) => decodeBasicEntities(value)
  .replace(/^\uFEFF?---[\s\S]*?---\s*/u, "")
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/^\s*#{1,6}\s+/gmu, "")
  .replace(/^\s*(?:>|[-*+]\s+|\d+[.)、]\s+)/gmu, "")
  .replace(/\r\n?/gu, "\n")
  .replace(/[ \t]+\n/gu, "\n")
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

const signature = (value) => readableBody(value)
  .replace(/[\s\p{P}\p{S}]+/gu, "")
  .toLowerCase();

const withoutFirstContentLine = (value) => {
  const lines = readableBody(value).split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first >= 0) lines.splice(first, 1);
  return lines.join("\n").trim();
};

const PLACEHOLDER_SIGNATURES = new Set(LEGACY_NARRATIVE_PLACEHOLDERS.map(signature));

export const isNarrativeUnitDocumentId = (documentId = "") => NARRATIVE_DOCUMENT_PATTERN.test(String(documentId));

export const narrativeEmptyPlaceholder = ({ documentId = "", language = "zh-CN" } = {}) => {
  if (!String(documentId).trim()) return "";
  const english = String(language).toLowerCase().startsWith("en");
  return english
    ? "Define the creative intent in the chat panel before writing."
    : "在右侧对话中确定创作意图后开始填写。";
};

export const isLegacyNarrativePlaceholderText = (value = "") => {
  const variants = [value, withoutFirstContentLine(value)].map(signature).filter(Boolean);
  return variants.some((item) => PLACEHOLDER_SIGNATURES.has(item));
};

const bodyValues = (documentState = {}) => [documentState.html, documentState.markdown]
  .filter((value) => typeof value === "string" && readableBody(value));

const semanticContinuityValues = (delta = {}) => {
  if (!delta || typeof delta !== "object") return [];
  const readPlan = delta.nextReadPlan && typeof delta.nextReadPlan === "object" ? delta.nextReadPlan : {};
  const arrayValues = [
    delta.nextCarryover,
    delta.nextContext,
    delta.stateChanges,
    delta.foreshadowing,
    delta.firstAppearances,
    delta.informationRelease,
    delta.readerKnowledge,
    delta.pendingCanon,
    readPlan.rules,
    readPlan.instructions,
    readPlan.requiredDocumentIds,
    readPlan.conditionalDocumentIds,
    readPlan.strongStoryReasons,
  ].flatMap((value) => Array.isArray(value) ? value : []);
  const entryValue = (value) => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    return [value.name, value.claim, value.quote, value.summary, value.instruction].filter((item) => typeof item === "string");
  };
  return [
    delta.summary,
    delta.chapterSummary,
    readPlan.targetDocumentId,
    readPlan.strongStoryMode === true ? "strong-story-mode" : "",
    ...arrayValues,
    ...(Array.isArray(delta.evidence) ? delta.evidence : []),
  ]
    .flatMap(entryValue)
    .map((value) => String(value).trim())
    .filter(Boolean);
};

export const legacyNarrativePlaceholderState = (documentId = "", documentState = {}) => {
  if (!String(documentId).trim() || !documentState || typeof documentState !== "object") {
    return { body: false, continuity: false };
  }
  const bodies = bodyValues(documentState);
  const continuityValues = semanticContinuityValues(documentState.continuityDelta);
  return {
    body: bodies.length > 0 && bodies.every(isLegacyNarrativePlaceholderText),
    continuity: continuityValues.length > 0 && continuityValues.every(isLegacyNarrativePlaceholderText),
  };
};

export const clearLegacyNarrativePlaceholderDocument = (documentId = "", documentState = {}) => {
  const placeholder = legacyNarrativePlaceholderState(documentId, documentState);
  if (!placeholder.body && !placeholder.continuity) return { changed: false, ...placeholder };
  if (placeholder.body) {
    if (typeof documentState.html === "string") documentState.html = "";
    if (typeof documentState.markdown === "string") documentState.markdown = "";
  }
  if (placeholder.continuity) {
    delete documentState.continuityDelta;
    delete documentState.memorySyncStatus;
    delete documentState.memorySyncedAt;
    delete documentState.memoryStaleAt;
  }
  return { changed: true, ...placeholder };
};
