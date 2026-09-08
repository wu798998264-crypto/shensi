export const STRUCTURE_WORKSPACE_VERSION = 8;
export const STRUCTURED_DOCUMENT_CLASSIFICATION_THRESHOLD = 60_000;

const group = (key, label, documentIds, workspacePath, { expandable = false, legacyLabels = [] } = {}) => ({
  key,
  label,
  documentIds,
  workspacePath,
  expandable,
  legacyLabels,
});

const novelCanonGroups = (root = ["02_正史设定"]) => [
  group("characters", "人物设定", ["canon-characters"], root),
  group("relations", "人物关系", ["canon-relations"], root),
  group("world", "世界观与基础规则", ["canon-world"], root, { legacyLabels: ["世界观"] }),
  group("map", "地图与地点", ["canon-locations"], root, { legacyLabels: ["地图设定", "地点"] }),
  group("factions", "势力与组织", ["canon-factions"], root, { legacyLabels: ["势力设定", "势力"] }),
  group("events", "事件与时间线", ["canon-events"], root, { legacyLabels: ["事件"] }),
  group("items", "物品与道具", ["canon-items"], root, { legacyLabels: ["物品设定", "物品"] }),
  group("glossary", "术语表", ["canon-glossary"], root),
];

const scriptCanonGroups = (root = ["04_正文", "短剧", "剧本设定"]) => [
  group("characters", "人物改编", ["script-canon-characters"], root, { legacyLabels: ["人物设定", "剧本人物设定"] }),
  group("relations", "关系改编", ["script-canon-relations"], root, { legacyLabels: ["人物关系", "剧本人物关系"] }),
  group("world", "世界与规则改编", ["script-canon-world"], root, { legacyLabels: ["世界观", "剧本世界观"] }),
  group("map", "场景与地点改编", ["script-canon-locations"], root, { legacyLabels: ["地点", "剧本地点"] }),
  group("factions", "势力与组织改编", ["script-canon-factions"], root, { legacyLabels: ["势力", "剧本势力"] }),
  group("events", "事件与时间线改编", ["script-canon-events"], root, { legacyLabels: ["事件", "剧本事件"] }),
  group("items", "道具改编", ["script-canon-items"], root, { legacyLabels: ["物品", "剧本物品"] }),
  group("glossary", "剧本术语", ["script-canon-glossary"], root, { legacyLabels: ["术语表", "剧本术语表"] }),
];

export const STRUCTURED_MODULE_GROUPS = {
  canon: {
    novel: novelCanonGroups(),
    script: scriptCanonGroups(),
  },
  memory: {
    novel: [
      group("plot-control", "伏笔与承诺", ["memory-foreshadowing", "outline-series"], ["01_剧情控制"]),
      group("information-ledger", "信息账本", ["memory-information-ledger", "memory-first-appearance", "memory-release", "memory-reader"], ["01_剧情控制"]),
      group("state-snapshot", "状态快照", ["memory-snapshot"], ["03_状态快照"]),
    ],
    script: [
      group("plot-control", "伏笔与承诺", ["script-memory-foreshadowing", "script-outline-series"], ["04_正文", "短剧", "剧本连续性"]),
      group("information-ledger", "信息账本", ["script-memory-information-ledger", "script-memory-first-appearance", "script-memory-release", "script-memory-audience"], ["04_正文", "短剧", "剧本连续性"]),
      group("state-snapshot", "状态快照", ["script-memory-snapshot"], ["04_正文", "短剧", "剧本连续性"]),
    ],
  },
  reports: {
    default: [
      group("novel-check", "小说报告", ["report-novel"], ["07_编译报告"]),
      group("script-check", "剧本报告", ["report-script"], ["07_编译报告"]),
      group("adaptation", "改编报告", ["report-adaptation"], ["07_编译报告"]),
      group("compilation", "编译记录", ["report-compile"], ["07_编译报告"]),
    ],
  },
  library: {
    default: [
      group("references", "参考资料", ["library-reference"], ["08_资料库"], { expandable: true }),
      group("retired", "废弃设定", ["library-retired"], ["08_资料库"], { expandable: true }),
      group("memo", "备忘录", ["library-memo"], ["08_资料库"]),
    ],
  },
  index: {
    default: [
      group("rules", "创作合同", ["index-language-blacklist"], ["09_索引"]),
      group("maintenance", "项目维护", ["index-update-log", "index-pending"], ["09_索引"]),
    ],
  },
};

export const structuredGroupsFor = (moduleId, viewId = "default") => (
  STRUCTURED_MODULE_GROUPS[moduleId]?.[viewId]
  ?? STRUCTURED_MODULE_GROUPS[moduleId]?.default
  ?? []
);

export const structuredGroupForDocument = (moduleId, viewId, documentId) => (
  structuredGroupsFor(moduleId, viewId).find((record) => record.documentIds.includes(documentId)) ?? null
);

const normalizedStructuredSourcePath = (value = "") => String(value)
  .replaceAll("\\", "/")
  .replace(/^\/+|\/+$/g, "")
  .toLowerCase();

export const importedDocumentMatchesStructuredSlot = ({ moduleId, viewId = "default", documentId, sourcePath = "" } = {}) => {
  const groupRecord = structuredGroupForDocument(moduleId, viewId, documentId);
  if (!groupRecord || !sourcePath) return false;
  const expectedPaths = [groupRecord.label, ...(groupRecord.legacyLabels ?? [])]
    .map((label) => [...groupRecord.workspacePath, `${label}.md`].join("/"));
  return expectedPaths.some((expectedPath) => normalizedStructuredSourcePath(sourcePath) === normalizedStructuredSourcePath(expectedPath));
};

export const structuredGroupByKey = (moduleId, viewId, key) => (
  structuredGroupsFor(moduleId, viewId).find((record) => record.key === key) ?? null
);

export const structuredGroupLocationId = (moduleId, viewId, key) => `${moduleId}:${viewId}:group:${key}`;
export const structuredGroupNodeId = (moduleId, viewId, key) => `structured-folder:${moduleId}:${viewId}:${key}`;

export const structuredGroupForWorkspacePath = (moduleId, viewId, relativePath = "") => {
  const normalized = String(relativePath).replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLowerCase();
  const groups = structuredGroupsFor(moduleId, viewId);
  const labeled = groups.find((record) => {
    const prefix = record.workspacePath.join("/").toLowerCase();
    return normalized.startsWith(`${prefix}/${record.label.toLowerCase()}/`);
  });
  if (labeled) return labeled;
  const matching = groups.filter((record) => {
    const prefix = record.workspacePath.join("/").toLowerCase();
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
  const distinctPaths = new Set(matching.map((record) => record.workspacePath.join("/").toLowerCase()));
  return matching.length === 1 && distinctPaths.size === 1 ? matching[0] : null;
};
