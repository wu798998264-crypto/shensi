import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { MODULE_VIEWS } from "../data.js";
import { buildDocumentTree, documentLocationChoices, ensureDocumentTreeMetadata } from "../document-tree.js";
import { freeDocumentTitle, sequencedDocumentKind, sequencedDocumentLabel } from "../document-title-policy.js";
import {
  copyReferencedAttachments,
  isTemporaryNotebookPath,
  loadTemporaryNotebookState,
  removeTemporaryNotebookDocuments,
} from "./external-markdown.mjs";
import { loadWorkspaceState, resolveWorkspaceRoot, saveWorkspaceState } from "./workspace.mjs";

const MAX_TRANSFER_DOCUMENTS = 500;
const PROJECT_TARGET_MODULES = new Set(["manuscript", "outline", "canon", "memory", "reports", "library", "index"]);
const READONLY_COCKPIT_IDS = new Set([
  "report-compile",
  "report-novel",
  "report-script",
  "report-adaptation",
  "index-pending",
  "index-update-log",
]);

const normalizedPath = (value) => {
  if (isTemporaryNotebookPath(value)) return "shensi://temporary-notebook";
  const normalized = resolve(String(value || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isInside = (candidate, parent) => {
  const result = relative(parent, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
};

const locateDocument = (workspaceState, documentId) => {
  const matches = [];
  for (const [moduleId, items] of Object.entries(workspaceState.moduleItems || {})) {
    for (const item of items || []) if (item?.[0] === documentId) matches.push({ moduleId, item });
  }
  return matches.find(({ item }) => !item?.[2]?.alias) || matches[0] || null;
};

const transferBlocked = ({ workspaceState, documentId, documentState, located }) => {
  if (!documentState || !located || documentId === "library-trash" || documentState.virtual || located.item?.[2]?.alias) return "系统占位或同源引用不能转移";
  if (documentState.externalMissing) return "原始 Markdown 文件当前不可读取";
  if (workspaceState.workspaceKind !== "project") return "";
  const cockpitReadonly = documentId !== "index-language-blacklist"
    && (documentState.derived === true || located.moduleId === "reports" || READONLY_COCKPIT_IDS.has(documentId));
  return cockpitReadonly ? "索引中的只读文档不能移动、复制或剪切" : "";
};

const uniqueDocumentTitle = (workspaceState, preferred) => {
  const used = new Set(Object.values(workspaceState.documents || {}).map((document) => String(document?.title || "").trim().toLowerCase()));
  const base = String(preferred || "未命名文档").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "未命名文档";
  if (!used.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base} (${suffix})`.toLowerCase())) suffix += 1;
  return `${base} (${suffix})`;
};

const nextSequenceId = (workspaceState, pattern, prefix) => {
  const numbers = Object.keys(workspaceState.documents || {}).map((id) => Number(id.match(pattern)?.[1] || 0));
  let number = Math.max(0, ...numbers) + 1;
  while (workspaceState.documents?.[`${prefix}${number}`]) number += 1;
  return `${prefix}${number}`;
};

const nextTransferredDocumentId = ({ workspaceState, moduleId, viewId, documentKind }) => {
  if (documentKind === "whiteboard") return `whiteboard-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (workspaceState.workspaceKind === "notebook") return `note-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (moduleId === "manuscript" && viewId === "novel") return nextSequenceId(workspaceState, /^chapter-(\d+)$/, "chapter-");
  if (moduleId === "manuscript" && viewId === "script") return nextSequenceId(workspaceState, /^script-episode-(\d+)$/, "script-episode-");
  const safeModule = String(moduleId || "document").replace(/[^a-z\d-]+/gi, "-");
  const safeView = String(viewId || "default").replace(/[^a-z\d-]+/gi, "-");
  let id = `${safeModule}-${safeView}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  while (workspaceState.documents?.[id]) id = `${safeModule}-${safeView}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return id;
};

const targetSequenceKind = (moduleId, viewId) => moduleId === "manuscript"
  ? viewId === "novel" ? "chapter" : viewId === "script" ? "episode" : ""
  : "";

const preserveMovedDocumentId = ({ documentId, moduleId, viewId }) => {
  const sourceKind = sequencedDocumentKind(documentId);
  const targetKind = targetSequenceKind(moduleId, viewId);
  return sourceKind === targetKind;
};

const rewriteAttachmentReferences = (value, replacements, seen = new Map()) => {
  if (typeof value === "string") {
    let next = value;
    for (const [source, target] of replacements) next = next.split(source).join(target);
    return next;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const next = Array.isArray(value) ? [] : {};
  seen.set(value, next);
  if (Array.isArray(value)) value.forEach((entry) => next.push(rewriteAttachmentReferences(entry, replacements, seen)));
  else for (const [key, entry] of Object.entries(value)) next[key] = rewriteAttachmentReferences(entry, replacements, seen);
  return next;
};

const clearPlacementMetadata = (documentState) => {
  for (const key of [
    "sourcePath", "sourceImportPath", "contentRef", "volumeFolder", "volumeLabel", "treeGroup",
    "customFolderId", "customFolderName", "customFolderPath", "rootPlacement",
    "externalMarkdown", "externalMissing", "externalSourcePath", "externalSize", "externalModifiedAt",
    "readOnly", "derived", "virtual",
  ]) delete documentState[key];
  return documentState;
};

const targetDocumentState = ({ sourceDocument, targetDocumentId, targetState, moduleId, viewId, location, replacements, resolvedTitle = "", preserveUpdatedAt = false }) => {
  const documentState = clearPlacementMetadata(rewriteAttachmentReferences(sourceDocument, replacements));
  const sourceUpdatedAt = documentState.updatedAt;
  const language = documentState.titleLanguage || targetState.structureLanguage || "zh-CN";
  const preferredTitle = sequencedDocumentKind(targetDocumentId)
    ? freeDocumentTitle({ documentId: targetDocumentId, title: documentState.title, language })
    : documentState.title;
  documentState.title = resolvedTitle || uniqueDocumentTitle(targetState, preferredTitle);
  documentState.moduleId = moduleId;
  documentState.workspaceView = viewId;
  documentState.contextDomain = targetState.workspaceKind === "notebook"
    ? "general"
    : location.options?.contextDomain ?? (["script", "prompts"].includes(viewId) ? "script" : "novel");
  documentState.placementOverride = true;
  documentState.updatedAt = preserveUpdatedAt && sourceUpdatedAt ? sourceUpdatedAt : new Date().toISOString();
  if (targetState.workspaceKind === "notebook" && documentState.documentKind !== "whiteboard") documentState.documentKind = "note";
  if (targetState.workspaceKind === "project" && documentState.documentKind === "note") delete documentState.documentKind;
  if (location.options?.treeGroup) documentState.treeGroup = location.options.treeGroup;
  if (location.options?.customFolderId) {
    documentState.customFolderId = location.options.customFolderId;
    documentState.customFolderName = location.options.customFolderLabel;
    documentState.customFolderPath = location.options.customFolderPath || location.options.customFolderLabel;
  }
  if (location.options?.volumeFolder) {
    documentState.volumeFolder = location.options.volumeFolder;
    documentState.volumeLabel = location.options.folderLabel;
  }
  if (location.options?.rootPlacement === true) documentState.rootPlacement = true;
  return documentState;
};

const targetItem = ({ documentId, documentState, targetState, moduleId, viewId, location }) => {
  const language = documentState.titleLanguage || targetState.structureLanguage || "zh-CN";
  const label = targetSequenceKind(moduleId, viewId)
    ? sequencedDocumentLabel({ documentId, title: documentState.title, language })
    : documentState.title;
  return [documentId, label, {
    ...(location.options || {}),
    workspaceView: viewId,
    contextDomain: documentState.contextDomain,
    placementOverride: true,
    placement: location.id,
  }];
};

const removeDocumentsFromState = (workspaceState, documentIds, replacements = new Map()) => {
  const removed = new Set(documentIds);
  for (const documentId of removed) {
    delete workspaceState.documents?.[documentId];
    delete workspaceState.histories?.[documentId];
  }
  workspaceState.pendingInlineEdits = (workspaceState.pendingInlineEdits || []).flatMap((record) => {
    if (!removed.has(record.documentId)) return [record];
    const replacement = replacements.get(record.documentId);
    return replacement ? [{ ...record, documentId: replacement }] : [];
  });
  for (const moduleId of Object.keys(workspaceState.moduleItems || {})) {
    workspaceState.moduleItems[moduleId] = (workspaceState.moduleItems[moduleId] || []).filter(([id]) => !removed.has(id));
  }
  for (const conversation of workspaceState.conversations || []) {
    if (removed.has(conversation.boundDocumentId)) conversation.boundDocumentId = replacements.get(conversation.boundDocumentId) || null;
    if (removed.has(conversation.intentTarget?.documentId)) conversation.intentTarget.documentId = replacements.get(conversation.intentTarget.documentId) || null;
    conversation.references = (conversation.references || []).flatMap((reference) => {
      const documentId = typeof reference === "string" ? reference : reference?.documentId;
      if (!removed.has(documentId)) return [reference];
      const replacement = replacements.get(documentId);
      if (!replacement) return [];
      return [typeof reference === "string" ? replacement : { ...reference, documentId: replacement }];
    });
    if (conversation.referenceContext?.documents) conversation.referenceContext.documents = conversation.referenceContext.documents.flatMap((reference) => {
      const documentId = reference?.id || reference?.documentId;
      if (!removed.has(documentId)) return [reference];
      const replacement = replacements.get(documentId);
      if (!replacement) return [];
      return [{ ...reference, ...(reference.id ? { id: replacement } : {}), ...(reference.documentId ? { documentId: replacement } : {}) }];
    });
  }
  for (const [key, order] of Object.entries(workspaceState.directoryOrders || {})) {
    workspaceState.directoryOrders[key] = order.filter((token) => !removed.has(String(token).replace(/^document:/, "")));
  }
  if (removed.has(workspaceState.activeDocument)) {
    const replacement = replacements.get(workspaceState.activeDocument);
    const next = replacement || Object.keys(workspaceState.documents || {}).find((id) => id !== "library-trash") || "library-trash";
    workspaceState.activeDocument = replacement || (workspaceState.documents?.[next] ? next : null);
    const located = workspaceState.activeDocument ? locateDocument(workspaceState, workspaceState.activeDocument) : null;
    if (located) workspaceState.activeModule = located.moduleId;
  }
  return workspaceState;
};

const transferLocation = ({ targetState, moduleId, viewId, locationId }) => {
  const allowedModules = targetState.workspaceKind === "notebook" ? new Set(["library"]) : PROJECT_TARGET_MODULES;
  if (!allowedModules.has(moduleId)) throw new Error("目标板块不可编辑或不支持接收文档");
  const validViews = MODULE_VIEWS[moduleId]?.map((view) => view.id) || ["default"];
  if (!validViews.includes(viewId)) throw new Error("目标目录类型无效");
  const choices = documentLocationChoices({
    moduleId,
    viewId,
    items: targetState.moduleItems?.[moduleId] || [],
    documents: targetState.documents || {},
    folders: targetState.customFolders || [],
    workspaceKind: targetState.workspaceKind,
  });
  const location = choices.find((choice) => choice.id === locationId);
  if (!location) throw new Error("目标目录已经变化，请重新选择");
  return location;
};

const cleanupCopiedAttachments = async (targetWorkspacePath, copied) => {
  const root = resolve(targetWorkspacePath);
  for (const attachment of copied) {
    const target = resolve(root, String(attachment.relativePath || ""));
    if (isInside(target, root)) await rm(target, { force: true }).catch(() => {});
  }
};

const sourcePayloadForAttachments = (documentState, histories) => ({
  ...documentState,
  markdown: [documentState.markdown, ...(histories || []).map((entry) => entry?.document?.markdown)].filter(Boolean).join("\n"),
  html: [documentState.html, ...(histories || []).map((entry) => entry?.document?.html)].filter(Boolean).join("\n"),
  transferHistory: histories || [],
});

const appendActivity = (workspaceState, activity) => {
  workspaceState.activities = [{ id: `activity-${randomUUID()}`, createdAt: new Date().toISOString(), ...activity }, ...(workspaceState.activities || [])];
};

const workspaceName = (workspaceState, workspacePath) => workspaceState.projectName || basename(workspacePath);

const findFolderNode = (nodes, folderId) => {
  for (const node of nodes || []) {
    if (node?.type !== "folder") continue;
    if (node.id === folderId || node.locationId === folderId) return node;
    const nested = findFolderNode(node.children, folderId);
    if (nested) return nested;
  }
  return null;
};

const folderTransferSelection = (workspaceState, sourceFolder) => {
  if (!sourceFolder?.id || !sourceFolder.moduleId || !sourceFolder.viewId) throw new Error("缺少源文件夹位置");
  const tree = buildDocumentTree({
    moduleId: sourceFolder.moduleId,
    viewId: sourceFolder.viewId,
    items: workspaceState.moduleItems?.[sourceFolder.moduleId] || [],
    documents: workspaceState.documents || {},
    folders: workspaceState.customFolders || [],
    workspaceKind: workspaceState.workspaceKind,
  });
  const root = findFolderNode(tree, sourceFolder.id);
  if (!root) throw new Error("源文件夹已经变化，请重新选择");
  const folders = [];
  const documentIds = [];
  const documentFolderIds = new Map();
  const visit = (node, parentId = "") => {
    if (node.type === "document") {
      if (node.id) {
        documentIds.push(node.id);
        documentFolderIds.set(node.id, parentId);
      }
      return;
    }
    if (node.type !== "folder") return;
    folders.push({ id: node.id, label: node.label || "未命名文件夹", parentId, custom: node.custom === true });
    for (const child of node.children || []) visit(child, node.id);
  };
  visit(root);
  return {
    root,
    folders,
    documentIds: [...new Set(documentIds)],
    documentFolderIds,
    customFolderIds: new Set(folders.filter((folder) => folder.custom).map((folder) => folder.id)),
  };
};

const uniqueFolderLabel = (workspaceState, parentLocationId, preferred) => {
  const base = String(preferred || "未命名文件夹").trim() || "未命名文件夹";
  const used = new Set((workspaceState.customFolders || [])
    .filter((folder) => folder.parentLocationId === parentLocationId)
    .map((folder) => String(folder.label || "").toLocaleLowerCase("zh-CN")));
  if (!used.has(base.toLocaleLowerCase("zh-CN"))) return base;
  let suffix = 2;
  while (used.has(`${base} (${suffix})`.toLocaleLowerCase("zh-CN"))) suffix += 1;
  return `${base} (${suffix})`;
};

const materializeTransferredFolders = ({ targetState, selection, targetLocation, moduleId, viewId }) => {
  targetState.customFolders ??= [];
  targetState.volumeHistories ??= {};
  const records = new Map();
  const locations = new Map();
  for (const folder of selection.folders) {
    const parentRecord = records.get(folder.parentId);
    const parentLocationId = parentRecord?.id || targetLocation.id;
    const parentPath = parentRecord?.folderPath || targetLocation.options?.customFolderPath || "";
    const label = uniqueFolderLabel(targetState, parentLocationId, folder.label);
    const id = `custom-folder-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const record = {
      id,
      label,
      moduleId,
      viewId,
      parentLocationId,
      parentLabel: parentRecord?.label || targetLocation.label,
      parentOptions: parentRecord ? {
        ...(parentRecord.parentOptions || {}),
        customFolderId: parentRecord.id,
        customFolderLabel: parentRecord.label,
        customFolderPath: parentRecord.folderPath,
      } : { ...(targetLocation.options || {}) },
      folderPath: [parentPath, label].filter(Boolean).join("/"),
      createdAt: new Date().toISOString(),
    };
    targetState.customFolders.push(record);
    records.set(folder.id, record);
    locations.set(folder.id, {
      id: record.id,
      label: `${targetLocation.label} / ${record.folderPath}`,
      custom: true,
      options: {
        ...(record.parentOptions || {}),
        workspaceView: viewId,
        contextDomain: targetState.workspaceKind === "notebook" ? "general" : ["script", "prompts"].includes(viewId) ? "script" : "novel",
        customFolderId: record.id,
        customFolderLabel: record.label,
        customFolderPath: record.folderPath,
      },
    });
  }
  return { records, locations };
};

export const transferWorkspaceDocuments = async ({
  appRoot,
  operation = "copy",
  sourceWorkspacePath,
  documentIds = [],
  sourceFolder = null,
  targetWorkspacePath,
  targetWorkspaceKind = "",
  targetModuleId = "library",
  targetViewId = "default",
  targetLocationId = "library:default:root",
} = {}) => {
  if (!["copy", "move"].includes(operation)) throw new Error("不支持的文档转移方式");
  let ids = [...new Set((documentIds || []).map((id) => String(id || "")).filter(Boolean))];
  if (!ids.length && !sourceFolder) throw new Error("没有可处理的文档或文件夹");
  if (ids.length > MAX_TRANSFER_DOCUMENTS) throw new Error(`一次最多处理 ${MAX_TRANSFER_DOCUMENTS} 个文档`);
  if (!sourceWorkspacePath) throw new Error("缺少源工作区");
  if (!targetWorkspacePath || isTemporaryNotebookPath(targetWorkspacePath)) throw new Error("临时笔记本不能作为粘贴目标");

  const sourceTemporary = isTemporaryNotebookPath(sourceWorkspacePath);
  const targetRoot = resolveWorkspaceRoot({ appRoot, requestedPath: targetWorkspacePath });
  const sameWorkspace = !sourceTemporary && normalizedPath(sourceWorkspacePath) === normalizedPath(targetRoot);
  const sourceLoaded = sourceTemporary
    ? await loadTemporaryNotebookState({ activeDocumentId: ids[0] })
    : await loadWorkspaceState({ appRoot, requestedPath: sourceWorkspacePath });
  const sourceState = sourceLoaded.state;
  if (!sourceState) throw new Error("源工作区不可读取");
  const folderSelection = sourceFolder ? folderTransferSelection(sourceState, sourceFolder) : null;
  if (folderSelection) ids = folderSelection.documentIds;
  if (ids.length > MAX_TRANSFER_DOCUMENTS) throw new Error(`一次最多处理 ${MAX_TRANSFER_DOCUMENTS} 个文档`);
  const sourceRecords = ids.map((documentId) => {
    const documentState = sourceState.documents?.[documentId];
    const located = locateDocument(sourceState, documentId);
    const blocked = transferBlocked({ workspaceState: sourceState, documentId, documentState, located });
    if (blocked) throw new Error(`“${documentState?.title || documentId}”：${blocked}`);
    return { documentId, documentState, located, histories: Array.isArray(sourceState.histories?.[documentId]) ? sourceState.histories[documentId] : [] };
  });

  const targetLoaded = sameWorkspace ? sourceLoaded : await loadWorkspaceState({ appRoot, requestedPath: targetRoot });
  if (!targetLoaded.state) throw new Error("目标工作区尚未初始化");
  if (targetLoaded.state.readOnly === true) throw new Error("只读工作区不能作为粘贴目标");
  if (targetWorkspaceKind && targetLoaded.state.workspaceKind !== targetWorkspaceKind) throw new Error("目标工作区类型已经变化");
  const targetState = structuredClone(targetLoaded.state);
  const targetOriginalState = structuredClone(targetLoaded.state);
  const location = transferLocation({ targetState, moduleId: targetModuleId, viewId: targetViewId, locationId: targetLocationId });
  if (folderSelection && sameWorkspace && operation === "move" && folderSelection.folders.some((folder) => folder.id === targetLocationId)) {
    throw new Error("不能把文件夹移动到自身或其子文件夹中");
  }
  const transferredFolderTree = folderSelection
    ? materializeTransferredFolders({ targetState, selection: folderSelection, targetLocation: location, moduleId: targetModuleId, viewId: targetViewId })
    : null;
  const copiedAttachments = [];
  const transferred = [];
  let sharedAttachmentReplacements = new Map();
  const plannedTargetIds = new Map();
  const planningState = structuredClone(targetState);
  for (const source of sourceRecords) {
    const preserveId = sameWorkspace
      && operation === "move"
      && preserveMovedDocumentId({ documentId: source.documentId, moduleId: targetModuleId, viewId: targetViewId });
    const targetDocumentId = preserveId
      ? source.documentId
      : nextTransferredDocumentId({ workspaceState: planningState, moduleId: targetModuleId, viewId: targetViewId, documentKind: source.documentState.documentKind });
    plannedTargetIds.set(source.documentId, targetDocumentId);
    planningState.documents ??= {};
    planningState.documents[targetDocumentId] = {};
  }
  if (sameWorkspace && operation === "move") {
    removeDocumentsFromState(targetState, ids, plannedTargetIds);
    if (folderSelection?.customFolderIds.size) {
      targetState.customFolders = (targetState.customFolders || []).filter((folder) => !folderSelection.customFolderIds.has(folder.id));
      for (const folderId of folderSelection.customFolderIds) delete targetState.volumeHistories?.[folderId];
    }
  }
  try {
    for (const source of sourceRecords) {
      let replacements = new Map();
      if (!sameWorkspace) {
        const attachmentCopy = await copyReferencedAttachments({
          appRoot,
          sourceWorkspacePath,
          sourceDocumentId: source.documentId,
          sourceDocument: sourcePayloadForAttachments(source.documentState, source.histories),
          targetWorkspacePath: targetRoot,
          knownReplacements: sourceTemporary ? new Map() : sharedAttachmentReplacements,
        });
        copiedAttachments.push(...attachmentCopy.copied);
        replacements = attachmentCopy.replacements;
        if (!sourceTemporary) sharedAttachmentReplacements = attachmentCopy.replacements;
      }
      const targetDocumentId = plannedTargetIds.get(source.documentId);
      const documentLocation = folderSelection
        ? transferredFolderTree.locations.get(folderSelection.documentFolderIds.get(source.documentId)) || location
        : location;
      const documentState = targetDocumentState({
        sourceDocument: source.documentState,
        targetDocumentId,
        targetState,
        moduleId: targetModuleId,
        viewId: targetViewId,
        location: documentLocation,
        replacements,
      });
      targetState.documents ??= {};
      targetState.histories ??= {};
      targetState.moduleItems ??= {};
      targetState.moduleItems[targetModuleId] ??= [];
      targetState.documents[targetDocumentId] = documentState;
      targetState.histories[targetDocumentId] = rewriteAttachmentReferences(source.histories, replacements).map((entry) => (
        entry?.document
          ? { ...entry, document: targetDocumentState({
            sourceDocument: entry.document,
            targetDocumentId,
            targetState,
            moduleId: targetModuleId,
            viewId: targetViewId,
            location: documentLocation,
            replacements: new Map(),
            resolvedTitle: sequencedDocumentKind(targetDocumentId)
              ? freeDocumentTitle({ documentId: targetDocumentId, title: entry.document.title, language: entry.document.titleLanguage || targetState.structureLanguage || "zh-CN" })
              : entry.document.title,
            preserveUpdatedAt: true,
          }) }
          : entry
      ));
      targetState.moduleItems[targetModuleId].push(targetItem({ documentId: targetDocumentId, documentState, targetState, moduleId: targetModuleId, viewId: targetViewId, location: documentLocation }));
      transferred.push({ sourceDocumentId: source.documentId, targetDocumentId, title: documentState.title });
    }
  } catch (error) {
    await cleanupCopiedAttachments(targetRoot, copiedAttachments);
    throw error;
  }
  ensureDocumentTreeMetadata(targetState);
  targetState.activeModule = targetModuleId;
  targetState.activeDocument = transferred.at(-1)?.targetDocumentId || targetState.activeDocument;
  if (MODULE_VIEWS[targetModuleId]) targetState.moduleViews[targetModuleId] = targetViewId;
  appendActivity(targetState, {
    type: "edit",
    label: `${operation === "copy" ? "复制" : "移动"} ${transferred.length} 个文档到${location.label}`,
    documentId: targetState.activeDocument,
  });

  let targetCommitted;
  try {
    targetCommitted = await saveWorkspaceState({
      appRoot,
      requestedPath: targetRoot,
      state: targetState,
      expectedStateStamp: targetLoaded.stateStamp || "",
    });
    targetState.savedAt = targetCommitted.savedAt;
  } catch (error) {
    await cleanupCopiedAttachments(targetRoot, copiedAttachments);
    throw error;
  }

  let sourceStateAfter = sourceState;
  if (operation === "move" && !sameWorkspace) {
    try {
      if (sourceTemporary) {
        sourceStateAfter = (await removeTemporaryNotebookDocuments(ids)).state;
      } else {
        const sourceNext = removeDocumentsFromState(structuredClone(sourceState), ids);
        if (folderSelection?.customFolderIds.size) {
          sourceNext.customFolders = (sourceNext.customFolders || []).filter((folder) => !folderSelection.customFolderIds.has(folder.id));
          for (const folderId of folderSelection.customFolderIds) delete sourceNext.volumeHistories?.[folderId];
        }
        appendActivity(sourceNext, {
          type: "edit",
          label: `将 ${ids.length} 个文档移动到“${workspaceName(targetState, targetRoot)}”`,
        });
        const sourceCommitted = await saveWorkspaceState({
          appRoot,
          requestedPath: sourceWorkspacePath,
          state: sourceNext,
          expectedStateStamp: sourceLoaded.stateStamp || "",
        });
        sourceNext.savedAt = sourceCommitted.savedAt;
        sourceStateAfter = sourceNext;
      }
    } catch (error) {
      try {
        await saveWorkspaceState({
          appRoot,
          requestedPath: targetRoot,
          state: targetOriginalState,
          expectedStateStamp: targetCommitted.stateStamp || "",
        });
        await cleanupCopiedAttachments(targetRoot, copiedAttachments);
      } catch {
        throw new Error(`源工作区未能移除文档，且目标因并发变化无法回滚；两侧内容均已保留，请重新加载后核对：${error.message}`);
      }
      throw new Error(`源工作区未能安全移除文档，目标写入已回滚：${error.message}`);
    }
  }

  return {
    operation,
    sameWorkspace,
    sourceTemporary,
    sourceWorkspacePath,
    sourceWorkspaceKind: sourceState.workspaceKind,
    sourceState: sameWorkspace ? targetState : sourceStateAfter,
    targetWorkspacePath: targetRoot,
    targetWorkspaceKind: targetState.workspaceKind,
    targetWorkspaceName: workspaceName(targetState, targetRoot),
    targetState,
    targetStateStamp: targetCommitted.stateStamp,
    transferred,
    transferredFolderId: transferredFolderTree?.records.get(folderSelection?.root?.id)?.id || "",
    copiedAttachmentCount: copiedAttachments.length,
  };
};
