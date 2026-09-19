export const HISTORY_SCOPE_VERSION = 4;

const STRUCTURAL_CHANGE = /结构|目录|排序|重命名|移入回收|删除|新建|创建|板块|模块|恢复(?:板块|模块|结构|历史版本)/;
const PROJECT_WIDE_CHANGE = /作品|全书|整体历史|整个项目|跨板块|全部板块|对话退回/;
const MODULE_LABELS = {
  manuscript: "正文",
  outline: "大纲",
  canon: "设定",
  memory: "记忆",
  reports: "编译报告",
  library: "资料库",
  index: "索引",
};
const VIEW_MODULES = new Set(["manuscript", "outline", "canon", "memory"]);
const AGGREGATE_CHANGE = /整体|同步|多分类|跨分类|板块整体/;

const clone = (value) => value == null ? value : structuredClone(value);
const normalizeText = (value = "") => String(value).replace(/[\s·_—-]+/g, "");
const chapterToken = (value = "") => normalizeText(value).match(/第([0-9〇零一二三四五六七八九十百千两]+)章/)?.[1] ?? "";

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const stableStringify = (value) => JSON.stringify(stableValue(value));
const documentContent = (documentState = {}) => ({
  html: documentState.html ?? "",
  markdown: documentState.markdown ?? "",
  continuityDelta: documentState.continuityDelta ?? null,
});
const documentPayload = (documentState = {}) => ({
  title: documentState.title ?? "",
  ...documentContent(documentState),
});

const documentSignature = (entry) => stableStringify(documentContent(entry));
const moduleSignature = (entry, moduleId) => stableStringify({
  documents: Object.fromEntries(Object.entries(entry.documents ?? {}).map(([id, documentState]) => [id, documentPayload(documentState)])),
  moduleItems: entry.moduleItems?.[moduleId] ?? [],
  customFolders: entry.customFolders ?? [],
});
const projectSignature = (entry) => {
  const versionState = entry.state ?? {};
  const documents = versionState.documents ?? entry.documents ?? {};
  return stableStringify({
    documents: Object.fromEntries(Object.entries(documents).map(([id, documentState]) => [id, documentPayload(documentState)])),
    moduleItems: versionState.moduleItems ?? entry.moduleItems ?? {},
    customFolders: versionState.customFolders ?? entry.customFolders ?? [],
  });
};

const dedupe = (entries, signatureForEntry) => {
  const seen = new Set();
  return entries.filter((entry) => {
    const signature = signatureForEntry(entry);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
};

const moduleForDocument = (state, documentId) => {
  const explicit = state.documents?.[documentId]?.moduleId;
  if (explicit) return explicit;
  return Object.entries(state.moduleItems ?? {}).find(([, items]) => items.some(([id]) => id === documentId))?.[0] ?? "library";
};
const itemView = (moduleId, item = []) => item?.[2]?.workspaceView ?? (VIEW_MODULES.has(moduleId) ? "novel" : "default");
const viewForDocument = (state, moduleId, documentId) => itemView(moduleId, state.moduleItems?.[moduleId]?.find(([id]) => id === documentId));
const inferView = (state, moduleId, version) => {
  if (!VIEW_MODULES.has(moduleId) || AGGREGATE_CHANGE.test(version.title ?? "")) return null;
  if (version.viewId) return version.viewId;
  const documentId = findDocument(state, version.title, moduleId);
  if (documentId) return viewForDocument(state, moduleId, documentId);
  const title = version.title ?? "";
  if (moduleId === "manuscript") {
    if (/提示词|视觉资产|调度图/.test(title)) return "prompts";
    if (/剧本|短剧|分集/.test(title)) return "script";
    if (/正文|章节|第.+章/.test(title)) return "novel";
  }
  if (moduleId === "outline") return /剧本|短剧|集纲/.test(title) ? "script" : "novel";
  if (moduleId === "canon") return /剧本/.test(title) ? "script" : "novel";
  if (moduleId === "memory") return /剧本|观众|分集/.test(title) ? "script" : "novel";
  return null;
};

const inferDocumentInModule = (state, moduleId, title, { allowSingleton = false } = {}) => {
  const normalizedTitle = normalizeText(title);
  const items = state.moduleItems?.[moduleId] ?? [];
  const direct = items.find(([id, label]) => {
    const candidates = [label, state.documents?.[id]?.title].filter(Boolean).map(normalizeText).filter((value) => value.length >= 2);
    return candidates.some((candidate) => normalizedTitle.includes(candidate));
  });
  if (direct) return direct[0];

  const token = chapterToken(title);
  if (token) {
    const chapter = items.find(([id, label]) => chapterToken(label || state.documents?.[id]?.title) === token);
    if (chapter) return chapter[0];
  }

  const hints = {
    outline: [
      [/全集|全书/, "outline-series"],
      [/卷纲|第一卷|第二卷|第三卷|第四卷|第五卷/, "outline-volume-1"],
      [/章纲|第[0-9〇零一二三四五六七八九十百千两]+章/, "outline-chapter-6"],
    ],
    canon: [
      [/人物|角色|主角|配角/, "canon-characters"],
      [/术语|词汇|名词解释/, "canon-glossary"],
      [/种族|族群|物种|衍生|特殊设定|特殊机制|概念|规则|法则|约束|基础设定|历法|货币|语言|度量衡|力量体系|能力体系|修炼体系|战力体系|世界观|世界背景/, "canon-world"],
      [/势力|组织|集团/, "canon-factions"],
      [/关系/, "canon-relations"],
      [/地点|地图|场景|城市/, "canon-locations"],
      [/物品|道具/, "canon-items"],
      [/事件|时间线|时间轴/, "canon-events"],
    ],
    memory: [
      [/读者.*知识|知识库/, "memory-reader"],
      [/伏笔/, "memory-foreshadowing"],
      [/登场|首次出现/, "memory-first-appearance"],
      [/释放/, "memory-release"],
      [/状态快照/, "memory-snapshot"],
    ],
    reports: [[/剧本自检/, "report-script"], [/小说自检|正文自检|自检/, "report-novel"], [/改编报告|小说改剧本/, "report-adaptation"], [/编译/, "report-compile"]],
    library: [[/参考资料|资料/, "library-reference"], [/废弃/, "library-retired"]],
    index: [[/待确认/, "index-pending"], [/更新日志/, "index-update-log"], [/创作合同|项目规则|项目禁用词|特别注意事项/, "index-language-blacklist"]],
  };
  const hinted = (hints[moduleId] ?? []).find(([pattern, id]) => pattern.test(title) && state.documents?.[id]);
  if (hinted) return hinted[1];
  if (allowSingleton && items.length === 1) return items[0][0];
  return null;
};

const findDocument = (state, title, preferredModuleId = null) => {
  if (preferredModuleId) {
    const preferred = inferDocumentInModule(state, preferredModuleId, title, { allowSingleton: true });
    if (preferred) return preferred;
  }
  for (const moduleId of Object.keys(state.moduleItems ?? {})) {
    const documentId = inferDocumentInModule(state, moduleId, title);
    if (documentId) return documentId;
  }
  return null;
};

const inferModule = (title) => {
  const rules = [
    ["outline", /大纲|卷纲|章纲|调查线|剧情线|第[一二三四五六七八九十0-9]+卷/],
    ["canon", /设定|人物|角色|世界观|势力|关系|地点|物品|事件|时间线/],
    ["memory", /记忆|伏笔|信息登场|信息释放|读者知识|状态快照|上下文/],
    ["reports", /编译报告|小说自检|编译结果/],
    ["library", /资料库|参考资料|备选方案|废弃设定/],
    ["index", /索引|待确认事项/],
    ["manuscript", /正文|章节|第[0-9〇零一二三四五六七八九十百千两]+章/],
  ];
  return rules.find(([, pattern]) => pattern.test(title))?.[0] ?? null;
};

const versionDocument = (state, version, documentId) => version.state?.documents?.[documentId]
  ?? version.documents?.[documentId]
  ?? state.documents?.[documentId]
  ?? {};
const versionNumber = (version) => String(version ?? "").match(/(\d+)\s*$/)?.[1] ?? "1";

const toDocumentVersion = (state, version, documentId) => ({
  id: version.id,
  title: version.title,
  version: /^v\d+$/i.test(version.version ?? "") ? version.version : `v${versionNumber(version.version)}`,
  time: version.time,
  ...documentContent(versionDocument(state, version, documentId)),
  scopeType: "document",
  scopeId: documentId,
});

const toModuleVersion = (state, version, moduleId) => {
  const versionState = version.state ?? {};
  const sourceDocuments = versionState.documents ?? version.documents ?? state.documents ?? {};
  const moduleItems = clone(versionState.moduleItems?.[moduleId] ?? version.moduleItems?.[moduleId] ?? state.moduleItems?.[moduleId] ?? []);
  const documents = Object.fromEntries(moduleItems.filter(([id]) => sourceDocuments[id]).map(([id]) => [id, clone(sourceDocuments[id])]));
  return {
    id: version.id,
    title: version.title,
    version: `${MODULE_LABELS[moduleId] ?? "板块"}快照 ${versionNumber(version.version)}`,
    time: version.time,
    documents,
    moduleItems: { [moduleId]: moduleItems },
    scopeType: "module",
    scopeId: moduleId,
  };
};

const toViewVersion = (state, version, moduleId, viewId) => {
  const versionState = version.state ?? {};
  const sourceDocuments = versionState.documents ?? version.documents ?? state.documents ?? {};
  const sourceItems = clone(versionState.moduleItems?.[moduleId] ?? version.moduleItems?.[moduleId] ?? state.moduleItems?.[moduleId] ?? []);
  const moduleItems = sourceItems.filter((item) => itemView(moduleId, item) === viewId);
  const documents = Object.fromEntries(moduleItems
    .filter(([id, , options = {}]) => !options.alias && sourceDocuments[id])
    .map(([id]) => [id, clone(sourceDocuments[id])]));
  const key = `${moduleId}:${viewId}`;
  return {
    id: version.id,
    title: version.title,
    version: version.version,
    time: version.time,
    documents,
    moduleItems: { [moduleId]: moduleItems },
    scopeType: "view",
    scopeId: key,
    moduleId,
    viewId,
  };
};

const toProjectVersion = (state, version) => ({
  ...clone(version),
  version: `作品快照 ${versionNumber(version.version)}`,
  documents: clone(version.documents ?? version.state?.documents ?? state.documents ?? {}),
  scopeType: "project",
  scopeId: "project",
});

export const isStructuralHistoryTitle = (title = "") => STRUCTURAL_CHANGE.test(title);
export const isProjectWideHistoryTitle = (title = "") => PROJECT_WIDE_CHANGE.test(title);

export const historyEntryMatchesScope = (entry, scope) => {
  if (!entry?.scopeType) return true;
  if (entry.scopeType !== scope.type) return false;
  return scope.type === "project" || entry.scopeId === scope.id;
};

export const migrateHistoryScopes = (state) => {
  state.volumeHistories ??= {};
  state.currentVersionMeta ??= {};
  state.currentVersionMeta.volumes ??= {};
  if ((state.historyScopeVersion ?? 0) >= HISTORY_SCOPE_VERSION) return { changed: false, moved: 0, removedDuplicates: 0 };
  const startingVersion = state.historyScopeVersion ?? 0;
  state.documents ??= {};
  state.moduleItems ??= {};
  state.histories ??= {};
  state.viewHistories ??= {};
  state.moduleHistories ??= {};
  state.projectHistories ??= [];
  state.currentVersionMeta.views ??= {};

  let moved = 0;
  let beforeCount = state.projectHistories.length;
  for (const versions of Object.values(state.histories)) beforeCount += versions.length;
  for (const versions of Object.values(state.viewHistories)) beforeCount += versions.length;
  for (const versions of Object.values(state.moduleHistories)) beforeCount += versions.length;

  if (startingVersion < 2) {
  for (const [documentId, versions] of Object.entries(state.histories)) {
    state.histories[documentId] = versions.map((version) => toDocumentVersion(state, version, documentId));
  }

  for (const [moduleId, versions] of Object.entries(state.moduleHistories)) {
    const retained = [];
    for (const version of versions) {
      const documentId = findDocument(state, version.title, moduleId);
      if (documentId && !isStructuralHistoryTitle(version.title)) {
        state.histories[documentId] ??= [];
        state.histories[documentId].push(toDocumentVersion(state, version, documentId));
        moved += 1;
      } else {
        retained.push(toModuleVersion(state, version, moduleId));
      }
    }
    state.moduleHistories[moduleId] = retained;
  }

  const retainedProjects = [];
  for (const version of state.projectHistories) {
    const title = version.title ?? "";
    if (isProjectWideHistoryTitle(title)) {
      retainedProjects.push(toProjectVersion(state, version));
      continue;
    }
    const documentId = findDocument(state, title);
    if (documentId) {
      if (isStructuralHistoryTitle(title)) {
        const moduleId = moduleForDocument(state, documentId);
        state.moduleHistories[moduleId] ??= [];
        state.moduleHistories[moduleId].push(toModuleVersion(state, version, moduleId));
      } else {
        state.histories[documentId] ??= [];
        state.histories[documentId].push(toDocumentVersion(state, version, documentId));
      }
      moved += 1;
      continue;
    }
    const moduleId = inferModule(title);
    if (moduleId) {
      state.moduleHistories[moduleId] ??= [];
      state.moduleHistories[moduleId].push(toModuleVersion(state, version, moduleId));
      moved += 1;
      continue;
    }
    retainedProjects.push(toProjectVersion(state, version));
  }
  state.projectHistories = retainedProjects;

  for (const [documentId, versions] of Object.entries(state.histories)) {
    state.histories[documentId] = dedupe(versions, documentSignature);
  }
  for (const [moduleId, versions] of Object.entries(state.moduleHistories)) {
    state.moduleHistories[moduleId] = dedupe(versions, (version) => moduleSignature(version, moduleId));
  }
  state.projectHistories = dedupe(state.projectHistories, projectSignature);

  const moduleMetadata = state.currentVersionMeta?.modules ?? {};
  for (const [moduleId, metadata] of Object.entries(moduleMetadata)) {
    if (findDocument(state, metadata?.title, moduleId) && !isStructuralHistoryTitle(metadata?.title)) delete moduleMetadata[moduleId];
  }
  if (state.currentVersionMeta?.project && !isProjectWideHistoryTitle(state.currentVersionMeta.project.title)) {
    state.currentVersionMeta.project = null;
  }
  }

  if (startingVersion < 4) {
    for (const [moduleId, versions] of Object.entries(state.moduleHistories)) {
      if (!VIEW_MODULES.has(moduleId)) continue;
      const retained = [];
      for (const version of versions) {
        const viewId = inferView(state, moduleId, version);
        if (!viewId) {
          retained.push(version);
          continue;
        }
        const key = `${moduleId}:${viewId}`;
        state.viewHistories[key] ??= [];
        state.viewHistories[key].push(toViewVersion(state, version, moduleId, viewId));
        moved += 1;
      }
      state.moduleHistories[moduleId] = retained;
    }
    for (const [moduleId, metadata] of Object.entries(state.currentVersionMeta.modules ?? {})) {
      const viewId = inferView(state, moduleId, metadata ?? {});
      if (!viewId) continue;
      state.currentVersionMeta.views[`${moduleId}:${viewId}`] = clone(metadata);
      delete state.currentVersionMeta.modules[moduleId];
    }
  }

  for (const [key, versions] of Object.entries(state.viewHistories)) {
    const [moduleId, viewId] = key.split(":");
    state.viewHistories[key] = versions.map((version) => ({
      ...clone(version),
      scopeType: "view",
      scopeId: key,
      moduleId: version.moduleId ?? moduleId,
      viewId: version.viewId ?? viewId,
    }));
  }

  let afterCount = state.projectHistories.length;
  for (const versions of Object.values(state.histories)) afterCount += versions.length;
  for (const [key, versions] of Object.entries(state.viewHistories)) {
    const [moduleId] = key.split(":");
    state.viewHistories[key] = dedupe(versions, (version) => moduleSignature(version, moduleId));
    afterCount += state.viewHistories[key].length;
  }
  for (const versions of Object.values(state.moduleHistories)) afterCount += versions.length;
  state.historyScopeVersion = HISTORY_SCOPE_VERSION;
  return { changed: true, moved, removedDuplicates: Math.max(0, beforeCount - afterCount) };
};

// Manual version saving compares the complete user-visible document snapshot.
// A title-only edit is a real version change just like punctuation, Markdown,
// rich-text formatting or continuity metadata.
export const sameDocumentHistoryContent = (left, right) => (
  stableStringify(documentPayload(left?.document && typeof left.document === "object" ? left.document : left))
  === stableStringify(documentPayload(right?.document && typeof right.document === "object" ? right.document : right))
);
export const matchingDocumentHistoryIndex = (entries = [], candidate = {}) => (
  (Array.isArray(entries) ? entries : []).findIndex((entry) => sameDocumentHistoryContent(entry, candidate))
);
export const sameViewHistoryContent = (left, right, moduleId) => moduleSignature(left, moduleId) === moduleSignature(right, moduleId);
export const sameModuleHistoryContent = (left, right, moduleId) => moduleSignature(left, moduleId) === moduleSignature(right, moduleId);
export const sameProjectHistoryContent = (left, right) => projectSignature(left) === projectSignature(right);
