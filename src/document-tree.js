import {
  STRUCTURED_DOCUMENT_CLASSIFICATION_THRESHOLD,
  structuredGroupByKey,
  structuredGroupForDocument,
  structuredGroupLocationId,
  structuredGroupNodeId,
  structuredGroupsFor,
} from "./structure-schema.js";
import { chapterNumberValue } from "./chapter-target.js";

export const DEFAULT_VOLUME = {
  folderId: "manuscript-volume:第001卷-未命名",
  folderLabel: "第001卷　未命名",
  volumeFolder: "第001卷-未命名",
  treeGroup: "volume",
};

const cloneOptions = (options = {}) => ({ ...options });

const DOCUMENT_WORKSPACE_VIEWS = new Set(["novel", "script", "prompts"]);
const VIEWED_MODULE_IDS = new Set(["manuscript", "outline", "canon", "memory"]);
const SCRIPT_TITLE_PATTERN = /(?:短剧|影视剧本|电影剧本|电视剧本|剧本|脚本|分镜)/u;
const PROMPT_TITLE_PATTERN = /(?:提示词|提示语|prompt)/iu;

/**
 * Resolve the visible directory for a document when older records do not
 * carry an explicit workspaceView.  Short drama and film/television scripts
 * intentionally share the single `script` directory; prompts remain the
 * only separate visual-text directory.
 */
export const documentWorkspaceView = ({ moduleId = "", item = null, documentState = {} } = {}) => {
  const [documentId = "", , itemOptions = {}] = Array.isArray(item) ? item : [];
  const explicitView = itemOptions.workspaceView || documentState.workspaceView;
  if (DOCUMENT_WORKSPACE_VIEWS.has(explicitView)) return explicitView;
  if (!moduleId || !VIEWED_MODULE_IDS.has(moduleId)) return "default";

  const contextDomain = String(documentState.contextDomain || itemOptions.contextDomain || "").trim();
  const deliverableType = String(documentState.deliverableType || itemOptions.deliverableType || "").trim().toLowerCase();
  const title = String(documentState.title || item?.[1] || "").trim();
  if (moduleId === "manuscript") {
    if (String(documentId).startsWith("prompt-") || deliverableType === "visual_prompt" || PROMPT_TITLE_PATTERN.test(title)) return "prompts";
    if (String(documentId).startsWith("script-")
      || contextDomain === "script"
      || contextDomain === "script-adaptation"
      || deliverableType === "short_drama_script"
      || SCRIPT_TITLE_PATTERN.test(title)) return "script";
    if (DOCUMENT_WORKSPACE_VIEWS.has(explicitView)) return explicitView;
    return "novel";
  }
  if (String(documentId).startsWith("script-")
    || contextDomain === "script"
    || contextDomain === "script-adaptation"
    || deliverableType === "short_drama_script"
    || SCRIPT_TITLE_PATTERN.test(title)) return "script";
  if (DOCUMENT_WORKSPACE_VIEWS.has(explicitView)) return explicitView;
  return "novel";
};

const structuredDocumentCharacters = (documentState = {}) => String(documentState.markdown ?? documentState.html ?? "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, "")
  .length;

const SYSTEM_TITLE_NUMBER = "\\d+|[零〇一二两三四五六七八九十百千]+";

const systemDocumentTitleKind = ({ moduleId = "", viewId = "novel", documentId = "" } = {}) => {
  const manuscriptCompatible = !moduleId || moduleId === "manuscript";
  if (manuscriptCompatible && documentId.startsWith("chapter-")) return "chapter";
  if (manuscriptCompatible && documentId.startsWith("script-episode-")) return "episode";
  if (moduleId === "manuscript" && viewId === "novel") return "chapter";
  if (moduleId === "manuscript" && viewId === "script") return "episode";
  return null;
};

export const systemDocumentTitleParts = ({ title = "", moduleId = "", viewId = "novel", documentId = "" } = {}) => {
  const kind = systemDocumentTitleKind({ moduleId, viewId, documentId });
  if (!kind) return null;
  const source = String(title).trim();
  const unit = kind === "chapter" ? "章" : "集";
  const englishUnit = kind === "chapter" ? "Chapter" : "Episode";
  const chineseMatch = source.match(new RegExp(`^第\\s*(${SYSTEM_TITLE_NUMBER})\\s*${unit}(?:[\\s　:：·-]+(.*))?$`));
  const englishMatch = source.match(new RegExp(`^${englishUnit}\\s+(${SYSTEM_TITLE_NUMBER})(?:[\\s　:：·-]+(.*))?$`, "i"));
  const match = chineseMatch ?? englishMatch;
  if (!match) return null;
  const number = chapterNumberValue(match[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { kind, number, title: String(match[2] ?? "").trim() };
};

export const localizeSystemDocumentTitle = ({
  title = "",
  language: _language = "zh-CN",
  moduleId: _moduleId = "",
  viewId: _viewId = "novel",
  documentId: _documentId = "",
  documentKind: _documentKind = "",
  systemGenerated: _systemGenerated,
} = {}) => {
  // Document names are content. Their creation language is persisted in the
  // title itself, so changing the UI language must never rewrite the label.
  return String(title);
};

export const documentRenameTitle = ({ workspaceKind = "project", moduleId, viewId = "novel", documentId = "", currentTitle = "", nextName = "" }) => {
  const normalized = String(nextName).trim();
  // The sequence lives in the stable document id and navigation label. The
  // document title itself is content and must remain freely editable.
  return normalized;
};

export const documentCreationOptions = ({ defaultOptions = {}, placement = null }) => {
  if (!placement) return cloneOptions(defaultOptions);
  const placementOptions = cloneOptions(placement.options ?? placement);
  return {
    ...(placement.root ? {} : cloneOptions(defaultOptions)),
    ...placementOptions,
  };
};

export const blankDirectoryFolderId = ({
  containingFolderId = "",
  precedingNodeType = "",
  precedingFolderId = "",
  precedingFolderExpanded = false,
} = {}) => {
  if (containingFolderId) return containingFolderId;
  if (precedingNodeType === "folder" && precedingFolderExpanded && precedingFolderId) return precedingFolderId;
  return null;
};

const volumeFromSourcePath = (sourcePath = "") => {
  const raw = String(sourcePath).replaceAll("\\", "/").match(/04_正文\/小说\/([^/]+)\//)?.[1];
  if (!raw) return null;
  const match = raw.match(/^第(\d+)卷-(.+)$/);
  const folderLabel = match ? `第${match[1].padStart(3, "0")}卷　${match[2]}` : raw.replace("-", "　");
  return {
    folderId: `manuscript-volume:${raw}`,
    folderLabel,
    volumeFolder: raw,
    treeGroup: "volume",
  };
};

const manuscriptOptions = (documentState = {}, options = {}) => {
  const source = volumeFromSourcePath(documentState.sourcePath);
  const volumeFolder = options.volumeFolder ?? documentState.volumeFolder ?? source?.volumeFolder ?? DEFAULT_VOLUME.volumeFolder;
  return {
    ...options,
    folderId: options.folderId ?? source?.folderId ?? `manuscript-volume:${volumeFolder}`,
    folderLabel: options.folderLabel ?? source?.folderLabel ?? documentState.volumeLabel ?? DEFAULT_VOLUME.folderLabel,
    volumeFolder,
    treeGroup: "volume",
  };
};

const outlineGroup = (id, options = {}) => {
  if (options.rootPlacement === true) return "other";
  if (options.treeGroup) return options.treeGroup;
  if (id === "outline-series") return "series";
  if (id.startsWith("outline-volume-")) return "volumes";
  if (id.startsWith("outline-chapter-")) return "chapters";
  return "chapters";
};

const structuredGroupForItem = (moduleId, viewId, id, options = {}) => (
  structuredGroupForDocument(moduleId, viewId, id)
  ?? structuredGroupByKey(moduleId, viewId, options.treeGroup)
);

export const ensureDocumentTreeMetadata = (state) => {
  state.moduleItems ??= {};
  state.documents ??= {};
  state.moduleItems.manuscript = (state.moduleItems.manuscript ?? []).map(([id, label, options = {}]) => {
    const documentState = state.documents[id] ?? {};
    const viewId = documentWorkspaceView({ moduleId: "manuscript", item: [id, label, options], documentState });
    if (viewId !== "novel") {
      const nextOptions = {
        ...options,
        workspaceView: viewId,
        contextDomain: "script",
        ...(viewId === "script" && !options.treeGroup ? { treeGroup: "scripts" } : {}),
        ...(viewId === "prompts" && !options.treeGroup ? { treeGroup: "video" } : {}),
      };
      if (state.documents[id]) Object.assign(documentState, { workspaceView: viewId, contextDomain: "script" });
      return [id, label, nextOptions];
    }
    if (options.rootPlacement === true || documentState.rootPlacement === true) return [id, label, options];
    const hasExplicitVolume = Boolean(options.folderId || options.volumeFolder || documentState.volumeFolder || documentState.volumeLabel);
    if (state.workspaceKind === "notebook" && !hasExplicitVolume) return [id, label, options];
    const nextOptions = manuscriptOptions(documentState, options);
    if (state.documents[id]) {
      state.documents[id].volumeFolder = nextOptions.volumeFolder;
      state.documents[id].volumeLabel = nextOptions.folderLabel;
    }
    return [id, label, nextOptions];
  });
  state.moduleItems.outline = (state.moduleItems.outline ?? []).map(([id, label, options = {}]) => [
    id,
    label,
    { ...options, treeGroup: outlineGroup(id, options) },
  ]);
  if (state.workspaceKind !== "notebook") {
    for (const moduleId of ["canon", "memory", "reports", "library", "index"]) {
      state.moduleItems[moduleId] = (state.moduleItems[moduleId] ?? []).map(([id, label, options = {}]) => {
        if (options.rootPlacement === true || options.customFolderId) return [id, label, options];
        const viewId = documentWorkspaceView({ moduleId, item: [id, label, options], documentState: state.documents[id] ?? {} });
        const group = structuredGroupForItem(moduleId, viewId, id, options);
        const nextOptions = {
          ...options,
          ...(VIEWED_MODULE_IDS.has(moduleId) && viewId !== "default" ? { workspaceView: viewId } : {}),
          ...(viewId === "script" ? { contextDomain: "script" } : {}),
        };
        if (state.documents[id] && VIEWED_MODULE_IDS.has(moduleId) && viewId !== "default") {
          state.documents[id].workspaceView = viewId;
          if (viewId === "script") state.documents[id].contextDomain = "script";
        }
        return [id, label, group ? { ...nextOptions, treeGroup: group.key } : nextOptions];
      });
    }
  }
  return state;
};

const documentNode = ([id, label, options = {}]) => ({ type: "document", id, label, options });

const AUTHOR_COCKPIT_FIXED_DOCUMENT_IDS = new Set([
  "report-compile",
  "report-novel",
  "report-script",
  "report-adaptation",
  "index-pending",
  "index-update-log",
  "index-language-blacklist",
]);

export const authorCockpitContent = ({ documentId, node, workspaceKind = "project" } = {}) => (
  workspaceKind === "project"
  && (AUTHOR_COCKPIT_FIXED_DOCUMENT_IDS.has(String(documentId || "")) || node?.authorCockpitFixed === true)
);

export const folderDeleteAllowed = ({ node, moduleId, viewId = "novel", workspaceKind = "project" }) => Boolean(
  node?.type === "folder" && !authorCockpitContent({ node, workspaceKind })
);

export const documentDeleteAllowed = ({ documentId, moduleId, workspaceKind = "project" } = {}) => Boolean(
  documentId
  && documentId !== "library-trash"
  && !authorCockpitContent({ documentId, workspaceKind })
);

export const manuscriptVolumeDeleteSelection = ({ folderId, items = [], folders = [] }) => {
  const folderIds = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (!folderIds.has(folder.id) && folderIds.has(folder.parentLocationId)) {
        folderIds.add(folder.id);
        changed = true;
      }
    }
  }
  const selectedFolders = folders.filter((folder) => folderIds.has(folder.id));
  const selectedItems = items.filter(([, , options = {}]) => (
    options.folderId === folderId
    || Boolean(options.customFolderId && folderIds.has(options.customFolderId))
  ));
  const directOptions = selectedItems.find(([, , options = {}]) => options.folderId === folderId)?.[2] ?? {};
  return {
    folderIds: [...folderIds],
    customFolders: selectedFolders,
    items: selectedItems,
    documentIds: selectedItems.map(([id]) => id),
    volumeFolder: directOptions.volumeFolder ?? directOptions.folderLabel ?? "",
  };
};

export const buildNotebookDocumentTree = ({ moduleItems = {}, documents = {}, folders = [] } = {}) => {
  const itemsById = new Map();
  for (const items of Object.values(moduleItems ?? {})) {
    for (const [id, label, options = {}] of items ?? []) {
      const documentState = documents[id];
      if (!documentState || documentState.virtual || id === "library-trash" || itemsById.has(id)) continue;
      itemsById.set(id, [id, documentState.title || label || id, {
        ...options,
        customFolderId: options.customFolderId || documentState.customFolderId,
      }]);
    }
  }

  const customFolders = (folders ?? []).filter((folder) => folder?.id);
  const foldersById = new Map(customFolders.map((folder) => [folder.id, folder]));
  const documentsByFolder = new Map();
  const rootDocuments = [];
  for (const item of itemsById.values()) {
    const folderId = item[2]?.customFolderId;
    if (!folderId || !foldersById.has(folderId)) {
      rootDocuments.push(documentNode(item));
      continue;
    }
    if (!documentsByFolder.has(folderId)) documentsByFolder.set(folderId, []);
    documentsByFolder.get(folderId).push(documentNode(item));
  }

  const childFolders = new Map();
  const rootFolders = [];
  for (const folder of customFolders) {
    if (foldersById.has(folder.parentLocationId) && folder.parentLocationId !== folder.id) {
      if (!childFolders.has(folder.parentLocationId)) childFolders.set(folder.parentLocationId, []);
      childFolders.get(folder.parentLocationId).push(folder);
    } else {
      rootFolders.push(folder);
    }
  }

  const emitted = new Set();
  const buildFolder = (folder, ancestry = new Set()) => {
    if (!folder || emitted.has(folder.id) || ancestry.has(folder.id)) return null;
    emitted.add(folder.id);
    const nextAncestry = new Set(ancestry).add(folder.id);
    return {
      type: "folder",
      id: folder.id,
      label: folder.label,
      custom: true,
      folder,
      locationId: folder.id,
      children: [
        ...(childFolders.get(folder.id) ?? []).map((child) => buildFolder(child, nextAncestry)).filter(Boolean),
        ...(documentsByFolder.get(folder.id) ?? []),
      ],
    };
  };

  const tree = rootFolders.map((folder) => buildFolder(folder)).filter(Boolean);
  for (const folder of customFolders) {
    const orphan = buildFolder(folder);
    if (orphan) tree.push(orphan);
  }
  return [...tree, ...rootDocuments];
};

const foldersForView = (folders = [], moduleId, viewId) => folders.filter((folder) => (
  folder?.id && folder.moduleId === moduleId && folder.viewId === viewId
));

const customFolderNode = (folder, items, childFolders = []) => ({
  type: "folder",
  id: folder.id,
  label: folder.label,
  custom: true,
  folder,
  locationId: folder.id,
  children: [
    ...items
      .filter(([, , options = {}]) => options.customFolderId === folder.id)
      .map(documentNode),
    ...childFolders,
  ],
});

const attachCustomFolders = ({ baseTree, customFolders, items, moduleId, viewId }) => {
  const emitted = new Set();
  const folderIds = new Set(customFolders.map((folder) => folder.id));
  const fixedLocationIds = new Set(baseTree
    .filter((node) => node.type === "folder")
    .flatMap((node) => [node.id, node.locationId].filter(Boolean)));
  const rootLocationId = `${moduleId}:${viewId}:root`;
  const buildCustomNode = (folder, ancestry = new Set()) => {
    if (!folder || emitted.has(folder.id)) return null;
    emitted.add(folder.id);
    const nextAncestry = new Set(ancestry).add(folder.id);
    const childFolders = customFolders
      .filter((candidate) => candidate.parentLocationId === folder.id && !nextAncestry.has(candidate.id))
      .map((candidate) => buildCustomNode(candidate, nextAncestry))
      .filter(Boolean);
    return customFolderNode(folder, items, childFolders);
  };
  const withFixedChildren = baseTree.map((node) => {
    if (node.type !== "folder") return node;
    const parentIds = new Set([node.id, node.locationId].filter(Boolean));
    const childFolders = customFolders
      .filter((folder) => parentIds.has(folder.parentLocationId))
      .map((folder) => buildCustomNode(folder))
      .filter(Boolean);
    return { ...node, children: [...node.children, ...childFolders] };
  });
  const rootFolders = customFolders
    .filter((folder) => folder.parentLocationId === rootLocationId || (!folderIds.has(folder.parentLocationId) && !fixedLocationIds.has(folder.parentLocationId)))
    .map((folder) => buildCustomNode(folder))
    .filter(Boolean);
  const unplaced = customFolders.map((folder) => buildCustomNode(folder)).filter(Boolean);
  return [...withFixedChildren, ...rootFolders, ...unplaced];
};

export const buildDocumentTree = ({ moduleId, viewId = "novel", items = [], documents = {}, folders = [], workspaceKind = "project" }) => {
  const customFolders = foldersForView(folders, moduleId, viewId);
  const customFolderIds = new Set(customFolders.map((folder) => folder.id));
  const viewItems = items.filter(([id, , options = {}]) => {
    if (options.hiddenFromDirectory === true) return false;
    const inferredView = documentWorkspaceView({ moduleId, item: [id, "", options], documentState: documents[id] ?? {} });
    return (options.workspaceView ?? inferredView) === viewId;
  });
  const rootItems = viewItems.filter(([, , options = {}]) => !customFolderIds.has(options.customFolderId));
  if (moduleId === "manuscript") {
    if (viewId === "script") return attachCustomFolders({ baseTree: rootItems.map(documentNode), customFolders, items: viewItems, moduleId, viewId });
    if (viewId === "prompts") {
      const folders = [
        { id: "prompt-folder:video", label: "视频提示词", group: "video" },
        { id: "prompt-folder:visual", label: "视觉资产提示词", group: "visual" },
        { id: "prompt-folder:panorama", label: "全景调度图提示词", group: "panorama" },
      ];
      const baseTree = folders.map((folder) => ({
        type: "folder",
        id: folder.id,
        label: folder.label,
        locationId: `prompts:${folder.group}`,
        children: rootItems.filter(([, , options = {}]) => options.treeGroup === folder.group).map(documentNode),
      }));
      return attachCustomFolders({ baseTree, customFolders, items: viewItems, moduleId, viewId });
    }
    const volumeFolders = new Map();
    const notebookRootItems = [];
    for (const item of rootItems) {
      const [id, , options = {}] = item;
      const documentState = documents[id] ?? {};
      if (options.rootPlacement === true || documentState.rootPlacement === true) {
        notebookRootItems.push(documentNode(item));
        continue;
      }
      const hasExplicitVolume = Boolean(options.folderId || options.volumeFolder || documentState.volumeFolder || documentState.volumeLabel);
      if (workspaceKind === "notebook" && !hasExplicitVolume) {
        notebookRootItems.push(documentNode(item));
        continue;
      }
      const metadata = manuscriptOptions(documents[id], options);
      if (!volumeFolders.has(metadata.folderId)) {
        volumeFolders.set(metadata.folderId, {
          type: "folder",
          id: metadata.folderId,
          label: metadata.folderLabel,
          children: [],
        });
      }
      volumeFolders.get(metadata.folderId).children.push(documentNode([item[0], item[1], metadata]));
    }
    return attachCustomFolders({ baseTree: [...Array.from(volumeFolders.values()), ...notebookRootItems], customFolders, items: viewItems, moduleId, viewId });
  }

  if (moduleId === "outline") {
    const groups = { series: [], volumes: [], chapters: [], episodes: [], other: [] };
    for (const item of rootItems) {
      const group = outlineGroup(item[0], item[2] ?? {});
      (groups[group] ?? groups.other).push(documentNode(item));
    }
    if (viewId === "script") return attachCustomFolders({ baseTree: [
      ...groups.series,
      { type: "folder", id: "script-outline-folder:episodes", locationId: "script-outline:episodes", label: "集纲", children: groups.episodes },
      ...groups.other,
    ], customFolders, items: viewItems, moduleId, viewId });
    return attachCustomFolders({ baseTree: [
      ...groups.series,
      { type: "folder", id: "outline-folder:volumes", locationId: "outline:volumes", label: "卷纲", children: groups.volumes },
      { type: "folder", id: "outline-folder:chapters", locationId: "outline:chapters", label: "章纲", children: groups.chapters },
      ...groups.other,
    ], customFolders, items: viewItems, moduleId, viewId });
  }

  if (workspaceKind !== "notebook") {
    const structuredGroups = structuredGroupsFor(moduleId, viewId);
    if (structuredGroups.length) {
      const groupedIds = new Set();
      const baseTree = structuredGroups.flatMap((group) => {
        const children = rootItems.filter(([id, , options = {}]) => {
          const matched = structuredGroupForItem(moduleId, viewId, id, options);
          if (matched?.key !== group.key) return false;
          groupedIds.add(id);
          return true;
        }).map(documentNode);
        const nodeId = structuredGroupNodeId(moduleId, viewId, group.key);
        const locationId = structuredGroupLocationId(moduleId, viewId, group.key);
        const hasCustomFolders = customFolders.some((folder) => [nodeId, locationId].includes(folder.parentLocationId));
        const oversizedDocument = children.length === 1
          && structuredDocumentCharacters(documents[children[0].id]) > STRUCTURED_DOCUMENT_CLASSIFICATION_THRESHOLD;
        const needsFolder = group.expandable === true
          || children.length > 1
          || hasCustomFolders
          || oversizedDocument;
        if (!needsFolder) return children;
        return [{
          type: "folder",
          id: nodeId,
          label: group.label,
          locationId,
          structured: true,
          children,
        }];
      });
      const ungrouped = rootItems.filter(([id]) => !groupedIds.has(id)).map(documentNode);
      return attachCustomFolders({ baseTree: [...baseTree, ...ungrouped], customFolders, items: viewItems, moduleId, viewId });
    }
  }

  return attachCustomFolders({ baseTree: rootItems.map(documentNode), customFolders, items: viewItems, moduleId, viewId });
};

export const buildReferenceModuleNode = ({ module, viewNodes = [] }) => {
  if (!module) return null;
  const visibleViewNodes = viewNodes.filter((node) => node.children?.length || module.id === "manuscript");
  const children = visibleViewNodes.length === 1 ? visibleViewNodes[0].children : visibleViewNodes;
  return children.length
    ? { type: "folder", id: `reference:module:${module.id}`, label: module.label, children }
    : null;
};

export const materializeNotebookFolder = ({ state, node, moduleId, viewId = "novel", folderId }) => {
  if (state?.workspaceKind !== "notebook" || !node || node.type !== "folder") return null;
  state.customFolders ??= [];
  const existing = state.customFolders.find((folder) => folder.id === node.id);
  if (existing) return existing;

  const id = folderId;
  if (!id || state.customFolders.some((folder) => folder.id === id)) return null;
  const directDocumentIds = new Set((node.children ?? []).filter((child) => child.type === "document").map((child) => child.id));
  const record = {
    id,
    label: node.label,
    moduleId,
    viewId,
    parentLocationId: `${moduleId}:${viewId}:root`,
    parentLabel: "笔记目录",
    parentOptions: { workspaceView: viewId, contextDomain: "general" },
    folderPath: node.label,
    createdAt: new Date().toISOString(),
  };
  state.customFolders.push(record);

  for (const item of state.moduleItems?.[moduleId] ?? []) {
    if (!directDocumentIds.has(item[0])) continue;
    const options = item[2] ?? (item[2] = {});
    Object.assign(options, {
      workspaceView: viewId,
      contextDomain: "general",
      placementOverride: true,
      customFolderId: id,
      customFolderLabel: node.label,
      customFolderPath: node.label,
      placement: id,
    });
    delete options.folderId;
    delete options.folderLabel;
    delete options.volumeFolder;
    delete options.treeGroup;
    const documentState = state.documents?.[item[0]];
    if (!documentState) continue;
    Object.assign(documentState, {
      moduleId,
      workspaceView: viewId,
      contextDomain: "general",
      placementOverride: true,
      customFolderId: id,
      customFolderName: node.label,
      customFolderPath: node.label,
    });
    delete documentState.volumeFolder;
    delete documentState.volumeLabel;
    delete documentState.treeGroup;
  }
  for (const folder of state.customFolders) {
    if (folder.id !== id && folder.parentLocationId === node.id) folder.parentLocationId = id;
  }
  return record;
};

export const findDocumentFolder = ({ moduleId, viewId = "novel", items = [], documents = {}, folders = [], documentId, workspaceKind = "project" }) => {
  const tree = buildDocumentTree({ moduleId, viewId, items, documents, folders, workspaceKind });
  const findFolder = (nodes) => {
    for (const node of nodes) {
      if (node.type !== "folder") continue;
      if (node.children.some((child) => child.type === "document" && child.id === documentId)) return node;
      const nested = findFolder(node.children.filter((child) => child.type === "folder"));
      if (nested) return nested;
    }
    return null;
  };
  return findFolder(tree);
};

export const newDocumentTreeOptions = ({ moduleId, viewId = "novel", items = [], documents = {}, activeDocumentId }) => {
  const activeItem = items.find(([id]) => id === activeDocumentId);
  if (moduleId === "manuscript" && viewId === "script") return { workspaceView: "script", contextDomain: "script", treeGroup: "scripts" };
  if (moduleId === "manuscript" && viewId === "prompts") return { workspaceView: "prompts", contextDomain: "script", treeGroup: activeItem?.[2]?.treeGroup ?? "video" };
  if (moduleId === "manuscript") return manuscriptOptions(documents[activeDocumentId], activeItem?.[2] ?? {});
  if (moduleId === "outline") {
    if (viewId === "script") return { workspaceView: "script", contextDomain: "script", treeGroup: "episodes" };
    const group = outlineGroup(activeItem?.[0] ?? "", activeItem?.[2] ?? {});
    return { treeGroup: group === "volumes" ? "volumes" : "chapters" };
  }
  return { ...cloneOptions(activeItem?.[2]), ...(viewId === "script" ? { workspaceView: "script", contextDomain: "script" } : {}) };
};

const rootLocation = (moduleId, viewId, label, contextDomain = ["script", "prompts"].includes(viewId) ? "script" : "novel") => ({
  id: `${moduleId}:${viewId}:root`,
  label,
  root: true,
  options: {
    workspaceView: viewId,
    contextDomain,
    rootPlacement: true,
  },
});

export const documentLocationChoices = ({ moduleId, viewId = "novel", items = [], documents = {}, folders = [], workspaceKind = "project" }) => {
  // A notebook presents one shared directory even when legacy folders still
  // carry their original module metadata. Treat those real folders as valid
  // destinations without rewriting the stored records.
  const customFolders = workspaceKind === "notebook"
    ? (folders ?? []).filter((folder) => folder?.id)
    : foldersForView(folders, moduleId, viewId);
  const customFolderPath = (folder) => {
    const labels = [folder.label];
    const seen = new Set([folder.id]);
    let parent = customFolders.find((candidate) => candidate.id === folder.parentLocationId);
    while (parent && !seen.has(parent.id)) {
      labels.unshift(parent.label);
      seen.add(parent.id);
      parent = customFolders.find((candidate) => candidate.id === parent.parentLocationId);
    }
    return labels.join("/");
  };
  const customFolderBaseLabel = (folder) => {
    const seen = new Set([folder.id]);
    let current = folder;
    let parent = customFolders.find((candidate) => candidate.id === current.parentLocationId);
    while (parent && !seen.has(parent.id)) {
      current = parent;
      seen.add(parent.id);
      parent = customFolders.find((candidate) => candidate.id === current.parentLocationId);
    }
    return current.parentLabel || "当前板块";
  };
  const appendCustomFolders = (choices) => [
    ...choices,
    ...customFolders.map((folder) => ({
      id: folder.id,
      label: workspaceKind === "notebook"
        ? `${folder.parentOptions?.customFolderPath ? "笔记" : folder.parentLabel || "笔记"} / ${customFolderPath(folder)}`
        : `${customFolderBaseLabel(folder)} / ${customFolderPath(folder)}`,
      custom: true,
      options: {
        ...(folder.parentOptions ?? {}),
        workspaceView: viewId,
        contextDomain: ["script", "prompts"].includes(viewId) ? "script" : "novel",
        customFolderId: folder.id,
        customFolderLabel: folder.label,
        customFolderPath: customFolderPath(folder),
      },
    })),
  ];
  if (workspaceKind === "notebook") {
    // 旧版笔记可能仍使用作品目录的固定文件夹元数据；正式新建时也应允许选择这些现存目录。
    const fixedFolderChoices = buildDocumentTree({ moduleId, viewId, items, documents, folders, workspaceKind })
      .filter((node) => node.type === "folder" && !node.custom)
      .map((folder) => {
        const documentChild = folder.children.find((child) => child.type === "document");
        return {
          id: folder.locationId ?? folder.id,
          label: `笔记 / ${folder.label}`,
          options: {
            ...(documentChild?.options ?? folder.folder?.parentOptions ?? {}),
            workspaceView: viewId,
            contextDomain: "general",
          },
        };
      });
    return appendCustomFolders([
      rootLocation(moduleId, viewId, "笔记根目录", "general"),
      ...fixedFolderChoices,
    ]);
  }
  if (moduleId === "outline") {
    if (viewId === "script") return appendCustomFolders([
      { id: "script-outline:series", label: "剧本大纲 / 总目录", options: { workspaceView: "script", contextDomain: "script", treeGroup: "series" } },
      { id: "script-outline:episodes", label: "剧本大纲 / 集纲", options: { workspaceView: "script", contextDomain: "script", treeGroup: "episodes" } },
      rootLocation(moduleId, viewId, "剧本大纲 / 根目录", "script"),
    ]);
    return appendCustomFolders([
      { id: "outline:series", label: "小说大纲 / 总目录", options: { workspaceView: "novel", contextDomain: "novel", treeGroup: "series" } },
      { id: "outline:volumes", label: "小说大纲 / 卷纲", options: { workspaceView: "novel", contextDomain: "novel", treeGroup: "volumes" } },
      { id: "outline:chapters", label: "小说大纲 / 章纲", options: { workspaceView: "novel", contextDomain: "novel", treeGroup: "chapters" } },
      rootLocation(moduleId, viewId, "小说大纲 / 根目录"),
    ]);
  }
  if (moduleId === "manuscript" && viewId === "novel") {
    const treeFolders = buildDocumentTree({ moduleId, viewId, items, documents, folders }).filter((node) => node.type === "folder" && !node.custom);
    const baseChoices = treeFolders.length ? treeFolders.map((folder) => {
      const options = folder.children.find((child) => child.type === "document")?.options ?? folder.folder?.parentOptions ?? {};
      const volumeFolder = options.volumeFolder ?? folder.folder?.label ?? String(folder.id).replace(/^manuscript-volume:/, "");
      return {
        id: folder.id,
        label: `正文目录 / ${folder.label}`,
        options: {
          workspaceView: "novel",
          contextDomain: "novel",
          folderId: folder.id,
          folderLabel: folder.label,
          volumeFolder,
          treeGroup: "volume",
        },
      };
    }) : [{
      id: DEFAULT_VOLUME.folderId,
      label: `正文目录 / ${DEFAULT_VOLUME.folderLabel}`,
      options: { workspaceView: "novel", contextDomain: "novel", ...DEFAULT_VOLUME },
    }];
    return appendCustomFolders([
      ...baseChoices,
      rootLocation(moduleId, viewId, "正文目录 / 根目录"),
    ]);
  }
  if (moduleId === "manuscript" && viewId === "script") return appendCustomFolders([
    { id: "manuscript:script:scripts", label: "剧本目录 / 短剧剧本", options: { workspaceView: "script", contextDomain: "script", treeGroup: "scripts" } },
    rootLocation(moduleId, viewId, "剧本目录 / 根目录", "script"),
  ]);
  if (moduleId === "manuscript" && viewId === "prompts") return appendCustomFolders([
    { id: "prompts:video", label: "提示词目录 / 视频提示词", options: { workspaceView: "prompts", contextDomain: "script", treeGroup: "video" } },
    { id: "prompts:visual", label: "提示词目录 / 视觉资产提示词", options: { workspaceView: "prompts", contextDomain: "script", treeGroup: "visual" } },
    { id: "prompts:panorama", label: "提示词目录 / 全景调度图提示词", options: { workspaceView: "prompts", contextDomain: "script", treeGroup: "panorama" } },
    rootLocation(moduleId, viewId, "提示词目录 / 根目录", "script"),
  ]);
  const labels = {
    "canon:novel": "正史设定",
    "canon:script": "剧本设定",
    "memory:novel": "小说记忆",
    "memory:script": "剧本记忆",
    "reports:default": "编译报告",
    "library:default": "资料库",
    "index:default": "索引",
  };
  const structuredChoices = structuredGroupsFor(moduleId, viewId).map((group) => ({
    id: structuredGroupLocationId(moduleId, viewId, group.key),
    label: `${labels[`${moduleId}:${viewId}`] ?? "当前板块"} / ${group.label}`,
    options: {
      workspaceView: viewId,
      contextDomain: ["script", "prompts"].includes(viewId) ? "script" : "novel",
      treeGroup: group.key,
    },
  }));
  return appendCustomFolders([
    ...structuredChoices,
    rootLocation(moduleId, viewId, `${labels[`${moduleId}:${viewId}`] ?? "当前板块"} / 根目录`),
  ]);
};

export const resolveFolderLocationChoice = ({ moduleId, viewId = "novel", items = [], documents = {}, folders = [], folderId, workspaceKind = "project" }) => {
  const choices = documentLocationChoices({ moduleId, viewId, items, documents, folders, workspaceKind });
  const tree = buildDocumentTree({ moduleId, viewId, items, documents, folders, workspaceKind });
  const findFolder = (nodes) => {
    for (const node of nodes) {
      if (node.type !== "folder") continue;
      if (node.id === folderId) return node;
      const nested = findFolder(node.children.filter((child) => child.type === "folder"));
      if (nested) return nested;
    }
    return null;
  };
  const node = findFolder(tree);
  if (!node) return null;
  const locationId = node.locationId ?? node.id;
  return choices.find((choice) => choice.id === locationId) ?? null;
};

export const documentLocationId = ({ moduleId, viewId = "novel", options = {}, workspaceKind = "project" }) => {
  if (options.customFolderId) return options.customFolderId;
  if (options.rootPlacement === true) return `${moduleId}:${viewId}:root`;
  if (workspaceKind === "notebook" && !options.folderId && !options.volumeFolder) return `${moduleId}:${viewId}:root`;
  if (moduleId === "outline") return `${viewId === "script" ? "script-outline" : "outline"}:${outlineGroup("", options)}`;
  if (moduleId === "manuscript" && viewId === "novel") return options.folderId ?? `manuscript-volume:${options.volumeFolder ?? DEFAULT_VOLUME.volumeFolder}`;
  if (moduleId === "manuscript" && viewId === "script") return "manuscript:script:scripts";
  if (moduleId === "manuscript" && viewId === "prompts") return `prompts:${options.treeGroup ?? "video"}`;
  if (structuredGroupByKey(moduleId, viewId, options.treeGroup)) return structuredGroupLocationId(moduleId, viewId, options.treeGroup);
  return `${moduleId}:${viewId}:root`;
};
