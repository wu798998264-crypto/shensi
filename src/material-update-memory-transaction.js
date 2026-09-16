const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

const propertySnapshot = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key)
  ? { exists: true, value: clone(object[key]) }
  : { exists: false, value: null };

const restoreProperty = (object, key, snapshot) => {
  if (!object || !snapshot) return;
  if (snapshot.exists) object[key] = clone(snapshot.value);
  else delete object[key];
};

const SOURCE_MEMORY_FIELDS = Object.freeze([
  "continuityDelta",
  "memorySyncStatus",
  "memorySyncPhase",
  "memorySyncPendingReason",
  "memorySyncedAt",
  "materialUpdateCheckedRevision",
  "materialUpdateCheckedAt",
]);

export const captureMaterialUpdateMemoryRollback = ({
  state,
  sourceDocumentIds = [],
  managedDocumentIds = [],
  viewKeys = [],
  moduleIds = ["memory", "index", "reports"],
} = {}) => {
  const sources = [...new Set(sourceDocumentIds.map(String).filter(Boolean))];
  const managed = [...new Set(managedDocumentIds.map(String).filter(Boolean))];
  const documentIds = [...new Set([...sources, ...managed])];
  return {
    schema: "shensi.material-memory-rollback.v1",
    sourceDocumentIds: sources,
    managedDocumentIds: managed,
    documentIds,
    memoryStore: propertySnapshot(state, "memoryStore"),
    sourceFields: Object.fromEntries(sources.map((documentId) => [
      documentId,
      Object.fromEntries(SOURCE_MEMORY_FIELDS.map((field) => [field, propertySnapshot(state?.documents?.[documentId], field)])),
    ])),
    documents: Object.fromEntries(managed.map((documentId) => [documentId, propertySnapshot(state?.documents, documentId)])),
    histories: Object.fromEntries(managed.map((documentId) => [documentId, propertySnapshot(state?.histories, documentId)])),
    moduleItems: Object.fromEntries(moduleIds.map((moduleId) => [moduleId, propertySnapshot(state?.moduleItems, moduleId)])),
    viewHistories: Object.fromEntries(viewKeys.map((viewKey) => [viewKey, propertySnapshot(state?.viewHistories, viewKey)])),
    currentDocumentMeta: Object.fromEntries(managed.map((documentId) => [
      documentId,
      propertySnapshot(state?.currentVersionMeta?.documents, documentId),
    ])),
    currentViewMeta: Object.fromEntries(viewKeys.map((viewKey) => [
      viewKey,
      propertySnapshot(state?.currentVersionMeta?.views, viewKey),
    ])),
    activityIds: (state?.activities ?? []).map((item) => String(item?.id || "")).filter(Boolean),
  };
};

export const restoreMaterialUpdateMemoryRollback = ({ state, snapshot } = {}) => {
  if (!state || snapshot?.schema !== "shensi.material-memory-rollback.v1") {
    throw new Error("资料同步记忆回滚快照无效");
  }
  state.documents ??= {};
  state.histories ??= {};
  state.moduleItems ??= {};
  state.viewHistories ??= {};
  state.currentVersionMeta ??= {};
  state.currentVersionMeta.documents ??= {};
  state.currentVersionMeta.views ??= {};

  restoreProperty(state, "memoryStore", snapshot.memoryStore);
  for (const [documentId, fields] of Object.entries(snapshot.sourceFields ?? {})) {
    const documentState = state.documents[documentId];
    if (!documentState) continue;
    for (const [field, fieldSnapshot] of Object.entries(fields ?? {})) {
      restoreProperty(documentState, field, fieldSnapshot);
    }
  }
  for (const [documentId, documentSnapshot] of Object.entries(snapshot.documents ?? {})) {
    restoreProperty(state.documents, documentId, documentSnapshot);
  }
  for (const [documentId, historySnapshot] of Object.entries(snapshot.histories ?? {})) {
    restoreProperty(state.histories, documentId, historySnapshot);
  }
  for (const [moduleId, itemsSnapshot] of Object.entries(snapshot.moduleItems ?? {})) {
    restoreProperty(state.moduleItems, moduleId, itemsSnapshot);
  }
  for (const [viewKey, historySnapshot] of Object.entries(snapshot.viewHistories ?? {})) {
    restoreProperty(state.viewHistories, viewKey, historySnapshot);
  }
  for (const [documentId, metadataSnapshot] of Object.entries(snapshot.currentDocumentMeta ?? {})) {
    restoreProperty(state.currentVersionMeta.documents, documentId, metadataSnapshot);
  }
  for (const [viewKey, metadataSnapshot] of Object.entries(snapshot.currentViewMeta ?? {})) {
    restoreProperty(state.currentVersionMeta.views, viewKey, metadataSnapshot);
  }

  const baselineActivityIds = new Set(snapshot.activityIds ?? []);
  const sourceIds = new Set(snapshot.sourceDocumentIds ?? []);
  state.activities = (state.activities ?? []).filter((activity) => {
    if (baselineActivityIds.has(String(activity?.id || ""))) return true;
    return !(sourceIds.has(String(activity?.documentId || "")) && /结构化记忆投影/u.test(String(activity?.label || "")));
  });

  return {
    documentIds: [...new Set(snapshot.documentIds ?? [])],
    restored: true,
  };
};
