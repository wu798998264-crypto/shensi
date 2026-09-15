const text = (value = "") => String(value ?? "").trim();

export const FORMAL_CONTENT_MODULE_IDS = Object.freeze([
  "manuscript",
  "outline",
  "canon",
  "memory",
  "reports",
  "library",
  "index",
]);

const FORMAL_CONTENT_MODULE_SET = new Set(FORMAL_CONTENT_MODULE_IDS);
const SELF_CHECK_REPORT_IDS = new Set(["report-novel", "report-script", "report-adaptation"]);
const RUNTIME_PROJECTION_IDS = new Set([
  "report-compile",
  "index-update-log",
  "index-pending",
]);

const memoryProjection = (documentId = "", moduleId = "") => (
  moduleId === "memory" || /^(?:memory-|script-memory-)/u.test(documentId)
);

export const formalDocumentContentPolicy = ({
  documentId = "",
  moduleId = "",
  documentState = null,
  itemOptions = null,
} = {}) => {
  const id = text(documentId);
  const module = text(moduleId);
  if (id === "index-creative-guidance") {
    return { formal: false, directWrite: false, mode: "retired", reason: "obsolete_compatibility_document" };
  }
  if (!id || !FORMAL_CONTENT_MODULE_SET.has(module)) {
    return { formal: false, directWrite: false, mode: "unsupported", reason: "unsupported_document_scope" };
  }
  if (documentState?.readOnly === true || itemOptions?.readOnly === true) {
    return { formal: true, directWrite: false, mode: "read_only", reason: "document_is_read_only" };
  }
  if (memoryProjection(id, module)) {
    return { formal: true, directWrite: false, mode: "memory_projection", reason: "memory_uses_trusted_projection" };
  }
  if (RUNTIME_PROJECTION_IDS.has(id) || documentState?.derived === true) {
    return { formal: true, directWrite: false, mode: "runtime_projection", reason: "document_uses_runtime_projection" };
  }
  if (SELF_CHECK_REPORT_IDS.has(id)) {
    return { formal: true, directWrite: false, mode: "review_report", reason: "document_uses_review_delivery" };
  }
  if (id === "index-language-blacklist") {
    return { formal: true, directWrite: false, mode: "creative_contract", reason: "document_uses_contract_update" };
  }
  return { formal: true, directWrite: true, mode: "direct", reason: "formal_document_content" };
};
