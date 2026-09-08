const MEMORY_DOCUMENTS = Object.freeze({
  "memory-foreshadowing": { title: "伏笔管理", contextDomain: "novel", workspaceView: "novel", treeGroup: "plot-control" },
  "memory-information-ledger": { title: "信息账本", contextDomain: "novel", workspaceView: "novel", treeGroup: "information-ledger", mergedView: true },
  "memory-first-appearance": { title: "重要信息登场账本", contextDomain: "novel", workspaceView: "novel", treeGroup: "plot-control", legacyProjection: true, hiddenWhenCanonical: "memory-information-ledger" },
  "memory-release": { title: "信息释放表", contextDomain: "novel", workspaceView: "novel", treeGroup: "plot-control", legacyProjection: true, hiddenWhenCanonical: "memory-information-ledger" },
  "memory-reader": { title: "读者当前知识库", contextDomain: "novel", workspaceView: "novel", treeGroup: "plot-control", legacyProjection: true, hiddenWhenCanonical: "memory-information-ledger" },
  "memory-snapshot": { title: "状态快照", contextDomain: "novel", workspaceView: "novel", treeGroup: "state-snapshot" },
  "script-memory-foreshadowing": { title: "伏笔管理", contextDomain: "script", workspaceView: "script", treeGroup: "plot-control" },
  "script-memory-information-ledger": { title: "信息账本", contextDomain: "script", workspaceView: "script", treeGroup: "information-ledger", mergedView: true },
  "script-memory-first-appearance": { title: "重要信息登场账本", contextDomain: "script", workspaceView: "script", treeGroup: "plot-control", legacyProjection: true, hiddenWhenCanonical: "script-memory-information-ledger" },
  "script-memory-release": { title: "信息释放表", contextDomain: "script", workspaceView: "script", treeGroup: "plot-control", legacyProjection: true, hiddenWhenCanonical: "script-memory-information-ledger" },
  "script-memory-audience": { title: "观众当前知识库", contextDomain: "script", workspaceView: "script", treeGroup: "plot-control", legacyProjection: true, hiddenWhenCanonical: "script-memory-information-ledger" },
  "script-memory-snapshot": { title: "状态快照", contextDomain: "script", workspaceView: "script", treeGroup: "state-snapshot" },
});

export const NOVEL_INFORMATION_LEDGER_DOCUMENT_ID = "memory-information-ledger";
export const SCRIPT_INFORMATION_LEDGER_DOCUMENT_ID = "script-memory-information-ledger";

export const memoryProjectionDocumentIds = ({ script = false } = {}) => script
  ? ["script-memory-snapshot", "script-memory-foreshadowing", SCRIPT_INFORMATION_LEDGER_DOCUMENT_ID, "script-memory-first-appearance", "script-memory-release", "script-memory-audience"]
  : ["memory-snapshot", "memory-foreshadowing", NOVEL_INFORMATION_LEDGER_DOCUMENT_ID, "memory-first-appearance", "memory-release", "memory-reader"];

export const runtimeMemoryDocumentSpec = (documentId = "") => MEMORY_DOCUMENTS[String(documentId)] ?? null;

export const ensureRuntimeMemoryDocuments = ({ state, documentIds = [], updatedAt = "刚刚" } = {}) => {
  if (!state || state.workspaceKind !== "project") return [];
  state.documents ??= {};
  state.moduleItems ??= {};
  state.moduleItems.memory ??= [];
  state.histories ??= {};
  const created = [];
  for (const documentId of [...new Set(documentIds.map(String).filter(Boolean))]) {
    const spec = runtimeMemoryDocumentSpec(documentId);
    if (!spec) continue;
    const options = {
      workspaceView: spec.workspaceView,
      contextDomain: spec.contextDomain,
      treeGroup: spec.treeGroup,
      ...(spec.mergedView ? { mergedMemoryView: true } : {}),
      ...(spec.legacyProjection ? { legacyMemoryProjection: true } : {}),
    };
    if (!state.moduleItems.memory.some(([id]) => id === documentId)) {
      state.moduleItems.memory.push([documentId, spec.title, options]);
    }
    if (state.documents[documentId]) continue;
    state.documents[documentId] = {
      title: spec.title,
      html: "",
      updatedAt,
      moduleId: "memory",
      documentKind: "document",
      systemGeneratedTitle: true,
      titleLanguage: state.structureLanguage || "zh-CN",
      ...options,
    };
    state.histories[documentId] ??= [];
    created.push(documentId);
  }
  // Keep historical projections addressable while showing one merged ledger
  // in the primary memory directory after it has been materialized.
  for (const [legacyId, spec] of Object.entries(MEMORY_DOCUMENTS)) {
    if (!spec.hiddenWhenCanonical || !state.documents[spec.hiddenWhenCanonical]) continue;
    const item = state.moduleItems.memory.find(([id]) => id === legacyId);
    if (item) item[2] = { ...(item[2] ?? {}), legacyMemoryProjection: true, hiddenFromDirectory: true };
  }
  return created;
};

export const memoryDocumentIsLegacyProjection = (documentId = "") => Boolean(MEMORY_DOCUMENTS[String(documentId)]?.legacyProjection);
