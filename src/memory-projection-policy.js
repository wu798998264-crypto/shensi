const text = (value = "") => String(value ?? "").trim().toLowerCase();

const REALIZED_DOCUMENT_ID = /^(?:chapter-\d+|script-episode-\d+)$/u;
const REALIZED_TASK_TYPES = new Set(["writing", "modification"]);
const REALIZED_DELIVERABLE_KINDS = new Set(["prose", "script"]);

const matchingDeliverable = (taskContract, documentId) => (Array.isArray(taskContract?.deliverables)
  ? taskContract.deliverables.find((item) => (
    text(item?.targetDocumentId || item?.targetDocument) === text(documentId)
  )) ?? null
  : null);

export const memoryProjectionDecision = ({
  documentId = "",
  moduleId = "",
  contextDomain = "",
  deliverableKind = "",
  taskContract = null,
} = {}) => {
  const id = String(documentId ?? "").trim();
  if (!REALIZED_DOCUMENT_ID.test(id)) {
    return { eligible: false, reason: "source_is_not_realized_unit", documentId: id };
  }
  if (moduleId && text(moduleId) !== "manuscript") {
    return { eligible: false, reason: "source_module_is_not_manuscript", documentId: id };
  }

  const hasContract = Boolean(taskContract && Array.isArray(taskContract.deliverables));
  const deliverable = hasContract ? matchingDeliverable(taskContract, id) : null;
  if (hasContract && !deliverable) {
    return { eligible: false, reason: "source_missing_from_task_contract", documentId: id };
  }
  if (hasContract && !REALIZED_TASK_TYPES.has(text(taskContract.taskType))) {
    return { eligible: false, reason: `task_type_${text(taskContract.taskType) || "unknown"}_is_not_realized_writing`, documentId: id };
  }

  const kind = text(deliverableKind || deliverable?.kind);
  if (kind && !REALIZED_DELIVERABLE_KINDS.has(kind)) {
    return { eligible: false, reason: `deliverable_kind_${kind}_is_not_realized_prose`, documentId: id };
  }
  const targetModule = text(deliverable?.target?.moduleId || moduleId);
  if (targetModule && targetModule !== "manuscript") {
    return { eligible: false, reason: "deliverable_target_is_not_manuscript", documentId: id };
  }
  if (id.startsWith("script-episode-") && contextDomain && text(contextDomain) !== "script") {
    return { eligible: false, reason: "script_source_domain_mismatch", documentId: id };
  }

  return {
    eligible: true,
    reason: hasContract ? "verified_realized_deliverable" : "legacy_realized_unit_compatibility",
    documentId: id,
    deliverableKind: kind || (id.startsWith("script-episode-") ? "script" : "prose"),
    compatibilityMode: !hasContract,
  };
};

