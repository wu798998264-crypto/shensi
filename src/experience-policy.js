export const EXPERIENCE_STORE_SCHEMA_VERSION = 3;
export const EXPERIENCE_KINDS = Object.freeze(["method", "style_preference", "avoidance"]);
export const EXPERIENCE_SCOPE_LEVELS = Object.freeze(["project", "series", "genre", "author"]);
export const EXPERIENCE_FEEDBACK_OUTCOMES = Object.freeze(["helpful", "not_applicable", "harmful", "ignored"]);
export const EXPERIENCE_RECORD_STATUSES = Object.freeze(["observed", "validated", "active", "mature", "clustered", "revoked"]);
export const EXPERIENCE_PROMOTION_STATUSES = Object.freeze(["not_eligible", "eligible", "skill_draft", "tested", "manually_bound", "active_in_template", "dismissed"]);
export const EXPERIENCE_RECALL_STAGES = Object.freeze(["guidance", "planning", "creative", "effect_review", "revision"]);
export const EXPERIENCE_MAX_RECALL_ITEMS = 5;
export const EXPERIENCE_MAX_RECALL_CHARACTERS = 4_000;

const list = (value) => Array.isArray(value) ? value : [];
const unique = (values) => [...new Set(values.filter(Boolean))];
const textValue = (value, max = 240) => String(value ?? "").replace(/\0/g, "").trim().slice(0, max);

const fingerprintEntry = (value = {}) => ({
  id: textValue(value?.id || value?.skillId || value?.theorySkillId, 180),
  version: textValue(value?.version, 80),
  fingerprint: textValue(value?.fingerprint || value?.hash, 128),
});

export const normalizeTaskEnvelope = (value = {}, defaults = {}) => {
  const source = { ...defaults, ...value };
  const normalized = {
    accountId: textValue(source.accountId || "local", 160) || "local",
    workspaceId: textValue(source.workspaceId, 180),
    projectId: textValue(source.projectId, 180),
    seriesId: textValue(source.seriesId, 180),
    taskId: textValue(source.taskId, 180),
    runId: textValue(source.runId, 180),
    conversationId: textValue(source.conversationId, 180),
    branchId: textValue(source.branchId, 180),
    documentId: textValue(source.documentId, 180),
    documentRevision: textValue(source.documentRevision, 180),
    taskType: textValue(source.taskType, 120),
    stage: textValue(source.stage, 80),
    deliverableType: textValue(source.deliverableType, 120),
    contextDomain: textValue(source.contextDomain || "general", 120) || "general",
    templateId: textValue(source.templateId, 180),
    templateRevision: textValue(source.templateRevision, 180),
    templateHash: textValue(source.templateHash, 128),
    selectedSkills: unique(list(source.selectedSkills).map((item) => JSON.stringify(fingerprintEntry(item))))
      .map((item) => JSON.parse(item)).filter((item) => item.id).slice(0, 64),
    theorySources: unique(list(source.theorySources).map((item) => JSON.stringify(fingerprintEntry(item))))
      .map((item) => JSON.parse(item)).filter((item) => item.id).slice(0, 64),
    adoptedArtifactHash: textValue(source.adoptedArtifactHash, 128),
    adoptedAt: textValue(source.adoptedAt, 64),
  };
  return Object.freeze({
    ...normalized,
    selectedSkills: Object.freeze(normalized.selectedSkills.map((item) => Object.freeze(item))),
    theorySources: Object.freeze(normalized.theorySources.map((item) => Object.freeze(item))),
  });
};

export const experienceAdoptionIdempotencyKey = (envelope = {}) => {
  const normalized = normalizeTaskEnvelope(envelope);
  return [normalized.accountId, normalized.runId, normalized.documentRevision, normalized.adoptedArtifactHash].join("\u0000");
};

export const normalizeExperienceFacets = (value = {}, fallback = {}) => ({
  topics: unique(list(value?.topics ?? fallback?.topics).map((item) => textValue(item, 100))).slice(0, 32),
  stages: unique(list(value?.stages ?? fallback?.stages).map((item) => textValue(item, 80)))
    .filter((item) => EXPERIENCE_RECALL_STAGES.includes(item)).slice(0, 12),
  capabilities: unique(list(value?.capabilities ?? fallback?.capabilities).map((item) => textValue(item, 120))).slice(0, 24),
  deliverableType: textValue(value?.deliverableType || fallback?.deliverableType, 120),
  contextDomain: textValue(value?.contextDomain || fallback?.contextDomain || "general", 120) || "general",
  taskType: textValue(value?.taskType || fallback?.taskType, 120),
});

export const normalizeExperienceProvenance = (value = {}, envelope = {}) => ({
  adoptionEventId: textValue(value?.adoptionEventId, 180),
  workspaceId: textValue(value?.workspaceId || envelope?.workspaceId, 180),
  projectId: textValue(value?.projectId || envelope?.projectId, 180),
  seriesId: textValue(value?.seriesId || envelope?.seriesId, 180),
  documentId: textValue(value?.documentId || envelope?.documentId, 180),
  taskId: textValue(value?.taskId || envelope?.taskId, 180),
  runId: textValue(value?.runId || envelope?.runId, 180),
  templateId: textValue(value?.templateId || envelope?.templateId, 180),
  templateRevision: textValue(value?.templateRevision || envelope?.templateRevision, 180),
  templateHash: textValue(value?.templateHash || envelope?.templateHash, 128),
  theorySources: list(value?.theorySources ?? envelope?.theorySources).map(fingerprintEntry).filter((item) => item.id).slice(0, 64),
});

export const experienceStageAllows = (record = {}, stage = "") => {
  const normalizedStage = textValue(stage, 80);
  const stages = list(record?.facets?.stages);
  if (!normalizedStage || !stages.length) return true;
  if (stages.includes(normalizedStage)) return true;
  if (record?.kind === "avoidance" && normalizedStage === "planning") return stages.includes("effect_review") || stages.includes("revision");
  return false;
};

export const normalizeExperienceKind = (value) => EXPERIENCE_KINDS.includes(value) ? value : "method";

export const normalizeExperienceScope = (value = {}, {
  fallbackLevel = "genre",
  fallbackScopeId = "general",
  fallbackLabel = "通用",
  needsReview = false,
} = {}) => {
  const level = EXPERIENCE_SCOPE_LEVELS.includes(value?.level) ? value.level
    : EXPERIENCE_SCOPE_LEVELS.includes(fallbackLevel) ? fallbackLevel : "genre";
  const scopeId = textValue(value?.scopeId || fallbackScopeId, 180) || "general";
  return {
    level,
    scopeId,
    label: textValue(value?.label || fallbackLabel || scopeId, 120) || scopeId,
    needsReview: value?.needsReview === true || needsReview === true,
  };
};

export const normalizeExperienceApplicability = (value = {}, fallback = {}) => ({
  lane: textValue(value?.lane || fallback?.lane || "general", 120) || "general",
  deliverableType: textValue(value?.deliverableType || fallback?.deliverableType, 80),
  contextDomain: textValue(value?.contextDomain || fallback?.contextDomain || "general", 80) || "general",
  tags: unique(list(value?.tags).map((item) => textValue(item, 80))).slice(0, 24),
});

export const experienceScopeMatches = (recordScope = {}, queryScope = {}) => {
  const level = EXPERIENCE_SCOPE_LEVELS.includes(recordScope?.level) ? recordScope.level : "genre";
  const wanted = textValue(recordScope?.scopeId, 180);
  if (!wanted) return false;
  if (level === "project") {
    const projectIds = unique([queryScope?.projectId, ...list(queryScope?.projectIds)].map((item) => textValue(item, 180)));
    return projectIds.includes(wanted);
  }
  if (level === "series") return wanted === textValue(queryScope?.seriesId, 180);
  if (level === "genre") return wanted === textValue(queryScope?.genreId || queryScope?.contextDomain || "general", 180);
  return wanted === textValue(queryScope?.authorId || "local", 180);
};

export const experienceScopeScore = (recordScope = {}, queryScope = {}) => {
  if (!experienceScopeMatches(recordScope, queryScope)) return 0;
  return ({ project: 1, series: 0.82, genre: 0.64, author: 0.46 })[recordScope.level] || 0.4;
};

export const experienceFeedbackScore = (usage = {}) => {
  const helpful = Math.max(0, Number(usage.helpfulCount) || 0);
  const notApplicable = Math.max(0, Number(usage.notApplicableCount) || 0);
  const harmful = Math.max(0, Number(usage.harmfulCount) || 0);
  if (harmful > 0) return -1;
  const total = helpful + notApplicable;
  return total ? Math.max(-0.5, Math.min(1, (helpful - notApplicable * 0.6) / total)) : 0;
};

export const experienceRecallRank = ({
  semanticScore = 0,
  scopeScore = 0,
  applicabilityScore = 0,
  feedbackScore = 0,
  kind = "method",
} = {}) => {
  const avoidanceBoost = kind === "avoidance" ? 0.025 : 0;
  return Math.max(0, Number(semanticScore) || 0) * 0.6
    + Math.max(0, Number(scopeScore) || 0) * 0.2
    + Math.max(0, Number(applicabilityScore) || 0) * 0.1
    + Math.max(-1, Math.min(1, Number(feedbackScore) || 0)) * 0.1
    + avoidanceBoost;
};

export const experiencePromotionEligibility = (record = {}) => {
  const usage = record?.usage ?? {};
  const recalledTaskCount = Math.max(0, Number(usage.recalledTaskCount) || list(usage.recentTaskIds).length);
  const helpfulCount = Math.max(0, Number(usage.helpfulCount) || 0);
  const harmfulCount = Math.max(0, Number(usage.harmfulCount) || 0);
  const reasons = [];
  if (record?.status === "revoked") reasons.push("经验已停止使用");
  if (["skill_draft", "tested", "manually_bound", "active_in_template"].includes(record?.promotion?.status)) reasons.push("已经整理为 Skill 草稿");
  if (recalledTaskCount < 3) reasons.push("至少需要在 3 个不同任务中被召回");
  if (helpfulCount < 2) reasons.push("至少需要 2 次明确的有帮助反馈");
  if (harmfulCount > 0) reasons.push("存在有害反馈，必须先复核经验");
  const latest = list(record?.versions).at(-1) ?? record;
  if (!list(latest?.conditions).length) reasons.push("需要明确适用条件");
  if (!list(latest?.exclusions).length) reasons.push("需要明确禁用条件");
  if (record?.scope?.needsReview === true || record?.migration?.needsReview === true) reasons.push("经验分类或作用域仍待复核");
  return { eligible: reasons.length === 0, reasons, recalledTaskCount, helpfulCount, harmfulCount };
};

const reachableTemplateModules = (capabilityTemplate = {}) => {
  const groups = new Map(list(capabilityTemplate.groups).map((group) => [group.id, group]));
  const modules = new Map(list(capabilityTemplate.modules).map((module) => [module.id, module]));
  const reachable = [];
  const visitedGroups = new Set();
  const visitedModules = new Set();
  const stack = list(capabilityTemplate.template?.items).map((item) => ({ type: item.targetType, id: item.targetId }));
  while (stack.length) {
    const current = stack.pop();
    if (current.type === "module") {
      if (visitedModules.has(current.id)) continue;
      visitedModules.add(current.id);
      const module = modules.get(current.id);
      if (module) reachable.push(module);
      continue;
    }
    if (visitedGroups.has(current.id)) continue;
    visitedGroups.add(current.id);
    for (const item of list(groups.get(current.id)?.items)) stack.push({ type: item.targetType, id: item.targetId });
  }
  return reachable;
};

export const experienceActivationStatus = (routeTopology = {}) => {
  const capabilityTemplate = routeTopology?.capabilityTemplate ?? routeTopology;
  const modules = reachableTemplateModules(capabilityTemplate);
  const experienceModules = modules.filter((module) => list(module.slots).some((slot) => (
    list(slot.capabilities).includes("experience_advisor") || list(slot.capabilities).includes("experience_observer")
  )));
  const readySlots = experienceModules.flatMap((module) => list(module.slots).map((slot) => ({ module, slot })))
    .filter(({ slot }) => Boolean(slot.skillId || slot.fixedSlotId));
  const advisor = readySlots.some(({ slot }) => list(slot.capabilities).includes("experience_advisor"));
  const observer = readySlots.some(({ slot }) => list(slot.capabilities).includes("experience_observer"));
  const mode = advisor && observer ? "learn_and_recall" : advisor ? "recall_only" : observer ? "learn_only" : "inactive";
  return {
    advisor,
    observer,
    mode,
    workspaceModes: unique(experienceModules.flatMap((module) => list(module.workspaceModes))).sort(),
    deliverableTypes: unique(experienceModules.flatMap((module) => list(module.deliverableTypes))).sort(),
    moduleIds: experienceModules.map((module) => module.id).sort(),
  };
};
