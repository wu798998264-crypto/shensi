import { classifyStructuredDocument } from "./structure-placement.js";

const IMPORT_OPTION_KEYS = [
  "workspaceView",
  "contextDomain",
  "treeGroup",
  "volumeFolder",
  "volumeLabel",
  "folderId",
  "folderLabel",
  "customFolderId",
  "rootPlacement",
];

const fallbackModuleId = (id) => {
  if (id.startsWith("chapter-") || id.startsWith("manuscript-")) return "manuscript";
  if (id.startsWith("script-episode-") || id.startsWith("prompt-")) return "manuscript";
  if (id.startsWith("script-outline-") || id.startsWith("outline-")) return "outline";
  if (id.startsWith("script-canon-") || id.startsWith("canon-")) return "canon";
  if (id.startsWith("script-memory-") || id.startsWith("memory-")) return "memory";
  if (id.startsWith("report-")) return "reports";
  if (id.startsWith("index-")) return "index";
  return "library";
};

const fallbackOptions = (id) => {
  if (id.startsWith("script-episode-")) return { workspaceView: "script", contextDomain: "script", treeGroup: "scripts" };
  if (id.startsWith("prompt-video-")) return { workspaceView: "prompts", contextDomain: "script", treeGroup: "video" };
  if (id.startsWith("prompt-visual-")) return { workspaceView: "prompts", contextDomain: "script", treeGroup: "visual" };
  if (id.startsWith("prompt-panorama-")) return { workspaceView: "prompts", contextDomain: "script", treeGroup: "panorama" };
  if (id === "script-outline-series") return { workspaceView: "script", contextDomain: "script", treeGroup: "series" };
  if (id.startsWith("script-outline-episode-")) return { workspaceView: "script", contextDomain: "script", treeGroup: "episodes" };
  if (/^script-(canon|memory)-/.test(id)) return { workspaceView: "script", contextDomain: "script" };
  if (id === "report-adaptation") return { contextDomain: "script" };
  return {};
};

export const importedModuleId = (id, documentState = {}) => documentState.moduleId || fallbackModuleId(id);

export const importedItemOptions = (id, documentState = {}) => {
  const options = { ...fallbackOptions(id) };
  for (const key of IMPORT_OPTION_KEYS) {
    if (documentState[key] !== undefined && documentState[key] !== null && documentState[key] !== "") {
      options[key] = documentState[key];
    }
  }
  return options;
};

const itemSortKey = ([id, label], documents) => documents[id]?.sourcePath || label || id;
const normalizeModuleItem = (item) => {
  if (Array.isArray(item)) return item;
  if (Array.isArray(item?.value)) return item.value;
  return null;
};

const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const repairImportedStructurePlacements = ({ targetState } = {}) => {
  if (!targetState?.documents || !targetState?.moduleItems) return { changed: false, moved: [], excluded: [] };
  const moved = [];
  const excluded = [];

  for (const [documentId, documentState] of Object.entries(targetState.documents)) {
    if (!documentState?.sourcePath) continue;
    const classification = classifyStructuredDocument({
      documentId,
      title: documentState.title,
      sourcePath: documentState.sourcePath,
      markdown: documentState.markdown ?? documentState.html ?? "",
    });
    if (!classification) continue;

    if (classification.excluded) {
      for (const [moduleId, items] of Object.entries(targetState.moduleItems)) {
        targetState.moduleItems[moduleId] = (items ?? []).map(normalizeModuleItem).filter((item) => item && item[0] !== documentId);
      }
      delete targetState.documents[documentId];
      if (targetState.histories) delete targetState.histories[documentId];
      excluded.push({ documentId, title: documentState.title, sourcePath: documentState.sourcePath, reason: classification.reason });
      continue;
    }

    const placement = classification.placement;
    if (!placement) continue;
    const previousModuleId = importedModuleId(documentId, documentState);
    const previousOptions = importedItemOptions(documentId, documentState);
    const nextOptions = { ...previousOptions };
    if (previousModuleId !== placement.moduleId) {
      delete nextOptions.folderId;
      delete nextOptions.folderLabel;
      delete nextOptions.customFolderId;
      delete nextOptions.rootPlacement;
      delete nextOptions.volumeFolder;
      delete nextOptions.volumeLabel;
      delete nextOptions.treeGroup;
    }
    const preserveImplicitNovelView = placement.viewId === "novel" && !previousOptions.workspaceView && previousModuleId === placement.moduleId;
    const preserveImplicitNovelDomain = placement.contextDomain === "novel" && !previousOptions.contextDomain && previousModuleId === placement.moduleId;
    if (placement.viewId && !preserveImplicitNovelView) nextOptions.workspaceView = placement.viewId;
    if (placement.contextDomain && !preserveImplicitNovelDomain) nextOptions.contextDomain = placement.contextDomain;
    if (placement.treeGroup) nextOptions.treeGroup = placement.treeGroup;

    const requiresMove = previousModuleId !== placement.moduleId || !sameValue(previousOptions, nextOptions);
    if (!requiresMove) continue;

    for (const [moduleId, items] of Object.entries(targetState.moduleItems)) {
      targetState.moduleItems[moduleId] = (items ?? []).map(normalizeModuleItem).filter((item) => (
        item && (item[0] !== documentId || item[2]?.alias)
      ));
    }
    targetState.moduleItems[placement.moduleId] ??= [];
    if (!targetState.moduleItems[placement.moduleId].some(([itemId, , options = {}]) => itemId === documentId && !options.alias)) {
      targetState.moduleItems[placement.moduleId].push([documentId, documentState.title, nextOptions]);
    }
    Object.assign(documentState, { moduleId: placement.moduleId, ...nextOptions });
    for (const key of IMPORT_OPTION_KEYS) {
      if (!(key in nextOptions)) delete documentState[key];
    }
    moved.push({
      documentId,
      title: documentState.title,
      sourcePath: documentState.sourcePath,
      fromModuleId: previousModuleId,
      toModuleId: placement.moduleId,
      viewId: placement.viewId,
      treeGroup: placement.treeGroup,
      reason: classification.reason,
    });
  }

  if (excluded.some(({ documentId }) => documentId === targetState.activeDocument)) {
    targetState.activeDocument = targetState.moduleItems.manuscript?.find(([, , options = {}]) => !options.alias)?.[0]
      ?? Object.keys(targetState.documents)[0]
      ?? null;
  }
  if (targetState.activeDocument && targetState.documents[targetState.activeDocument]) {
    const activeState = targetState.documents[targetState.activeDocument];
    targetState.activeModule = importedModuleId(targetState.activeDocument, activeState);
    targetState.moduleViews ??= {};
    if (activeState.workspaceView) targetState.moduleViews[targetState.activeModule] = activeState.workspaceView;
  }
  return { changed: moved.length > 0 || excluded.length > 0, moved, excluded };
};

export const mergeImportedDocuments = ({ targetState, importedDocuments, moduleIds, replace = false }) => {
  if (replace) {
    targetState.documents = {};
    targetState.moduleItems = Object.fromEntries(moduleIds.map((id) => [id, []]));
  } else {
    targetState.documents ??= {};
    targetState.moduleItems ??= {};
    for (const id of moduleIds) {
      targetState.moduleItems[id] = (targetState.moduleItems[id] ?? []).map(normalizeModuleItem).filter(Boolean);
    }
  }

  for (const [id, imported] of Object.entries(importedDocuments)) {
    const moduleId = importedModuleId(id, imported);
    const options = importedItemOptions(id, imported);
    targetState.documents[id] = { ...(targetState.documents[id] ?? {}), ...imported, moduleId, ...options };
    for (const items of Object.values(targetState.moduleItems)) {
      const index = items.findIndex(([itemId, , itemOptions = {}]) => itemId === id && !itemOptions.alias);
      if (index >= 0) items.splice(index, 1);
    }
    targetState.moduleItems[moduleId] ??= [];
    targetState.moduleItems[moduleId].push([id, targetState.documents[id].title, options]);
  }

  for (const items of Object.values(targetState.moduleItems)) {
    items.sort((left, right) => itemSortKey(left, targetState.documents).localeCompare(
      itemSortKey(right, targetState.documents),
      "zh-CN",
      { numeric: true },
    ));
  }

  const activeDocumentExists = Boolean(targetState.documents[targetState.activeDocument]);
  if (!activeDocumentExists) {
    const manuscriptId = targetState.moduleItems.manuscript?.find(([, , options = {}]) => !options.alias)?.[0];
    targetState.activeDocument = manuscriptId || Object.keys(targetState.documents)[0] || null;
  }
  if (targetState.activeDocument) {
    const activeState = targetState.documents[targetState.activeDocument];
    targetState.activeModule = importedModuleId(targetState.activeDocument, activeState);
    targetState.moduleViews ??= {};
    if (activeState.workspaceView) targetState.moduleViews[targetState.activeModule] = activeState.workspaceView;
  }
  return targetState;
};
