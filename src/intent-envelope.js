import { indexWriteTargetForScenario } from "./index-policy.js";

const clean = (value = "") => String(value ?? "").trim();
const unique = (values = []) => [...new Set((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean))];
const clipped = (value = "", limit = 240) => clean(value).slice(0, limit);
const REVIEW_SOURCE_REFERENCE_PATTERN = /(?:读取|阅读|查看|打开|根据|依据|结合|参考).{0,32}(?:(?:小说|剧本|短剧|漫剧|改编)?(?:自检|编译|改编)报告)/u;
const CONTENT_MUTATION_PATTERN = /(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|续写|扩写|压缩|增补|补写).{0,20}(?:正文|章节|本章|稿件|文稿|剧本|单集)|(?:正文|章节|本章|稿件|文稿|剧本|单集).{0,20}(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|续写|扩写|压缩|增补|补写)/u;

const inferredDeliverableKind = (targetDocumentId = "") => {
  const id = clean(targetDocumentId);
  if (/^report-(?:novel|script|adaptation)$/.test(id)) return "review_report";
  if (/^chapter-\d+$/.test(id)) return "prose";
  if (/^script-episode-\d+$/.test(id)) return "script_prose";
  if (/^(?:outline|script-outline)-/.test(id)) return "outline";
  if (/^(?:canon|script-canon)-/.test(id)) return "setting";
  if (/^(?:memory|script-memory)-/.test(id)) return "memory";
  if (/^prompt-/.test(id)) return "visual_prompt";
  return "document";
};

const deliverableKindFor = (targetDocumentId = "", routeKind = "", explicitKind = "") => (
  clean(explicitKind) || inferredDeliverableKind(targetDocumentId) !== "document"
    ? clean(explicitKind) || inferredDeliverableKind(targetDocumentId)
    : clean(routeKind) || "document"
);

export const INTENT_ENVELOPE_SCHEMA_VERSION = 1;

export const INTENT_TASK_TYPES = Object.freeze([
  "writing",
  "planning",
  "modification",
  "testing",
  "diagnosis",
  "export",
  "operation",
  "discussion",
]);

export const INTENT_WRITE_MODES = Object.freeze([
  "formal_auto",
  "confirm_required",
  "conversation_only",
]);

const taskTypeFor = ({ route = {}, taskContract = null, reviewDelivery = null, instruction = "" } = {}) => {
  const source = clean(instruction);
  if (taskContract?.taskType && INTENT_TASK_TYPES.includes(clean(taskContract.taskType))) return clean(taskContract.taskType);
  if (route.semanticAuthority === true) {
    const taskKind = clean(route.taskKind);
    if (taskKind === "quality_review") return "diagnosis";
    if (taskKind === "content_creation") return "writing";
    if (taskKind === "content_revision") return "modification";
    if (taskKind === "workspace_operation") return "operation";
    if (taskKind === "creative_guidance") return "planning";
    if (route.mode === "workspace_operation" || route.mode === "operation") return "operation";
    if (route.mode === "quick_revision" || route.revisionIntent === true) return "modification";
    if (route.diagnosisIntent === true || route.runtimeDiagnosisIntent === true) return "diagnosis";
    if (["creative", "visual_prompt"].includes(route.mode)) return "writing";
    return "discussion";
  }
  if ((route.mode === "operation" || route.mode === "workspace_operation" || route.mode === "general") && /导出|导出为|下载|打包/u.test(source)) return "export";
  if (route.runtimeDiagnosisIntent === true && /测试|回归|验收/u.test(source)) return "testing";
  if (route.mode === "quick_revision" || route.revisionIntent === true || (reviewDelivery?.active === true && CONTENT_MUTATION_PATTERN.test(clean(instruction)))) return "modification";
  if (reviewDelivery?.active || route.diagnosisIntent === true || route.runtimeDiagnosisIntent === true) return "diagnosis";
  if (route.mode === "creative_guidance") return "planning";
  if (!taskContract?.deliverables?.length && /^(?:请)?(?:规划|计划|制定方案|设计方案|安排).{0,40}(?:大纲|设定|流程|任务|方案)/u.test(source)) return "planning";
  if (route.mode === "creative" || route.mode === "visual_prompt") return "writing";
  if (route.mode === "general" && route.runtimeDiagnosisIntent === true) return "diagnosis";
  return "discussion";
};

const deliverablesFor = ({ route = {}, taskContract = null, reviewDelivery = null, taskPolicy = {}, writeAuthorization = null, taskType = "", target = null, targetDocumentIds = [] } = {}) => {
  if (Array.isArray(taskContract?.deliverables) && taskContract.deliverables.length) {
    return taskContract.deliverables.map((item, index) => ({
      id: clean(item.id) || `deliverable-${String(index + 1).padStart(3, "0")}`,
      kind: deliverableKindFor(item.targetDocumentId || item.targetDocument || item.target?.documentId, route.deliverableType, item.kind),
      targetDocumentId: clean(item.targetDocumentId || item.targetDocument || item.target?.documentId),
      required: item.required !== false,
      status: clean(item.status) || "pending",
    })).filter((item) => item.targetDocumentId || item.kind === "document");
  }
  if (reviewDelivery?.reportRequested === true && reviewDelivery.target?.documentId) {
    const reportDeliverable = {
      id: "review-report",
      kind: "review_report",
      targetDocumentId: clean(reviewDelivery.target.documentId),
      required: true,
      status: "pending",
    };
    if (taskPolicy.action !== "modify") return [reportDeliverable];
    const mutationIds = unique(targetDocumentIds.length ? targetDocumentIds : target?.documentId)
      .filter((documentId) => documentId !== reportDeliverable.targetDocumentId);
    return [
      ...mutationIds.map((targetDocumentId, index) => ({
        id: `deliverable-${String(index + 1).padStart(3, "0")}`,
        kind: deliverableKindFor(targetDocumentId, route.deliverableType),
        targetDocumentId,
        required: true,
        status: "pending",
      })),
      reportDeliverable,
    ];
  }
  if (["planning", "testing", "diagnosis", "discussion"].includes(clean(taskType)) && writeAuthorization?.state !== "commit") return [];
  if (reviewDelivery?.active === true && route.revisionIntent !== true && taskPolicy.action !== "modify") return [];
  const ids = unique(targetDocumentIds.length ? targetDocumentIds : target?.documentId);
  if (!ids.length || !route.shensiLed) return [];
  return ids.map((targetDocumentId, index) => ({
    id: `deliverable-${String(index + 1).padStart(3, "0")}`,
    kind: deliverableKindFor(targetDocumentId, route.deliverableType),
    targetDocumentId,
    required: true,
    status: "pending",
  }));
};

const inferredRequiredContextDocumentIds = ({ instruction = "", route = {}, reviewDelivery = null } = {}) => {
  if (route.semanticAuthority === true) return [];
  const source = clean(instruction);
  if (!REVIEW_SOURCE_REFERENCE_PATTERN.test(source) || !CONTENT_MUTATION_PATTERN.test(source)) return [];
  const target = indexWriteTargetForScenario("explicit_self_check_report", {
    contextDomain: clean(route.contextDomain) || "novel",
  });
  return target?.documentId ? [target.documentId] : [];
};

const targetResolutionFor = ({ target = null, targetDocumentIds = [], taskContract = null } = {}) => {
  if (["exact", "ambiguous", "unresolved"].includes(clean(taskContract?.targetResolution))) return clean(taskContract.targetResolution);
  if (taskContract?.deliverables?.length) return "exact";
  if (target?.ambiguous === true || targetDocumentIds.length > 1) return "ambiguous";
  if (target?.documentId || targetDocumentIds.length === 1) return "exact";
  return "unresolved";
};

const writeModeFor = ({ taskPolicy = {}, writeAuthorization = null, taskContract = null } = {}) => {
  if (["none", "candidate_only"].includes(clean(taskContract?.persistence))) return "conversation_only";
  if (writeAuthorization?.state !== "commit") return "conversation_only";
  return taskPolicy.commitDisposition === "auto_commit" ? "formal_auto" : "confirm_required";
};

const confidenceFor = ({ route = {}, targetResolution = "unresolved" } = {}) => {
  const value = Number(route.confidence);
  const base = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return targetResolution === "ambiguous" ? Math.min(base, 0.59) : base;
};

export const buildIntentEnvelope = ({
  instruction = "",
  sourceMessageId = "",
  route = {},
  taskContract = null,
  reviewDelivery = null,
  taskPolicy = {},
  writeAuthorization = null,
  target = null,
  targetDocumentIds = [],
  requiredContextDocumentIds = [],
  optionalReferenceDocumentIds = [],
  skillIds = [],
} = {}) => {
  const normalizedIds = unique(targetDocumentIds.length ? targetDocumentIds : target?.documentId);
  const targetResolution = targetResolutionFor({ target, targetDocumentIds: normalizedIds, taskContract });
  const taskType = taskTypeFor({ route, taskContract, reviewDelivery, instruction });
  const deliverables = deliverablesFor({ route, taskContract, reviewDelivery, taskPolicy, writeAuthorization, taskType, target, targetDocumentIds: normalizedIds });
  const writeMode = writeModeFor({ taskPolicy, writeAuthorization, taskContract });
  const inferredRequiredIds = inferredRequiredContextDocumentIds({ instruction, route, reviewDelivery });
  const acceptanceCriteria = Array.isArray(taskContract?.acceptanceCriteria) && taskContract.acceptanceCriteria.length
    ? unique(taskContract.acceptanceCriteria)
    : [deliverables.length ? "all_required_deliverables_verified" : "no_formal_document_write"];
  return {
    schemaVersion: INTENT_ENVELOPE_SCHEMA_VERSION,
    sourceMessageId: clean(sourceMessageId),
    taskType,
    objective: clipped(taskContract?.objective || instruction, 600),
    deliverables,
    acceptanceCriteria,
    requiredContextDocumentIds: unique([
      ...(requiredContextDocumentIds.length ? requiredContextDocumentIds : taskContract?.requiredContextDocumentIds || []),
      ...inferredRequiredIds,
    ]),
    optionalReferenceDocumentIds: unique(optionalReferenceDocumentIds.length ? optionalReferenceDocumentIds : taskContract?.optionalReferenceDocumentIds),
    skillIds: unique(skillIds.length ? skillIds : taskContract?.skillIds),
    exclusions: Array.isArray(taskContract?.exclusions) ? unique(taskContract.exclusions) : [],
    targetResolution,
    targetDocumentIds: normalizedIds,
    writeMode,
    confidence: confidenceFor({ route, targetResolution }),
    evidence: unique([route.reason, writeAuthorization?.reason, reviewDelivery?.reason]).map((item) => clipped(item)),
    completionStatus: clean(taskContract?.completionStatus) || (deliverables.length ? "pending" : "conversation_only"),
  };
};

export const normalizeIntentEnvelope = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  const taskType = INTENT_TASK_TYPES.includes(clean(source.taskType)) ? clean(source.taskType) : "discussion";
  const writeMode = INTENT_WRITE_MODES.includes(clean(source.writeMode)) ? clean(source.writeMode) : "conversation_only";
  const targetDocumentIds = unique(source.targetDocumentIds);
  const deliverables = Array.isArray(source.deliverables)
    ? source.deliverables.map((item, index) => ({
      id: clean(item?.id) || `deliverable-${String(index + 1).padStart(3, "0")}`,
      kind: deliverableKindFor(item?.targetDocumentId || item?.targetDocument, "", item?.kind),
      targetDocumentId: clean(item?.targetDocumentId || item?.targetDocument),
      required: item?.required !== false,
      status: clean(item?.status) || "pending",
    })).filter((item) => item.targetDocumentId || item.kind === "document")
    : [];
  return {
    schemaVersion: INTENT_ENVELOPE_SCHEMA_VERSION,
    sourceMessageId: clean(source.sourceMessageId),
    taskType,
    objective: clipped(source.objective, 600),
    deliverables,
    acceptanceCriteria: Array.isArray(source.acceptanceCriteria) && source.acceptanceCriteria.length
      ? unique(source.acceptanceCriteria)
      : [deliverables.length ? "all_required_deliverables_verified" : "no_formal_document_write"],
    requiredContextDocumentIds: unique(source.requiredContextDocumentIds),
    optionalReferenceDocumentIds: unique(source.optionalReferenceDocumentIds),
    skillIds: unique(source.skillIds),
    exclusions: unique(source.exclusions),
    targetResolution: ["exact", "ambiguous", "unresolved"].includes(clean(source.targetResolution)) ? clean(source.targetResolution) : "unresolved",
    targetDocumentIds,
    writeMode,
    confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0)),
    evidence: unique(source.evidence).map((item) => clipped(item)),
    completionStatus: clean(source.completionStatus) || (deliverables.length ? "pending" : "conversation_only"),
  };
};
