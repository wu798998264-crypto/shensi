const clone = (value) => value == null ? value : structuredClone(value);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const documentPayload = (documentState = {}) => ({
  title: documentState.title ?? "",
  html: documentState.html ?? "",
  markdown: documentState.markdown ?? "",
  continuityDelta: documentState.continuityDelta ?? null,
});

export const historyDocumentFromEntry = (entry = {}, documentId = "", fallbackType = "", fallbackId = "") => {
  const nested = entry.state?.documents?.[documentId] ?? entry.documents?.[documentId];
  if (nested && typeof nested === "object") return clone(nested);
  const scopeType = entry.scopeType || fallbackType;
  const scopeId = entry.scopeId || fallbackId;
  if (scopeType === "document" && (!scopeId || scopeId === documentId)) {
    if (entry.document && typeof entry.document === "object") return clone(entry.document);
    if (Object.hasOwn(entry, "html") || Object.hasOwn(entry, "markdown")) {
      return {
        title: entry.documentTitle ?? entry.title ?? "",
        html: entry.html ?? "",
        markdown: entry.markdown ?? "",
        continuityDelta: clone(entry.continuityDelta ?? null),
      };
    }
  }
  return null;
};

export const historyDocumentContentSignature = (documentState = {}) => JSON.stringify(stableValue(documentPayload(documentState)));

const sourcePriority = (type = "") => ({ document: 0, view: 1, volume: 2, module: 3, project: 4 }[type] ?? 5);
const sourceGroup = (type = "") => ({
  document: "单篇历史",
  view: "分类关联快照",
  volume: "文件夹 / 分卷关联快照",
  module: "板块关联快照",
  project: "作品关联快照",
}[type] ?? "关联历史");

const historyTimestamp = (entry = {}) => {
  const parsed = Date.parse(String(entry.createdAt || entry.timestamp || ""));
  if (Number.isFinite(parsed)) return parsed;
  const embedded = String(entry.id || "").match(/(?:^|[-_])(\d{13})(?:[-_]|$)/u)?.[1];
  return embedded ? Number(embedded) : 0;
};

const displayId = (entry, sourceScope, direct) => direct
  ? String(entry.id)
  : `related-history:${sourceScope.type}:${encodeURIComponent(sourceScope.id || "")}:${encodeURIComponent(String(entry.id || ""))}`;

export const collectRelatedDocumentHistory = ({
  documentId = "",
  directEntries = [],
  viewHistories = {},
  volumeHistories = {},
  moduleHistories = {},
  projectHistories = [],
} = {}) => {
  const collected = [];
  let insertionOrder = 0;
  const add = (entries, fallbackType, fallbackId = "") => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const document = historyDocumentFromEntry(entry, documentId, fallbackType, fallbackId);
      if (!document) continue;
      const sourceScope = {
        type: entry.scopeType || fallbackType,
        id: entry.scopeId || fallbackId || (fallbackType === "project" ? "project" : ""),
        ...(entry.moduleId ? { moduleId: entry.moduleId } : {}),
        ...(entry.viewId ? { viewId: entry.viewId } : {}),
        ...(entry.label ? { label: entry.label } : {}),
      };
      const direct = sourceScope.type === "document" && sourceScope.id === documentId;
      collected.push({
        ...clone(entry),
        id: displayId(entry, sourceScope, direct),
        document,
        html: document.html ?? "",
        markdown: document.markdown ?? "",
        continuityDelta: clone(document.continuityDelta ?? null),
        relatedHistorySourceScope: sourceScope,
        relatedHistorySourceVersionId: String(entry.id || ""),
        relatedDocumentOnly: !direct,
        sourceHistoryReadOnly: entry.sourceHistoryReadOnly === true || !direct,
        sourceHistoryGroup: entry.sourceHistoryGroup || sourceGroup(sourceScope.type),
        relatedHistoryTimestamp: historyTimestamp(entry),
        relatedHistoryInsertionOrder: insertionOrder++,
        relatedHistoryOriginalParentId: String(entry.parentVersionId || ""),
        // A view/module/project change set may describe several documents.
        // Never apply it to one extracted document; rebuild from full snapshots.
        ...(direct ? {} : { changeSet: [], afterContent: undefined }),
      });
    }
  };

  add(directEntries, "document", documentId);
  for (const [scopeId, entries] of Object.entries(viewHistories || {})) add(entries, "view", scopeId);
  for (const [scopeId, entries] of Object.entries(volumeHistories || {})) add(entries, "volume", scopeId);
  for (const [scopeId, entries] of Object.entries(moduleHistories || {})) add(entries, "module", scopeId);
  add(projectHistories, "project", "project");

  collected.sort((left, right) => right.relatedHistoryTimestamp - left.relatedHistoryTimestamp
    || sourcePriority(left.relatedHistorySourceScope?.type) - sourcePriority(right.relatedHistorySourceScope?.type)
    || left.relatedHistoryInsertionOrder - right.relatedHistoryInsertionOrder);

  const unique = [];
  const signatures = new Map();
  for (const entry of collected) {
    const signature = historyDocumentContentSignature(entry.document);
    const existing = signatures.get(signature);
    if (existing) {
      existing.relatedHistoryDuplicateSources ??= [];
      existing.relatedHistoryDuplicateSources.push({
        scope: clone(entry.relatedHistorySourceScope),
        versionId: entry.relatedHistorySourceVersionId,
      });
      continue;
    }
    signatures.set(signature, entry);
    unique.push(entry);
  }

  const byOriginalIdentity = new Map(unique.map((entry) => [
    `${entry.relatedHistorySourceScope?.type}:${entry.relatedHistorySourceScope?.id}:${entry.relatedHistorySourceVersionId}`,
    entry.id,
  ]));
  return unique.map((entry, index) => {
    const source = entry.relatedHistorySourceScope || {};
    const mappedParent = entry.relatedHistoryOriginalParentId
      ? byOriginalIdentity.get(`${source.type}:${source.id}:${entry.relatedHistoryOriginalParentId}`)
      : "";
    const fallbackParent = unique[index + 1]?.id || "";
    return {
      ...entry,
      parentVersionId: mappedParent || fallbackParent,
      relatedHistoryParentRebuilt: !mappedParent && Boolean(fallbackParent),
    };
  });
};

export const prepareRelatedDocumentRestore = ({
  documentId = "",
  displayEntry = null,
  sourceEntries = [],
  directEntries = [],
} = {}) => {
  if (!documentId || !displayEntry?.relatedDocumentOnly) return null;
  const sourceScope = displayEntry.relatedHistorySourceScope;
  const sourceVersionId = String(displayEntry.relatedHistorySourceVersionId || "");
  const sourceVersion = (Array.isArray(sourceEntries) ? sourceEntries : [])
    .find((entry) => String(entry?.id || "") === sourceVersionId);
  if (!sourceScope || !sourceVersion) return null;
  const sourceDocument = historyDocumentFromEntry(sourceVersion, documentId, sourceScope.type, sourceScope.id);
  if (!sourceDocument || historyDocumentContentSignature(sourceDocument) !== historyDocumentContentSignature(displayEntry.document)) return null;
  return {
    sourceVersion: clone(sourceVersion),
    selected: { ...clone(displayEntry), document: sourceDocument, html: sourceDocument.html ?? "", markdown: sourceDocument.markdown ?? "" },
    entries: clone(Array.isArray(directEntries) ? directEntries : []),
  };
};
