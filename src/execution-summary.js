export const executionDocumentSummary = (execution = {}) => {
  const documents = Array.isArray(execution.contextDocuments)
    ? [...new Set(execution.contextDocuments.map((item) => typeof item === "string" ? item : item?.title || item?.name || item?.id).filter(Boolean))]
    : [];
  if (documents.length) {
    return `${documents.slice(0, 4).join("、")}${documents.length > 4 ? " 等" : ""}`;
  }
  if (execution.resourceCount) return "已纳入本轮明确选择的资料";
  if (execution.strength === "general") return "未读取作品文档";
  if (execution.strength === "operation") return "仅读取结构清单和可能相关的当前文档";
  return "已读取当前有效内容";
};

export const executionSkillSummary = ({ runtimeSkills = [], plannedSkillNames = [] } = {}) => {
  const actual = [...new Set((Array.isArray(runtimeSkills) ? runtimeSkills : [])
    .map((skill) => typeof skill === "string" ? skill : skill?.name || skill?.id)
    .filter(Boolean))];
  const planned = [...new Set((Array.isArray(plannedSkillNames) ? plannedSkillNames : []).filter(Boolean))];
  const names = actual.length ? actual : planned;
  if (!names.length) return "";
  return `${actual.length ? "" : "计划："}${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}`;
};

const readSourceKey = (source = {}) => String(source.id || source.name || source.title || "").trim();
const readSourceName = (source = {}, fallback = "未命名来源") => String(source.title || source.name || source.id || fallback).trim();
const readModeLabel = (source = {}) => {
  if (source.reused === true || source.readMode === "snapshot") return "复用已核验快照";
  if (source.compressed === true) return "全文压缩读取";
  if (source.readMode === "full" || source.fullText === true) return "全文读取";
  if (source.readMode === "delta") return "差异读取";
  if (source.readMode === "excerpt") return "摘录读取";
  return "已读取";
};

const mergeReadSource = (map, source, kind, stage = "") => {
  const key = readSourceKey(source);
  if (!key) return;
  const previous = map.get(key) || {
    id: String(source.id || key),
    name: readSourceName(source),
    title: readSourceName(source),
    kind,
    stages: [],
  };
  const next = {
    ...previous,
    id: previous.id || String(source.id || key),
    name: previous.name || readSourceName(source),
    title: previous.title || readSourceName(source),
    kind,
    ...(source.version ? { version: String(source.version) } : {}),
    ...(source.readMode ? { readMode: String(source.readMode) } : {}),
    ...(source.compressed === true ? { compressed: true } : {}),
    ...(source.fullText === true ? { fullText: true } : {}),
    ...(source.reused === true ? { reused: true } : {}),
    ...(Number(source.sourceCharacters) > 0 ? { sourceCharacters: Number(source.sourceCharacters) } : {}),
    ...(Number(source.chunksRead) > 0 ? { chunksRead: Number(source.chunksRead) } : {}),
    ...(source.readAt ? { readAt: String(source.readAt) } : {}),
    stages: [...new Set([...(previous.stages || []), stage || ""])].filter(Boolean),
  };
  map.set(key, next);
};

const normalizeReadEvent = (event = {}) => ({
  stage: String(event.stage || "当前阶段"),
  startedAt: String(event.startedAt || ""),
  completedAt: String(event.completedAt || ""),
  reusedSnapshot: event.reusedSnapshot === true,
  documents: (Array.isArray(event.documents) ? event.documents : []).map((item) => ({ ...item, kind: "document" })),
  skills: (Array.isArray(event.skills) ? event.skills : []).map((item) => ({ ...item, kind: "skill" })),
});

// Produces the single UI contract used by Chat and Agent cards. Planned
// sources are advisory; actual sources only come from verified model-input
// events or execution receipts.
export const buildExecutionContextReadState = ({
  status = "running",
  currentStage = "",
  plannedDocuments = [],
  plannedSkills = [],
  readEvents = [],
  actualDocuments = [],
  actualSkills = [],
} = {}) => {
  const plannedDocumentMap = new Map();
  const plannedSkillMap = new Map();
  const actualDocumentMap = new Map();
  const actualSkillMap = new Map();
  const stageEvents = [];
  (Array.isArray(plannedDocuments) ? plannedDocuments : []).forEach((item) => mergeReadSource(plannedDocumentMap, item, "document", item.stage || "规划"));
  (Array.isArray(plannedSkills) ? plannedSkills : []).forEach((item) => mergeReadSource(plannedSkillMap, item, "skill", item.stage || "规划"));
  (Array.isArray(actualDocuments) ? actualDocuments : []).forEach((item) => mergeReadSource(actualDocumentMap, item, "document", item.stage || ""));
  (Array.isArray(actualSkills) ? actualSkills : []).forEach((item) => mergeReadSource(actualSkillMap, item, "skill", item.stage || ""));
  (Array.isArray(readEvents) ? readEvents : []).forEach((rawEvent) => {
    const event = normalizeReadEvent(rawEvent);
    const documents = [];
    const skills = [];
    event.documents.forEach((item) => {
      const source = { ...item, title: readSourceName(item), stage: event.stage };
      documents.push(source);
      mergeReadSource(actualDocumentMap, source, "document", event.stage);
    });
    event.skills.forEach((item) => {
      const source = { ...item, name: readSourceName(item), title: readSourceName(item), stage: event.stage };
      skills.push(source);
      mergeReadSource(actualSkillMap, source, "skill", event.stage);
    });
    stageEvents.push({ ...event, documents, skills });
  });
  const locked = !["", "running", "starting", "preparing"].includes(String(status || ""));
  return {
    version: 1,
    status: String(status || "running"),
    currentStage: String(currentStage || ""),
    locked,
    planned: {
      documents: [...plannedDocumentMap.values()],
      skills: [...plannedSkillMap.values()],
    },
    actual: {
      documents: [...actualDocumentMap.values()],
      skills: [...actualSkillMap.values()],
    },
    stages: stageEvents,
  };
};

export { readModeLabel };

export const executionContextLoopSummary = (execution = {}) => {
  const rounds = Math.max(0, Number(execution.contextRounds) || 0);
  if (!rounds && !Number(execution.requestedNeedCount) && !(execution.unresolvedNeeds?.length)) return "";
  const requested = Math.max(0, Number(execution.requestedNeedCount) || 0);
  const fulfilled = Math.max(0, Number(execution.fulfilledNeedCount) || 0);
  const unresolved = Array.isArray(execution.unresolvedNeeds) ? execution.unresolvedNeeds.length : 0;
  const namedSources = Array.isArray(execution.includedSources) ? execution.includedSources : [];
  const ids = [...new Set((namedSources.length ? namedSources : (Array.isArray(execution.includedSourceIds) ? execution.includedSourceIds : []))
    .map((item) => String(typeof item === "string" ? item : item?.name || item?.title || item?.id || "").trim())
    .filter(Boolean))]
    .slice(0, 8);
  return [
    `补读 ${rounds} 轮`,
    `请求 ${requested} 项，找到 ${fulfilled} 项，未解决 ${unresolved} 项`,
    ids.length ? `使用 ${ids.join("、")}` : "",
    execution.contextTruncated ? "部分资料已按预算截取" : "",
  ].filter(Boolean).join("；");
};
