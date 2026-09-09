import { createHash, randomUUID } from "node:crypto";

import { documentWorkspaceView, ensureDocumentTreeMetadata } from "../document-tree.js";
import { formalDocumentWriteRevisionFromState } from "../document-write-revision.js";
import { historyVersionTitle } from "../history-title.js";
import { WORKSPACE_MODULES } from "../module-registry.js";
import { createFileTrashEntry, createTreeTrashEntry } from "../trash.js";
import { stampHistoryEntryIntegrity, verifyHistoryEntryIntegrity } from "../version-integrity.js";
import { loadWorkspaceState, saveWorkspaceState } from "./workspace.mjs";

const MODULE_IDS = new Set(WORKSPACE_MODULES.map((module) => module.id));
const VIEW_IDS = new Set(["default", "novel", "script", "prompts"]);
const OPERATION_TYPES = new Set([
  "folder.ensure",
  "folder.rename",
  "folder.delete",
  "folder.restore",
  "document.move",
  "document.reorder",
  "document.copy",
  "document.rename",
  "document.delete",
  "document.restore",
]);
const clone = (value) => structuredClone(value);
const clean = (value = "") => String(value ?? "").trim();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const contextDomainForView = (viewId, workspaceKind = "project") => (
  workspaceKind === "notebook" ? "general" : ["script", "prompts"].includes(viewId) ? "script" : "novel"
);

const safeId = (value, label) => {
  const id = clean(value);
  if (!id || id === ".." || id.length > 180 || /[\\/\0\r\n]/u.test(id)) throw new Error(`${label}无效`);
  return id;
};

const safeFolderName = (value) => {
  const name = clean(value);
  if (!name || name.length > 120 || /[\\/*?"<>|\0\r\n]/u.test(name) || /^[.\s]+$/u.test(name)) {
    throw new Error("文件夹名称无效");
  }
  return name;
};

const safeDocumentTitle = (value) => {
  const title = clean(value);
  if (!title || title.length > 240 || /[\0\r\n]/u.test(title)) throw new Error("文档标题无效");
  return title;
};

const nextCopyDocumentId = (state, sourceId, requestedId = "") => {
  if (requestedId) {
    const id = safeId(requestedId, "复制目标文档ID");
    if (state.documents?.[id]) throw new Error("复制目标文档ID已经存在");
    return id;
  }
  const base = `${sourceId}-copy`;
  let suffix = 1;
  let id = base;
  while (state.documents?.[id]) id = `${base}-${suffix++}`;
  return id;
};

const validModuleId = (value) => {
  const moduleId = clean(value);
  if (!MODULE_IDS.has(moduleId)) throw new Error("未知结构板块");
  return moduleId;
};

const validViewId = (value) => {
  const viewId = clean(value) || "novel";
  if (!VIEW_IDS.has(viewId)) throw new Error("未知结构分类");
  return viewId;
};

const itemForDocument = (state, documentId) => {
  for (const [moduleId, items] of Object.entries(state.moduleItems || {})) {
    const index = (items || []).findIndex((item) => item?.[0] === documentId && item?.[2]?.alias !== true);
    if (index >= 0) return { moduleId, items, index, item: items[index] };
  }
  return null;
};

const customFolderById = (state, folderId) => (state.customFolders || []).find((folder) => folder?.id === folderId) || null;

const folderSubtreeIds = (state, folderId) => {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of state.customFolders || []) {
      if (!folder?.id || ids.has(folder.id) || !ids.has(folder.parentLocationId)) continue;
      ids.add(folder.id);
      changed = true;
    }
  }
  return ids;
};

const workspaceFolders = (state) => {
  const records = new Map();
  for (const folder of state.customFolders || []) {
    if (!folder?.id || !folder?.label) continue;
    records.set(String(folder.id), {
      id: String(folder.id),
      label: String(folder.label),
      moduleId: String(folder.moduleId || "library"),
      viewId: String(folder.viewId || "novel"),
      parentFolderId: customFolderById(state, folder.parentLocationId) ? String(folder.parentLocationId) : "",
      custom: true,
    });
  }
  for (const [moduleId, items] of Object.entries(state.moduleItems || {})) {
    for (const item of items || []) {
      const options = item?.[2] || {};
      const folderId = clean(options.customFolderId || options.folderId);
      const label = clean(options.customFolderLabel || options.folderLabel || options.volumeFolder);
      if (!folderId || !label || records.has(folderId)) continue;
      records.set(folderId, {
        id: folderId,
        label,
        moduleId,
        viewId: documentWorkspaceView({ moduleId, item, documentState: state.documents?.[item?.[0]] || {} }),
        parentFolderId: "",
        custom: false,
      });
    }
  }
  return [...records.values()];
};

export const workspaceStructureRevision = (state = {}) => {
  const documents = Object.entries(state.documents || {})
    .filter(([id, document]) => id !== "library-trash" && document?.documentKind !== "whiteboard")
    .map(([id, document]) => {
      const located = itemForDocument(state, id);
      const options = located?.item?.[2] || {};
      return {
        id,
        title: document.title || located?.item?.[1] || id,
        revision: formalDocumentWriteRevisionFromState(state, id),
        moduleId: located?.moduleId || document.moduleId || "library",
        viewId: documentWorkspaceView({ moduleId: located?.moduleId || document.moduleId || "library", item: located?.item, documentState: document }),
        folderId: options.customFolderId || options.folderId || "",
        order: located?.index ?? -1,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const folders = workspaceFolders(state)
    .map(({ custom: _custom, ...folder }) => folder)
    .sort((left, right) => left.id.localeCompare(right.id));
  return digest({ documents, folders, directoryOrders: state.directoryOrders || {} });
};

export const workspaceStructureInventory = (state = {}, { query = "", offset = 0 } = {}) => {
  const needle = clean(query).toLocaleLowerCase();
  const folders = workspaceFolders(state).filter((folder) => !needle || `${folder.id}\n${folder.label}`.toLocaleLowerCase().includes(needle));
  const documents = Object.entries(state.documents || {}).flatMap(([id, document]) => {
    if (id === "library-trash" || document?.documentKind === "whiteboard") return [];
    const located = itemForDocument(state, id);
    const options = located?.item?.[2] || {};
    const title = clean(document.title || located?.item?.[1] || id);
    const folderId = clean(options.customFolderId || options.folderId);
    const folderLabel = clean(options.customFolderLabel || options.folderLabel || options.volumeFolder);
    if (needle && !`${id}\n${title}\n${folderLabel}`.toLocaleLowerCase().includes(needle)) return [];
    const moduleId = located?.moduleId || document.moduleId || "library";
    return [{
      id,
      title,
      moduleId,
      viewId: documentWorkspaceView({ moduleId, item: located?.item, documentState: document }),
      folderId,
      folderLabel,
      revision: formalDocumentWriteRevisionFromState(state, id),
    }];
  });
  const start = Math.max(0, Number(offset) || 0);
  return {
    revision: workspaceStructureRevision(state),
    modules: WORKSPACE_MODULES.map(({ id, label }) => ({ id, label })),
    folders: folders.slice(start, start + 120),
    documents: documents.slice(start, start + 120),
    totals: { folders: folders.length, documents: documents.length },
    nextOffset: start + 120 < Math.max(folders.length, documents.length) ? start + 120 : null,
  };
};

const folderPathFor = (state, folder, visiting = new Set()) => {
  if (!folder || visiting.has(folder.id)) throw new Error("文件夹结构存在循环");
  const parent = customFolderById(state, folder.parentLocationId);
  if (!parent) return folder.label;
  const next = new Set(visiting).add(folder.id);
  return `${folderPathFor(state, parent, next)}/${folder.label}`;
};

const refreshCustomFolderMetadata = (state) => {
  for (const folder of state.customFolders || []) {
    const parent = customFolderById(state, folder.parentLocationId);
    folder.parentLabel = parent?.label || folder.parentLabel || WORKSPACE_MODULES.find((module) => module.id === folder.moduleId)?.label || folder.moduleId;
    folder.folderPath = folderPathFor(state, folder);
  }
  for (const [moduleId, items] of Object.entries(state.moduleItems || {})) {
    for (const item of items || []) {
      const options = item?.[2] || (item[2] = {});
      const folder = customFolderById(state, options.customFolderId);
      if (!folder) continue;
      options.customFolderLabel = folder.label;
      options.customFolderPath = folder.folderPath;
      if (moduleId === "manuscript" && folder.viewId === "novel") {
        Object.assign(options, { folderId: folder.id, folderLabel: folder.label, volumeFolder: folder.label, treeGroup: "volume" });
      }
      const document = state.documents?.[item[0]];
      if (!document) continue;
      document.customFolderName = folder.label;
      document.customFolderPath = folder.folderPath;
      if (moduleId === "manuscript" && folder.viewId === "novel") Object.assign(document, { volumeLabel: folder.label, volumeFolder: folder.label });
    }
  }
};

const folderDescriptor = (state, { folderId = "", folderLabel = "", moduleId = "", viewId = "" } = {}) => {
  const candidates = workspaceFolders(state).filter((folder) => folder.moduleId === moduleId && folder.viewId === viewId);
  if (folderId) return candidates.find((folder) => folder.id === folderId) || null;
  const label = clean(folderLabel).toLocaleLowerCase();
  return label ? candidates.find((folder) => folder.label.toLocaleLowerCase() === label) || null : null;
};

const targetFolderFor = (state, operation, moduleId, viewId) => {
  const requestedFolder = clean(operation.folderId || operation.folderLabel);
  if (!requestedFolder) return null;
  const folder = folderDescriptor(state, {
    folderId: clean(operation.folderId),
    folderLabel: clean(operation.folderLabel),
    moduleId,
    viewId,
  });
  if (!folder) throw new Error("目标文件夹不存在；请先在同一事务中创建或重新检查结构");
  return folder;
};

const folderForOperation = (state, operation = {}) => {
  const requestedId = clean(operation.folderId);
  const requestedLabel = clean(operation.folderLabel || operation.name);
  const moduleId = clean(operation.moduleId);
  const viewId = clean(operation.viewId);
  const candidates = workspaceFolders(state).filter((folder) => (
    (!moduleId || folder.moduleId === moduleId)
    && (!viewId || folder.viewId === viewId)
  ));
  const folder = requestedId
    ? candidates.find((item) => item.id === requestedId)
    : requestedLabel
      ? candidates.find((item) => item.label.toLocaleLowerCase() === requestedLabel.toLocaleLowerCase())
      : null;
  if (!folder) throw new Error("目标文件夹不存在");
  return folder;
};

const ensureFolder = (state, operation) => {
  const moduleId = validModuleId(operation.moduleId);
  const viewId = validViewId(operation.viewId);
  const name = safeFolderName(operation.name || operation.folderLabel);
  const parentFolderId = clean(operation.parentFolderId);
  const parent = parentFolderId ? customFolderById(state, safeId(parentFolderId, "父文件夹ID")) : null;
  if (parentFolderId && (!parent || parent.moduleId !== moduleId || parent.viewId !== viewId)) throw new Error("父文件夹不存在或不在同一结构分类");
  const existing = workspaceFolders(state).find((folder) => folder.moduleId === moduleId && folder.viewId === viewId && folder.label.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (existing) return { type: "folder.ensure", folderId: existing.id, created: false, changed: false };
  const id = `custom-folder:${randomUUID()}`;
  const contextDomain = contextDomainForView(viewId, state.workspaceKind);
  const record = {
    id,
    label: name,
    systemGeneratedLabel: false,
    moduleId,
    viewId,
    parentLocationId: parent?.id || `${moduleId}:${viewId}:root`,
    parentLabel: parent?.label || WORKSPACE_MODULES.find((module) => module.id === moduleId)?.label || moduleId,
    parentOptions: {
      workspaceView: viewId,
      contextDomain,
      ...(moduleId === "manuscript" && viewId === "novel" ? { folderId: id, folderLabel: name, volumeFolder: name, treeGroup: "volume" } : {}),
    },
    folderPath: [parent?.folderPath, name].filter(Boolean).join("/"),
    createdAt: new Date().toISOString(),
  };
  state.customFolders ||= [];
  state.expandedFolders ||= [];
  state.customFolders.push(record);
  if (!state.expandedFolders.includes(id)) state.expandedFolders.push(id);
  return { type: "folder.ensure", folderId: id, created: true, changed: true };
};

const renameFolder = (state, operation) => {
  const folderId = safeId(operation.folderId, "文件夹ID");
  const name = safeFolderName(operation.name || operation.folderLabel);
  const descriptor = workspaceFolders(state).find((folder) => folder.id === folderId);
  if (!descriptor) throw new Error("目标文件夹不存在");
  const duplicate = workspaceFolders(state).find((folder) => folder.id !== folderId
    && folder.moduleId === descriptor.moduleId && folder.viewId === descriptor.viewId
    && folder.label.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) throw new Error("当前结构分类已经存在同名文件夹");
  if (descriptor.label === name) return { type: "folder.rename", folderId, changed: false, affectedDocumentIds: [] };
  const custom = customFolderById(state, folderId);
  if (custom) {
    custom.label = name;
    custom.systemGeneratedLabel = false;
  } else {
    for (const [moduleId, items] of Object.entries(state.moduleItems || {})) {
      for (const item of items || []) {
        const options = item?.[2] || {};
        if (clean(options.folderId) !== folderId || options.customFolderId) continue;
        options.folderLabel = name;
        options.volumeFolder = name;
        const document = state.documents?.[item[0]];
        if (document) Object.assign(document, { volumeLabel: name, volumeFolder: name });
      }
    }
  }
  refreshCustomFolderMetadata(state);
  for (const order of Object.values(state.directoryOrders || {})) {
    // Directory order keys use folder IDs, so a folder rename does not need
    // to rewrite the ordering map; this loop intentionally validates shape.
    if (!Array.isArray(order)) throw new Error("目录顺序数据无效");
  }
  const affectedDocumentIds = Object.values(state.moduleItems || {}).flatMap((items) => (items || [])
    .filter((item) => [item?.[2]?.customFolderId, item?.[2]?.folderId].includes(folderId))
    .map((item) => item[0]));
  return { type: "folder.rename", folderId, changed: true, affectedDocumentIds };
};

const itemFolderId = (moduleId, item) => {
  const options = item?.[2] || {};
  return clean(options.customFolderId || options.folderId);
};

const itemViewId = (state, moduleId, item) => documentWorkspaceView({
  moduleId,
  item,
  documentState: state.documents?.[item?.[0]] || {},
});

const conversationBindingsFor = (state, documentIds) => {
  const ids = new Set(documentIds);
  return Object.fromEntries((state.conversations || []).flatMap((conversation) => {
    const boundDocumentId = ids.has(conversation.boundDocumentId) ? conversation.boundDocumentId : "";
    const referenceDocumentIds = (conversation.references || [])
      .map((reference) => typeof reference === "object" ? reference.documentId || reference.id : reference)
      .map(clean)
      .filter((id) => ids.has(id));
    if (!boundDocumentId && !referenceDocumentIds.length) return [];
    return [[conversation.id, {
      ...(boundDocumentId ? { boundDocumentId } : {}),
      referenceDocumentIds,
    }]];
  }));
};

const structureNodeForFolder = (state, folderId, folderIds, itemsById) => {
  const folder = workspaceFolders(state).find((candidate) => candidate.id === folderId);
  if (!folder) return null;
  const customChildren = [...folderIds]
    .filter((candidateId) => candidateId !== folderId && customFolderById(state, candidateId)?.parentLocationId === folderId)
    .map((candidateId) => structureNodeForFolder(state, candidateId, folderIds, itemsById))
    .filter(Boolean);
  const documents = [...itemsById.values()]
    .filter(({ folderId: itemFolder, documentId }) => itemFolder === folderId && state.documents?.[documentId])
    .map(({ documentId }) => ({ type: "document", id: documentId, label: state.documents[documentId]?.title || documentId }));
  return {
    type: "folder",
    id: folder.id,
    label: folder.label,
    custom: folder.custom === true,
    children: [...customChildren, ...documents],
  };
};

const selectedFolderState = (state, operation = {}) => {
  const folder = folderForOperation(state, operation);
  const custom = customFolderById(state, folder.id);
  const folderIds = custom ? folderSubtreeIds(state, folder.id) : new Set([folder.id]);
  const moduleId = folder.moduleId;
  const viewId = folder.viewId;
  const items = [];
  const itemsById = new Map();
  for (const [candidateModuleId, moduleItems] of Object.entries(state.moduleItems || {})) {
    for (const item of moduleItems || []) {
      if (item?.[2]?.alias === true) continue;
      const documentId = clean(item?.[0]);
      if (!documentId || documentId === "library-trash") continue;
      const candidateFolderId = itemFolderId(candidateModuleId, item);
      if (!folderIds.has(candidateFolderId) || candidateModuleId !== moduleId || itemViewId(state, candidateModuleId, item) !== viewId) continue;
      const document = state.documents?.[documentId];
      if (document) rejectWhiteboard(document, "文件夹中包含白板；请使用白板入口单独管理");
      items.push({ moduleId: candidateModuleId, item: clone(item), documentId, folderId: candidateFolderId });
      itemsById.set(documentId, { documentId, folderId: candidateFolderId });
    }
  }
  const documentIds = [...itemsById.keys()];
  const customFolders = [...folderIds]
    .map((id) => customFolderById(state, id))
    .filter(Boolean)
    .map(clone);
  const parentKeys = new Set([...folderIds, `${moduleId}:${viewId}:root`]);
  const documentTokens = new Set(documentIds.map((id) => `document:${id}`));
  const directoryOrders = {};
  for (const [parent, order] of Object.entries(state.directoryOrders || {})) {
    const filtered = (Array.isArray(order) ? order : []).filter((token) => documentTokens.has(token));
    if (parentKeys.has(parent) || filtered.length) directoryOrders[parent] = filtered;
  }
  const moduleItems = {};
  for (const record of items) (moduleItems[record.moduleId] ||= []).push(record.item);
  const volumeHistories = Object.fromEntries([...folderIds]
    .filter((id) => state.volumeHistories?.[id])
    .map((id) => [id, clone(state.volumeHistories[id])]));
  const volumeFolders = custom
    ? []
    : [{ id: folder.id, label: folder.label, volumeFolder: folder.label }];
  return {
    folder,
    folderIds,
    moduleId,
    viewId,
    documentIds,
    items,
    itemsById,
    moduleItems,
    documents: Object.fromEntries(documentIds.map((id) => [id, clone(state.documents[id])])),
    histories: Object.fromEntries(documentIds.map((id) => [id, clone(state.histories?.[id] || [])])),
    customFolders,
    volumeHistories,
    volumeFolders,
    directoryOrders,
    conversationBindings: conversationBindingsFor(state, documentIds),
    structure: [structureNodeForFolder(state, folder.id, folderIds, itemsById)].filter(Boolean),
  };
};

const removeDocumentFromState = (state, documentId) => {
  delete state.documents?.[documentId];
  delete state.histories?.[documentId];
  if (state.documentConversationBindings) delete state.documentConversationBindings[documentId];
  state.pendingInlineEdits = (state.pendingInlineEdits || []).filter((record) => record?.documentId !== documentId);
  for (const [moduleId, items] of Object.entries(state.moduleItems || {})) {
    state.moduleItems[moduleId] = (items || []).filter((item) => item?.[0] !== documentId);
  }
  for (const [parent, order] of Object.entries(state.directoryOrders || {})) {
    const next = (order || []).filter((token) => token !== `document:${documentId}`);
    if (next.length) state.directoryOrders[parent] = next;
    else delete state.directoryOrders[parent];
  }
  for (const conversation of state.conversations || []) {
    if (conversation.boundDocumentId === documentId) conversation.boundDocumentId = null;
    conversation.references = (conversation.references || []).filter((reference) => (
      clean(typeof reference === "object" ? reference.documentId || reference.id : reference) !== documentId
    ));
    if (conversation.referenceContext?.documents) conversation.referenceContext.documents = conversation.referenceContext.documents.filter((reference) => (
      clean(typeof reference === "object" ? reference.id || reference.documentId : reference) !== documentId
    ));
  }
};

const deleteFolder = (state, operation) => {
  const selection = selectedFolderState(state, operation);
  const { folder, folderIds, documentIds } = selection;
  state.trash ||= [];
  state.trash.unshift(createTreeTrashEntry({
    id: `folder-trash:${randomUUID()}`,
    title: folder.label,
    folderId: folder.id,
    moduleId: selection.moduleId,
    viewId: selection.viewId,
    documents: selection.documents,
    histories: selection.histories,
    moduleItems: selection.moduleItems,
    customFolders: selection.customFolders,
    volumeHistories: selection.volumeHistories,
    volumeFolders: selection.volumeFolders,
    directoryOrders: selection.directoryOrders,
    conversationBindings: selection.conversationBindings,
    structure: selection.structure,
    reason: clean(operation.reason) || "Agent 删除文件夹",
  }));
  documentIds.forEach((documentId) => removeDocumentFromState(state, documentId));
  state.customFolders = (state.customFolders || []).filter((candidate) => !folderIds.has(candidate.id));
  state.expandedFolders = (state.expandedFolders || []).filter((id) => !folderIds.has(id));
  for (const folderId of folderIds) delete state.volumeHistories?.[folderId];
  for (const parent of folderIds) delete state.directoryOrders?.[parent];
  if (documentIds.includes(state.activeDocument)) {
    const nextId = Object.keys(state.documents || {}).find((id) => id !== "library-trash");
    state.activeDocument = nextId || "";
    state.activeModule = nextId ? itemForDocument(state, nextId)?.moduleId || state.documents[nextId]?.moduleId || "library" : "library";
  }
  return {
    type: "folder.delete",
    folderId: folder.id,
    trashId: state.trash[0].trashId,
    title: folder.label,
    changed: true,
    affectedDocumentIds: documentIds,
    affectedFolderIds: [...folderIds],
  };
};

const restoreFolder = (state, operation) => {
  const requestedTrashId = clean(operation.trashId);
  const requestedFolderId = clean(operation.folderId);
  const index = (state.trash || []).findIndex((entry) => (
    entry?.kind === "tree"
    && ((requestedTrashId && String(entry.trashId || "") === requestedTrashId)
      || (!requestedTrashId && requestedFolderId && String(entry.folderId || "") === requestedFolderId))
  ));
  if (index < 0) throw new Error("回收站中没有找到要恢复的文件夹");
  const entry = state.trash[index];
  const documentIds = Object.keys(entry.documents || {});
  const folderRecords = Array.isArray(entry.customFolders) ? entry.customFolders : [];
  if (documentIds.some((id) => state.documents?.[id])) throw new Error("恢复目标中已有同 ID 文档，请先处理冲突");
  if (folderRecords.some((folder) => state.customFolders?.some((current) => (
    current.id === folder.id
      || current.moduleId === folder.moduleId
        && current.viewId === folder.viewId
        && clean(current.label).toLocaleLowerCase() === clean(folder.label).toLocaleLowerCase()
  )))) throw new Error("恢复目标中已有同名或同 ID 文件夹");
  const restoredVolumeFolderIds = new Set((entry.volumeFolders || []).map((folder) => clean(folder?.id)).filter(Boolean));
  if (restoredVolumeFolderIds.size && Object.entries(state.moduleItems || {}).some(([moduleId, items]) => (
    moduleId === "manuscript" && (items || []).some((item) => restoredVolumeFolderIds.has(clean(item?.[2]?.folderId)))
  ))) throw new Error("恢复目标中已有同名或同 ID 分卷");
  state.documents ||= {};
  state.histories ||= {};
  state.moduleItems ||= {};
  state.customFolders ||= [];
  state.directoryOrders ||= {};
  state.volumeHistories ||= {};
  for (const folder of folderRecords) state.customFolders.push(clone(folder));
  for (const [documentId, document] of Object.entries(entry.documents || {})) {
    rejectWhiteboard(document);
    state.documents[documentId] = clone(document);
    state.histories[documentId] = clone(entry.histories?.[documentId] || []);
  }
  for (const [moduleId, items] of Object.entries(entry.moduleItems || {})) {
    state.moduleItems[moduleId] ||= [];
    for (const item of items || []) {
      if (!state.moduleItems[moduleId].some((existing) => existing?.[0] === item?.[0])) state.moduleItems[moduleId].push(clone(item));
    }
  }
  for (const [folderId, versions] of Object.entries(entry.volumeHistories || {})) state.volumeHistories[folderId] = clone(versions);
  for (const [parent, order] of Object.entries(entry.directoryOrders || {})) {
    state.directoryOrders[parent] = [...new Set([...(state.directoryOrders[parent] || []), ...(order || [])])];
  }
  for (const [conversationId, bindings] of Object.entries(entry.conversationBindings || {})) {
    const conversation = (state.conversations || []).find((candidate) => candidate.id === conversationId);
    if (!conversation) continue;
    if (bindings.boundDocumentId && state.documents[bindings.boundDocumentId]) conversation.boundDocumentId = bindings.boundDocumentId;
    for (const documentId of bindings.referenceDocumentIds || []) {
      conversation.references ||= [];
      if (!conversation.references.includes(documentId)) conversation.references.push(documentId);
    }
  }
  state.trash.splice(index, 1);
  if (!state.activeDocument && documentIds[0]) state.activeDocument = documentIds[0];
  if (state.activeDocument) state.activeModule = itemForDocument(state, state.activeDocument)?.moduleId || state.documents[state.activeDocument]?.moduleId || state.activeModule || "library";
  return {
    type: "folder.restore",
    folderId: String(entry.folderId || folderRecords[0]?.id || ""),
    trashId: String(entry.trashId || ""),
    title: String(entry.title || ""),
    changed: true,
    affectedDocumentIds: documentIds,
    affectedFolderIds: folderRecords.map((folder) => folder.id),
  };
};

const clearPlacement = (record) => {
  for (const key of ["folderId", "folderLabel", "volumeFolder", "customFolderId", "customFolderLabel", "customFolderPath", "placement", "treeGroup"]) delete record[key];
};

const uniqueDocumentTitle = (state, preferred) => {
  const base = safeDocumentTitle(preferred);
  const used = new Set(Object.values(state.documents || {}).map((document) => clean(document?.title).toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base} (${suffix})`.toLocaleLowerCase())) suffix += 1;
  return `${base} (${suffix})`;
};

const moduleItemOptionsFor = ({ state, moduleId, viewId, folder, treeGroup = "" } = {}) => {
  const options = {
    workspaceView: viewId,
    contextDomain: contextDomainForView(viewId, state.workspaceKind),
    placementOverride: true,
    ...(clean(treeGroup) ? { treeGroup: clean(treeGroup) } : {}),
  };
  if (folder?.custom) Object.assign(options, {
    customFolderId: folder.id,
    customFolderLabel: folder.label,
    customFolderPath: customFolderById(state, folder.id)?.folderPath || folder.label,
  });
  if (moduleId === "manuscript" && viewId === "novel" && folder) Object.assign(options, {
    folderId: folder.id,
    folderLabel: folder.label,
    volumeFolder: folder.label,
    treeGroup: "volume",
  });
  return options;
};

const rejectWhiteboard = (document, message = "对话 Agent 不修改白板结构") => {
  if (document?.documentKind === "whiteboard" || document?.kind === "canvas") throw new Error(message);
};

const moveDocument = (state, operation) => {
  const documentId = safeId(operation.documentId, "文档ID");
  const document = state.documents?.[documentId];
  const located = itemForDocument(state, documentId);
  if (!document || !located || documentId === "library-trash") throw new Error("目标文档不存在");
  if (document.documentKind === "whiteboard" || document.kind === "canvas") throw new Error("对话 Agent 不修改白板结构");
  const moduleId = validModuleId(operation.moduleId);
  const viewId = validViewId(operation.viewId);
  const folder = targetFolderFor(state, operation, moduleId, viewId);
  const currentOptions = located.item[2] || {};
  const currentViewId = documentWorkspaceView({ moduleId: located.moduleId, item: located.item, documentState: document });
  const currentFolderId = clean(currentOptions.customFolderId || currentOptions.folderId);
  const currentTreeGroup = clean(currentOptions.treeGroup || document.treeGroup);
  if (located.moduleId === moduleId && currentViewId === viewId && currentFolderId === clean(folder?.id)
    && (!clean(operation.treeGroup) || currentTreeGroup === clean(operation.treeGroup))) {
    return { type: "document.move", documentId, changed: false, affectedDocumentIds: [] };
  }
  const [item] = located.items.splice(located.index, 1);
  const options = { ...(item[2] || {}) };
  clearPlacement(options);
  Object.assign(options, {
    workspaceView: viewId,
    contextDomain: contextDomainForView(viewId, state.workspaceKind),
    placementOverride: true,
    ...(clean(operation.treeGroup) ? { treeGroup: clean(operation.treeGroup) } : {}),
  });
  if (folder) {
    if (folder.custom) Object.assign(options, { customFolderId: folder.id, customFolderLabel: folder.label, customFolderPath: customFolderById(state, folder.id)?.folderPath || folder.label });
    if (moduleId === "manuscript" && viewId === "novel") Object.assign(options, { folderId: folder.id, folderLabel: folder.label, volumeFolder: folder.label, treeGroup: "volume" });
  }
  state.moduleItems[moduleId] ||= [];
  state.moduleItems[moduleId].push([documentId, item[1] || document.title || documentId, options]);
  const targetParent = clean(options.customFolderId || (moduleId === "manuscript" ? options.folderId : ""))
    || `${moduleId}:${viewId}:root`;
  state.directoryOrders ||= {};
  for (const [parent, order] of Object.entries(state.directoryOrders)) {
    state.directoryOrders[parent] = (order || []).filter((token) => token !== `document:${documentId}`);
  }
  state.directoryOrders[targetParent] = [...new Set([...(state.directoryOrders[targetParent] || []), `document:${documentId}`])];
  clearPlacement(document);
  Object.assign(document, {
    moduleId,
    workspaceView: viewId,
    contextDomain: contextDomainForView(viewId, state.workspaceKind),
    placementOverride: true,
    ...(options.treeGroup ? { treeGroup: options.treeGroup } : {}),
    ...(folder?.custom ? { customFolderId: folder.id, customFolderName: folder.label, customFolderPath: options.customFolderPath } : {}),
    ...(moduleId === "manuscript" && viewId === "novel" && folder ? { volumeFolder: folder.label, volumeLabel: folder.label } : {}),
    updatedAt: new Date().toISOString(),
  });
  return { type: "document.move", documentId, changed: true, affectedDocumentIds: [documentId] };
};

const copyDocument = (state, operation) => {
  const sourceDocumentId = safeId(operation.documentId, "源文档ID");
  const sourceDocument = state.documents?.[sourceDocumentId];
  const source = itemForDocument(state, sourceDocumentId);
  if (!sourceDocument || !source || sourceDocumentId === "library-trash") throw new Error("源文档不存在");
  rejectWhiteboard(sourceDocument);
  const moduleId = validModuleId(operation.moduleId || source.moduleId);
  const sourceViewId = documentWorkspaceView({ moduleId: source.moduleId, item: source.item, documentState: sourceDocument });
  const viewId = validViewId(operation.viewId || sourceViewId);
  const folder = targetFolderFor(state, operation, moduleId, viewId);
  const targetDocumentId = nextCopyDocumentId(state, sourceDocumentId, operation.targetDocumentId);
  const sourceOptions = source.item?.[2] || {};
  const options = folder || moduleId !== source.moduleId || viewId !== sourceViewId
    ? moduleItemOptionsFor({ state, moduleId, viewId, folder, treeGroup: operation.treeGroup })
    : { ...sourceOptions };
  const title = uniqueDocumentTitle(state, operation.title || `${clean(sourceDocument.title) || sourceDocumentId} 副本`);
  const copiedDocument = clone(sourceDocument);
  clearPlacement(copiedDocument);
  Object.assign(copiedDocument, {
    title,
    moduleId,
    workspaceView: viewId,
    contextDomain: contextDomainForView(viewId, state.workspaceKind),
    placementOverride: true,
    ...(options.treeGroup ? { treeGroup: options.treeGroup } : {}),
    ...(folder?.custom ? { customFolderId: folder.id, customFolderName: folder.label, customFolderPath: options.customFolderPath } : {}),
    ...(moduleId === "manuscript" && viewId === "novel" && folder ? { volumeFolder: folder.label, volumeLabel: folder.label } : {}),
    copiedFromDocumentId: sourceDocumentId,
    updatedAt: new Date().toISOString(),
  });
  state.documents ||= {};
  state.documents[targetDocumentId] = copiedDocument;
  state.histories ||= {};
  // History entries are immutable evidence. Keep their signed payloads intact
  // instead of rewriting source IDs and invalidating their integrity hashes.
  state.histories[targetDocumentId] = clone(state.histories?.[sourceDocumentId] || []);
  state.moduleItems ||= {};
  state.moduleItems[moduleId] ||= [];
  state.moduleItems[moduleId].push([targetDocumentId, title, options]);
  const targetParent = clean(options.customFolderId || (moduleId === "manuscript" ? options.folderId : ""))
    || `${moduleId}:${viewId}:root`;
  state.directoryOrders ||= {};
  state.directoryOrders[targetParent] = [...new Set([...(state.directoryOrders[targetParent] || []), `document:${targetDocumentId}`])];
  return {
    type: "document.copy",
    documentId: sourceDocumentId,
    targetDocumentId,
    title,
    changed: true,
    affectedDocumentIds: [sourceDocumentId, targetDocumentId],
  };
};

const renameDocument = (state, operation) => {
  const documentId = safeId(operation.documentId, "文档ID");
  const document = state.documents?.[documentId];
  const located = itemForDocument(state, documentId);
  if (!document || !located || documentId === "library-trash") throw new Error("目标文档不存在");
  rejectWhiteboard(document);
  const title = safeDocumentTitle(operation.title || operation.name);
  if (clean(document.title) === title && clean(located.item?.[1]) === title) {
    return { type: "document.rename", documentId, title, changed: false, affectedDocumentIds: [] };
  }
  document.title = title;
  document.updatedAt = new Date().toISOString();
  located.item[1] = title;
  return { type: "document.rename", documentId, title, changed: true, affectedDocumentIds: [documentId] };
};

const deleteDocument = (state, operation) => {
  const documentId = safeId(operation.documentId, "文档ID");
  const document = state.documents?.[documentId];
  const located = itemForDocument(state, documentId);
  if (!document || !located || documentId === "library-trash") throw new Error("目标文档不存在");
  rejectWhiteboard(document);
  state.trash ||= [];
  state.trash.unshift(createFileTrashEntry({
    id: documentId,
    document: clone(document),
    history: clone(state.histories?.[documentId] || []),
    item: clone(located.item),
    moduleId: located.moduleId,
    reason: clean(operation.reason) || "Agent 删除",
  }));
  delete state.documents[documentId];
  delete state.histories?.[documentId];
  state.pendingInlineEdits = (state.pendingInlineEdits || []).filter((record) => record?.documentId !== documentId);
  for (const [moduleId, items] of Object.entries(state.moduleItems || {})) {
    state.moduleItems[moduleId] = (items || []).filter((item) => item?.[0] !== documentId);
  }
  for (const [parent, order] of Object.entries(state.directoryOrders || {})) {
    state.directoryOrders[parent] = (order || []).filter((token) => String(token).replace(/^document:/u, "") !== documentId);
  }
  for (const conversation of state.conversations || []) {
    if (conversation.boundDocumentId === documentId) conversation.boundDocumentId = null;
    if (conversation.intentTarget?.documentId === documentId) conversation.intentTarget.documentId = null;
    conversation.references = (conversation.references || []).filter((reference) => String(reference?.documentId || reference) !== documentId);
    if (conversation.referenceContext?.documents) {
      conversation.referenceContext.documents = conversation.referenceContext.documents.filter((reference) => String(reference?.id || reference?.documentId || "") !== documentId);
    }
  }
  if (state.activeDocument === documentId) {
    const nextId = Object.keys(state.documents || {}).find((id) => id !== "library-trash") || "library-trash";
    state.activeDocument = state.documents?.[nextId] ? nextId : null;
    state.activeModule = state.activeDocument ? itemForDocument(state, state.activeDocument)?.moduleId || state.documents[state.activeDocument]?.moduleId || "library" : "library";
  }
  return { type: "document.delete", documentId, trashId: state.trash[0].trashId, changed: true, affectedDocumentIds: [documentId] };
};

const restoreDocument = (state, operation) => {
  const requestedTrashId = clean(operation.trashId);
  const requestedDocumentId = clean(operation.documentId);
  const index = (state.trash || []).findIndex((entry) => (
    (requestedTrashId && String(entry?.trashId || "") === requestedTrashId)
    || (!requestedTrashId && requestedDocumentId && entry?.kind === "file" && String(entry?.id || "") === requestedDocumentId)
  ));
  if (index < 0) throw new Error("回收站中没有找到要恢复的文档");
  const entry = state.trash[index];
  if (entry?.kind !== "file" || !entry.document || !entry.item) throw new Error("当前仅支持恢复单个文档；文件夹或工作区请使用原有恢复入口");
  const documentId = safeId(entry.id, "恢复文档ID");
  if (state.documents?.[documentId]) throw new Error("恢复目标文档ID已经存在，请先处理当前文档");
  rejectWhiteboard(entry.document);
  const sourceModuleId = String(entry.moduleId || entry.document.moduleId || entry.item?.[0] || "library");
  const moduleId = validModuleId(operation.moduleId || sourceModuleId);
  const viewId = validViewId(operation.viewId || entry.document.workspaceView || "novel");
  const originalOptions = entry.item?.[2] || {};
  const originalFolderId = clean(originalOptions.customFolderId || originalOptions.folderId);
  const originalFolder = originalFolderId
    ? folderDescriptor(state, { folderId: originalFolderId, moduleId, viewId })
      || workspaceFolders(state).find((folder) => folder.id === originalFolderId && folder.moduleId === moduleId && folder.viewId === viewId)
    : null;
  const folder = targetFolderFor(state, operation, moduleId, viewId) || originalFolder;
  const item = clone(entry.item);
  const options = { ...(item[2] || {}) };
  clearPlacement(options);
  Object.assign(options, moduleItemOptionsFor({ state, moduleId, viewId, folder, treeGroup: operation.treeGroup || options.treeGroup }));
  const document = clone(entry.document);
  clearPlacement(document);
  Object.assign(document, {
    moduleId,
    workspaceView: viewId,
    contextDomain: contextDomainForView(viewId, state.workspaceKind),
    placementOverride: true,
    updatedAt: new Date().toISOString(),
  });
  if (folder?.custom) Object.assign(document, { customFolderId: folder.id, customFolderName: folder.label, customFolderPath: options.customFolderPath });
  if (moduleId === "manuscript" && viewId === "novel" && folder) Object.assign(document, { volumeFolder: folder.label, volumeLabel: folder.label });
  state.documents ||= {};
  state.documents[documentId] = document;
  state.histories ||= {};
  state.histories[documentId] = clone(entry.history || []);
  state.moduleItems ||= {};
  state.moduleItems[moduleId] ||= [];
  item[0] = documentId;
  item[1] = document.title || item[1] || documentId;
  item[2] = options;
  state.moduleItems[moduleId].push(item);
  const parent = clean(options.customFolderId || (moduleId === "manuscript" ? options.folderId : ""))
    || `${moduleId}:${viewId}:root`;
  state.directoryOrders ||= {};
  state.directoryOrders[parent] = [...new Set([...(state.directoryOrders[parent] || []), `document:${documentId}`])];
  state.activeDocument ||= documentId;
  state.activeModule ||= moduleId;
  state.trash.splice(index, 1);
  return {
    type: "document.restore",
    documentId,
    trashId: String(entry.trashId || ""),
    title: document.title || documentId,
    changed: true,
    affectedDocumentIds: [documentId],
  };
};

const reorderDocument = (state, operation) => {
  const documentId = safeId(operation.documentId, "文档ID");
  const targetId = safeId(operation.beforeDocumentId || operation.afterDocumentId, "排序目标ID");
  if (documentId === targetId) throw new Error("排序目标不能是文档自身");
  const source = itemForDocument(state, documentId);
  const target = itemForDocument(state, targetId);
  if (!source || !target || source.moduleId !== target.moduleId) throw new Error("排序目标必须位于同一板块");
  if (state.documents?.[documentId]?.documentKind === "whiteboard" || state.documents?.[targetId]?.documentKind === "whiteboard") throw new Error("对话 Agent 不修改白板结构");
  const sourceOptions = source.item?.[2] || {};
  const targetOptions = target.item?.[2] || {};
  const sourceParent = clean(operation.parentFolderId)
    || clean(sourceOptions.customFolderId || (source.moduleId === "manuscript" ? sourceOptions.folderId : ""))
    || `${source.moduleId}:${documentWorkspaceView({ moduleId: source.moduleId, item: source.item, documentState: state.documents?.[documentId] || {} })}:root`;
  const targetParent = clean(targetOptions.customFolderId || (target.moduleId === "manuscript" ? targetOptions.folderId : ""))
    || `${target.moduleId}:${documentWorkspaceView({ moduleId: target.moduleId, item: target.item, documentState: state.documents?.[targetId] || {} })}:root`;
  if (sourceParent !== targetParent) throw new Error("排序目标必须位于同一目录");
  const directoryTokens = (state.moduleItems?.[source.moduleId] || [])
    .filter((item) => {
      const options = item?.[2] || {};
      const parent = clean(options.customFolderId || (source.moduleId === "manuscript" ? options.folderId : ""))
        || `${source.moduleId}:${documentWorkspaceView({ moduleId: source.moduleId, item, documentState: state.documents?.[item?.[0]] || {} })}:root`;
      return parent === sourceParent && item?.[0] !== "library-trash" && state.documents?.[item?.[0]]?.documentKind !== "whiteboard";
    })
    .map((item) => `document:${item[0]}`);
  const beforeOrder = Array.isArray(state.directoryOrders?.[sourceParent]) ? [...state.directoryOrders[sourceParent]] : [];
  const siblingTokens = [...new Set([...beforeOrder.filter((token) => directoryTokens.includes(token)), ...directoryTokens])];
  const sourceToken = `document:${documentId}`;
  const targetToken = `document:${targetId}`;
  const movingIndex = siblingTokens.indexOf(sourceToken);
  const targetIndex = siblingTokens.indexOf(targetToken);
  if (movingIndex < 0 || targetIndex < 0) throw new Error("排序目标不在同一目录");
  const next = siblingTokens.filter((token) => token !== sourceToken);
  const nextTargetIndex = next.indexOf(targetToken);
  next.splice(operation.beforeDocumentId ? nextTargetIndex : nextTargetIndex + 1, 0, sourceToken);
  const changed = next.some((token, index) => token !== siblingTokens[index]);
  state.directoryOrders ||= {};
  state.directoryOrders[sourceParent] = next;
  // Keep the legacy module array in sync for nested document lists that do not
  // render through directoryOrders.
  const beforeIds = source.items.map((item) => item?.[0]);
  const [sourceItem] = source.items.splice(source.index, 1);
  const targetIndexInItems = source.items.findIndex((item) => item?.[0] === targetId);
  if (targetIndexInItems >= 0) source.items.splice(operation.beforeDocumentId ? targetIndexInItems : targetIndexInItems + 1, 0, sourceItem);
  const moduleArrayChanged = beforeIds.some((id, index) => source.items[index]?.[0] !== id);
  if (moduleArrayChanged && !changed) state.directoryOrders[sourceParent] = next;
  if (changed && state.documents?.[documentId]) state.documents[documentId].updatedAt = new Date().toISOString();
  return { type: "document.reorder", documentId, changed, affectedDocumentIds: changed ? [documentId] : [] };
};

const projectHistorySnapshot = (state, { reason, operations, transactionId }) => {
  const documents = clone(state.documents || {});
  state.projectHistories ||= [];
  const entry = stampHistoryEntryIntegrity({
    id: `project-${randomUUID()}`,
    title: historyVersionTitle({ documents, fallbackLabel: state.projectName || "作品", reason, operations }),
    version: `作品快照 ${state.projectHistories.length + 1}`,
    time: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    documents,
    state: {
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
      histories: clone(state.histories || {}),
      trash: clone(state.trash || []),
      documents,
      chapterEpisodeMappings: clone(state.chapterEpisodeMappings || []),
      workspaceAssets: clone(state.workspaceAssets || []),
      assetHistoryTombstones: clone(state.assetHistoryTombstones || []),
    },
    scopeType: "project",
    scopeId: "project",
    workspaceKind: state.workspaceKind === "notebook" ? "notebook" : "project",
    workspaceName: state.projectName,
    transactionId,
  }, { reason, operations, source: "agent", parentVersionId: state.projectHistories[0]?.id || "" });
  const integrity = verifyHistoryEntryIntegrity(entry);
  if (!integrity.ok) throw Object.assign(new Error(integrity.reason || "结构操作历史版本校验失败"), { code: integrity.code });
  state.projectHistories.unshift(entry);
  return entry;
};

const applyOperation = (state, operation) => {
  const type = clean(operation?.type);
  if (!OPERATION_TYPES.has(type)) throw new Error("不支持的结构操作");
  if (type === "folder.ensure") return ensureFolder(state, operation);
  if (type === "folder.rename") return renameFolder(state, operation);
  if (type === "folder.delete") return deleteFolder(state, operation);
  if (type === "folder.restore") return restoreFolder(state, operation);
  if (type === "document.move") return moveDocument(state, operation);
  if (type === "document.copy") return copyDocument(state, operation);
  if (type === "document.rename") return renameDocument(state, operation);
  if (type === "document.delete") return deleteDocument(state, operation);
  if (type === "document.restore") return restoreDocument(state, operation);
  return reorderDocument(state, operation);
};

export const executeWorkspaceStructureTransaction = async ({
  appRoot,
  workspacePath,
  expectedRevision = "",
  operationId = "",
  operations = [],
  reason = "Agent 调整工作区结构",
  load = loadWorkspaceState,
  save = saveWorkspaceState,
} = {}) => {
  const transactionId = safeId(operationId, "操作ID");
  const requested = Array.isArray(operations) ? operations : [];
  if (!requested.length || requested.length > 80) throw new Error("结构事务必须包含 1 至 80 项操作");
  const fingerprint = digest(requested);
  const loaded = await load({ appRoot, requestedPath: workspacePath });
  const state = loaded.state;
  const replay = state.documentTransactionLog?.[`structure:${transactionId}`];
  if (replay) {
    if (replay.operationFingerprint !== fingerprint) throw Object.assign(new Error("相同操作ID不可用于不同结构修改"), { code: "WORKSPACE_STRUCTURE_IDEMPOTENCY_CONFLICT" });
    return { ...clone(replay.receipt), idempotentReplay: true };
  }
  const currentRevision = workspaceStructureRevision(state);
  if (!clean(expectedRevision) || clean(expectedRevision) !== currentRevision) {
    throw Object.assign(new Error("工作区结构已变化，请重新检查后再执行"), { code: "WORKSPACE_STRUCTURE_REVISION_CONFLICT", currentRevision });
  }
  const next = clone(state);
  ensureDocumentTreeMetadata(next);
  const history = projectHistorySnapshot(next, { reason: clean(reason).slice(0, 500), operations: requested, transactionId });
  const results = requested.map((operation) => applyOperation(next, operation));
  refreshCustomFolderMetadata(next);
  ensureDocumentTreeMetadata(next);
  const changed = results.filter((result) => result.changed).length;
  const affectedDocumentIds = [...new Set(results.flatMap((result) => result.affectedDocumentIds || []))];
  if (!changed) return { status: "completed", verified: true, changed: 0, results, revision: currentRevision, historyVersionId: "", idempotentReplay: false };
  const nextRevision = workspaceStructureRevision(next);
  const receipt = { status: "completed", verified: true, changed, results, revision: nextRevision, historyVersionId: history.id, idempotentReplay: false };
  next.documentTransactionLog ||= {};
  next.documentTransactionLog[`structure:${transactionId}`] = { operationFingerprint: fingerprint, receipt: clone(receipt), status: "committed", committedAt: new Date().toISOString() };
  await save({ appRoot, requestedPath: workspacePath, state: next, expectedStateStamp: loaded.stateStamp, operationDocumentIds: affectedDocumentIds });
  const verified = await load({ appRoot, requestedPath: workspacePath });
  if (workspaceStructureRevision(verified.state) !== nextRevision) throw new Error("结构事务写入后的回读校验失败");
  return receipt;
};
