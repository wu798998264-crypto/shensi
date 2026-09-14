import { randomUUID } from "node:crypto";

import { documentWorkspaceView } from "../document-tree.js";
import { resolveHistoryTaskScope } from "../history-task-scope.js";
import { historyVersionTitle } from "../history-title.js";
import { stampHistoryEntryIntegrity, verifyHistoryEntryIntegrity } from "../version-integrity.js";

const clone = (value) => value == null ? value : structuredClone(value);
const clean = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];

const locatedDocument = (state, documentId) => {
  const document = state.documents?.[documentId];
  const located = Object.entries(state.moduleItems ?? {}).find(([, items]) => list(items).some(([id]) => id === documentId));
  const moduleId = clean(document?.moduleId || located?.[0] || "library");
  const item = list(located?.[1]).find(([id]) => id === documentId) || [];
  const options = item?.[2] || {};
  const viewId = documentWorkspaceView({ moduleId, item, documentState: document || {} });
  return {
    documentId,
    moduleId,
    viewId,
    volumeId: clean(options.customFolderId || (moduleId === "manuscript" ? options.folderId : "")) || null,
    structural: !document,
  };
};

const targetForOperation = (state, operation = {}) => {
  const documentId = clean(operation.targetDocumentId);
  if (state.documents?.[documentId]) return locatedDocument(state, documentId);
  const moduleId = clean(operation.targetDirectoryId) || "library";
  return {
    documentId,
    moduleId,
    viewId: documentWorkspaceView({ moduleId, item: [], documentState: { moduleId } }),
    volumeId: null,
    structural: true,
  };
};

const itemsForScope = (state, scope) => {
  const items = list(state.moduleItems?.[scope.moduleId || scope.id]);
  if (scope.type === "module") return items;
  if (scope.type === "view") return items.filter((item) => documentWorkspaceView({
    moduleId: scope.moduleId,
    item,
    documentState: state.documents?.[item?.[0]] || {},
  }) === scope.viewId);
  if (scope.type === "volume") return items.filter((item) => {
    const options = item?.[2] || {};
    return clean(options.customFolderId || (scope.moduleId === "manuscript" ? options.folderId : "")) === scope.id;
  });
  return [];
};

const projectSnapshotState = (state) => ({
  historyScopeVersion: state.historyScopeVersion,
  mediaWorkspaceVersion: state.mediaWorkspaceVersion,
  structureWorkspaceVersion: state.structureWorkspaceVersion,
  theme: state.theme,
  activeModule: state.activeModule,
  activeDocument: state.activeDocument,
  activeConversationId: state.activeConversationId,
  moduleViews: clone(state.moduleViews || {}),
  moduleItems: clone(state.moduleItems || {}),
  customFolders: clone(state.customFolders || []),
  expandedFolders: clone(state.expandedFolders || []),
  directoryOrders: clone(state.directoryOrders || {}),
  documents: clone(state.documents || {}),
  chapterEpisodeMappings: clone(state.chapterEpisodeMappings || []),
  workspaceAssets: clone(state.workspaceAssets || []),
  assetHistoryTombstones: clone(state.assetHistoryTombstones || []),
});

const snapshotCollection = (state, scope) => {
  if (scope.type === "project") {
    state.projectHistories ||= [];
    return state.projectHistories;
  }
  if (scope.type === "module") {
    state.moduleHistories ||= {};
    state.moduleHistories[scope.id] ||= [];
    return state.moduleHistories[scope.id];
  }
  if (scope.type === "view") {
    state.viewHistories ||= {};
    state.viewHistories[scope.id] ||= [];
    return state.viewHistories[scope.id];
  }
  state.volumeHistories ||= {};
  state.volumeHistories[scope.id] ||= [];
  return state.volumeHistories[scope.id];
};

export const addDocumentHierarchyPrewriteHistory = ({ beforeState, nextState, operations = [], reason = "Agent 正式写入前" } = {}) => {
  if (!beforeState || !nextState) return null;
  const targets = list(operations).map((operation) => targetForOperation(beforeState, operation));
  const scope = resolveHistoryTaskScope(targets);
  if (!scope || scope.type === "document") return scope;
  const collection = snapshotCollection(nextState, scope);
  const now = new Date().toISOString();
  const scopeItems = scope.type === "project" ? [] : itemsForScope(beforeState, scope);
  const documents = scope.type === "project"
    ? clone(beforeState.documents || {})
    : Object.fromEntries(scopeItems.filter(([id]) => beforeState.documents?.[id]).map(([id]) => [id, clone(beforeState.documents[id])]));
  const label = scope.type === "project" ? beforeState.projectName || "作品"
    : scope.type === "module" ? scope.id
      : scope.type === "view" ? scope.viewId || scope.id
        : list(beforeState.customFolders).find((folder) => folder.id === scope.id)?.label || scope.id;
  const entry = stampHistoryEntryIntegrity({
    id: `prewrite-${scope.type}-${randomUUID()}`,
    title: historyVersionTitle({ documents, fallbackLabel: label, reason, operations }),
    version: `${scope.type === "project" ? "作品" : scope.type === "module" ? "模块" : scope.type === "view" ? "分类" : "卷"}快照 ${collection.length + 1}`,
    time: now,
    createdAt: now,
    documents,
    ...(scope.type === "project" ? { state: projectSnapshotState(beforeState) } : {
      moduleItems: { [scope.moduleId || scope.id]: clone(scopeItems) },
      customFolders: clone(list(beforeState.customFolders).filter((folder) => {
        if (scope.type === "module") return folder.moduleId === scope.id;
        if (scope.type === "view") return folder.moduleId === scope.moduleId && folder.viewId === scope.viewId;
        return folder.id === scope.id || folder.parentFolderId === scope.id;
      })),
    }),
    scopeType: scope.type,
    scopeId: scope.id,
    moduleId: scope.moduleId,
    viewId: scope.viewId,
    transactionType: "document_prewrite",
  }, { reason, operations, source: "agent", parentVersionId: collection[0]?.id || "" });
  const integrity = verifyHistoryEntryIntegrity(entry);
  if (!integrity.ok) throw Object.assign(new Error(integrity.reason || "文档层级历史版本校验失败"), { code: integrity.code || "DOCUMENT_HIERARCHY_HISTORY_UNVERIFIED" });
  collection.unshift(entry);
  return { ...scope, versionId: entry.id };
};
