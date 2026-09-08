import { contentRevision } from "./workspace-operations.js";

const clean = (value = "") => String(value ?? "").trim();

const visibleVersionText = (value = "") => String(value ?? "")
  .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/giu, " ")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const PLACEHOLDER_CONTENT = /^(?:在右侧对话中确定创作意图后开始填写|等待AI写入|等待生成|尚未生成|暂无内容|空白文档|无意义文字|乱码)[。.!！]?$/u;
const GIBBERISH_CONTENT = /^(?:[�\u0000-\u001f]+|(?:asdf|qwer|zxcv|test|xxx|null|undefined|n\/a)(?:[-_\s\d]*)|(?:测试|乱码|无意义)(?:文字|内容)?)[。.!！]?$/iu;

// Keep this deliberately conservative. A short legitimate note may contain
// punctuation or a single word, so only obvious placeholders, replacement
// characters, control text, and repeated filler are classified as meaningless.
export const documentContentState = (value = "", { title = "", placeholder = "" } = {}) => {
  const visible = visibleVersionText(value);
  if (!visible) return "empty";
  const normalizedTitle = clean(title).replace(/\s+/gu, " ");
  const normalizedPlaceholder = clean(placeholder).replace(/\s+/gu, " ");
  if (PLACEHOLDER_CONTENT.test(visible)
    || GIBBERISH_CONTENT.test(visible)
    || (normalizedTitle && visible === normalizedTitle)
    || (normalizedPlaceholder && visible === normalizedPlaceholder)) return "meaningless";
  const compact = visible.replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!compact) return "meaningless";
  if (/�/u.test(visible) || /^(.)\1{7,}$/u.test(compact)) return "meaningless";
  return "substantive";
};

export const hasSubstantiveVersionContent = (value = "", { title = "", placeholder = "" } = {}) => {
  return documentContentState(value, { title, placeholder }) === "substantive";
};

export const createResourceVersion = ({
  versionId,
  resourceId,
  resourceType = "document",
  parentVersionId = "",
  source = "user",
  operation = "replace",
  content = "",
  attachmentRefs = [],
  transactionId = "",
  beforeRevision = "",
  afterRevision = "",
  changeSet = [],
  changedCharacterCount = 0,
  createdAt = new Date().toISOString(),
  versionKind = "document_content",
  title = "",
  structure = null,
} = {}) => ({
  versionId: clean(versionId) || `version-${Date.now().toString(36)}`,
  resourceId: clean(resourceId),
  resourceType: clean(resourceType) || "document",
  versionKind: clean(versionKind) || "document_content",
  title: clean(title),
  ...(structure && typeof structure === "object" ? { structure: structuredClone(structure) } : {}),
  ...(clean(parentVersionId) ? { parentVersionId: clean(parentVersionId) } : {}),
  source: ["user", "chat", "agent", "restore", "import"].includes(source) ? source : "user",
  operation: clean(operation) || "replace",
  contentHash: contentRevision(String(content ?? "")),
  content: String(content ?? ""),
  attachmentRefs: [...new Set((Array.isArray(attachmentRefs) ? attachmentRefs : []).map(clean).filter(Boolean))],
  transactionId: clean(transactionId),
  beforeRevision: clean(beforeRevision) || contentRevision(String(content ?? "")),
  afterRevision: clean(afterRevision),
  changeSet: (Array.isArray(changeSet) ? changeSet : []).map((change) => ({
    editId: clean(change?.editId),
    start: Number(change?.start),
    end: Number(change?.end),
    before: String(change?.before ?? ""),
    after: String(change?.after ?? ""),
  })).filter((change) => Number.isInteger(change.start) && Number.isInteger(change.end)),
  changedCharacterCount: Number.isFinite(Number(changedCharacterCount)) ? Number(changedCharacterCount) : 0,
  createdAt,
});

export const createBlankDocumentBaseline = ({
  resourceId = "",
  transactionId = "",
  title = "",
  structure = {},
  revision = "",
  createdAt = new Date().toISOString(),
} = {}) => ({
  versionKind: "blank_document_baseline",
  resourceId: clean(resourceId),
  transactionId: clean(transactionId),
  title: clean(title),
  structure: structuredClone(structure ?? {}),
  revision: clean(revision),
  createdAt,
});

export const appendResourceVersion = (store = [], input = {}) => {
  const version = createResourceVersion(input);
  return [version, ...(Array.isArray(store) ? store : []).filter((entry) => entry?.versionId !== version.versionId)];
};
