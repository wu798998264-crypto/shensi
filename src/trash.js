export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const validTime = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
};

export const normalizeTrashEntry = (entry = {}, now = Date.now()) => {
  const deletedAtMs = validTime(entry.deletedAtIso) ?? validTime(entry.deletedAt) ?? now;
  const expiresAtMs = validTime(entry.expiresAtIso) ?? deletedAtMs + TRASH_RETENTION_MS;
  const kind = entry.kind === "history-version" || entry.versionEntry
    ? "history-version"
    : entry.kind === "conversation" || entry.conversation
    ? "conversation"
    : entry.kind === "tree" || entry.documents
      ? "tree"
      : "file";
  const id = String(entry.id ?? "deleted-item");
  return {
    ...entry,
    id,
    trashId: String(entry.trashId ?? `trash-${id}-${deletedAtMs}`),
    kind,
    title: entry.title ?? entry.document?.title ?? entry.label ?? id,
    deletedAtIso: new Date(deletedAtMs).toISOString(),
    expiresAtIso: new Date(expiresAtMs).toISOString(),
  };
};

export const pruneTrashEntries = (entries = [], now = Date.now()) => {
  const normalized = entries.map((entry) => normalizeTrashEntry(entry, now));
  return {
    active: normalized.filter((entry) => Date.parse(entry.expiresAtIso) > now),
    expired: normalized.filter((entry) => Date.parse(entry.expiresAtIso) <= now),
  };
};

export const daysUntilTrashExpiry = (entry, now = Date.now()) => Math.max(
  0,
  Math.ceil((Date.parse(normalizeTrashEntry(entry, now).expiresAtIso) - now) / (24 * 60 * 60 * 1000)),
);

export const trashEntryDocumentIds = (entry = {}) => {
  const normalized = normalizeTrashEntry(entry);
  if (["conversation", "history-version"].includes(normalized.kind)) return [];
  if (normalized.kind === "tree") return Object.keys(normalized.documents ?? {});
  return normalized.id ? [normalized.id] : [];
};

export const trashPreviewDocument = (entry = {}, documentId = null) => {
  const normalized = normalizeTrashEntry(entry);
  if (normalized.kind === "file") {
    if (!normalized.document || documentId && documentId !== normalized.id) return null;
    return { id: normalized.id, document: normalized.document };
  }
  if (normalized.kind !== "tree") return null;
  const id = documentId ?? Object.keys(normalized.documents ?? {})[0];
  const document = normalized.documents?.[id];
  return document ? { id, document } : null;
};

const removeDocumentsFromSnapshot = (snapshot, documentIds) => {
  if (!snapshot || typeof snapshot !== "object") return;
  for (const id of documentIds) {
    if (snapshot.documents) delete snapshot.documents[id];
    if (snapshot.documentRefs) delete snapshot.documentRefs[id];
    if (snapshot.histories) delete snapshot.histories[id];
    if (snapshot.currentVersionMeta?.documents) delete snapshot.currentVersionMeta.documents[id];
  }
  if (snapshot.moduleItems) {
    for (const [moduleId, items] of Object.entries(snapshot.moduleItems)) {
      snapshot.moduleItems[moduleId] = (items ?? []).filter(([id]) => !documentIds.has(id));
    }
  }
  for (const collection of [snapshot.viewHistories, snapshot.volumeHistories, snapshot.moduleHistories]) {
    for (const versions of Object.values(collection ?? {})) {
      for (const version of versions) removeDocumentsFromSnapshot(version, documentIds);
    }
  }
};

export const purgeTrashPayloadsFromState = (state, entries) => {
  const documentIds = new Set(entries.flatMap(trashEntryDocumentIds));
  if (!documentIds.size) return state;
  for (const id of documentIds) {
    if (state.histories) delete state.histories[id];
    if (state.currentVersionMeta?.documents) delete state.currentVersionMeta.documents[id];
  }
  for (const versions of Object.values(state.moduleHistories ?? {})) {
    for (const version of versions) removeDocumentsFromSnapshot(version, documentIds);
  }
  for (const versions of Object.values(state.viewHistories ?? {})) {
    for (const version of versions) removeDocumentsFromSnapshot(version, documentIds);
  }
  for (const versions of Object.values(state.volumeHistories ?? {})) {
    for (const version of versions) removeDocumentsFromSnapshot(version, documentIds);
  }
  for (const version of state.projectHistories ?? []) {
    removeDocumentsFromSnapshot(version, documentIds);
    removeDocumentsFromSnapshot(version.state, documentIds);
  }
  for (const snapshot of Object.values(state.snapshots ?? {})) removeDocumentsFromSnapshot(snapshot, documentIds);
  for (const conversation of state.conversations ?? []) {
    for (const snapshot of Object.values(conversation.snapshots ?? {})) removeDocumentsFromSnapshot(snapshot, documentIds);
  }
  for (const branch of state.isolatedBranches ?? []) {
    removeDocumentsFromSnapshot(branch, documentIds);
    removeDocumentsFromSnapshot(branch.snapshot, documentIds);
    removeDocumentsFromSnapshot(branch.state, documentIds);
  }
  return state;
};

export const createFileTrashEntry = ({ id, document, now = Date.now(), ...payload }) => normalizeTrashEntry({
  ...payload,
  id,
  title: document?.title ?? id,
  kind: "file",
  document,
  deletedAtIso: new Date(now).toISOString(),
}, now);

export const createTreeTrashEntry = ({ id, title, documents = {}, moduleItems = {}, structure = [], now = Date.now(), ...payload }) => normalizeTrashEntry({
  ...payload,
  id,
  title,
  kind: "tree",
  documents,
  moduleItems,
  structure,
  deletedAtIso: new Date(now).toISOString(),
}, now);

export const createConversationTrashEntry = ({ conversation, now = Date.now(), ...payload }) => normalizeTrashEntry({
  ...payload,
  id: conversation?.id ?? "deleted-conversation",
  title: conversation?.title || "未命名对话",
  kind: "conversation",
  conversation,
  deletedAtIso: new Date(now).toISOString(),
}, now);

export const createHistoryTrashEntry = ({ scope, versionEntry, scopeTitle, now = Date.now(), ...payload }) => normalizeTrashEntry({
  ...payload,
  id: versionEntry?.id ?? "deleted-history-version",
  title: `${scopeTitle || "历史版本"} · ${versionEntry?.title || versionEntry?.version || "未命名版本"}`,
  kind: "history-version",
  scope,
  versionEntry,
  deletedAtIso: new Date(now).toISOString(),
}, now);
