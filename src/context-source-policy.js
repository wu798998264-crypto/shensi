const AUTHORITY_LEVELS = new Set(["canon", "draft", "reference", "deprecated"]);
const SOURCE_KINDS = new Set(["chapter", "outline", "canon", "state", "ledger", "reference"]);

export const normalizeContextAuthority = (value, fallback = "reference") => {
  const normalized = String(value || "").trim().toLowerCase();
  return AUTHORITY_LEVELS.has(normalized) ? normalized : fallback;
};

export const contextSourceAuthority = (document = {}, moduleId = "", documentId = document?.id || "") => {
  if (document?.disabled === true || document?.enabled === false) return "deprecated";
  if (["deprecated", "retired", "history", "deleted", "trash"].includes(String(document?.contextStatus || document?.context_status || "").trim().toLowerCase())) return "deprecated";
  if (["deprecated", "retired", "history", "deleted", "trash", "recycle", "recycle-bin"].includes(String(moduleId || document?.moduleId || "").trim().toLowerCase())) return "deprecated";
  const explicit = String(document?.authorityLevel || "").trim().toLowerCase();
  if (AUTHORITY_LEVELS.has(explicit)) return explicit;
  if (/(?:^|[-_:])(?:trash|retired|deleted|history)(?:$|[-_:])/i.test(String(documentId))) return "deprecated";
  if (["canon", "memory", "manuscript"].includes(String(moduleId))) return "canon";
  if (String(moduleId) === "outline") return "draft";
  return "reference";
};

const inferSourceKind = ({ document = {}, moduleId = "", documentId = "" } = {}) => {
  const explicit = String(document?.sourceKind || "").trim().toLowerCase();
  if (SOURCE_KINDS.has(explicit)) return explicit;
  const id = String(documentId || document?.id || "").toLowerCase();
  const module = String(moduleId || document?.moduleId || "").toLowerCase();
  if (/ledger|伏笔|台账|continuity|information/.test(id)) return "ledger";
  if (module === "memory" || /(?:^|[-_])(?:state|snapshot|memory)(?:[-_]|$)/.test(id)) return "state";
  if (module === "outline" || /^outline[-_]/.test(id)) return "outline";
  if (module === "manuscript" || /^(?:chapter|episode)[-_]\d+/.test(id)) return "chapter";
  if (module === "canon") return "canon";
  return "reference";
};

export const classifyContextSource = ({ document = {}, moduleId = "", domain = "general" } = {}) => {
  const resolvedModuleId = String(moduleId || document?.moduleId || "manuscript");
  const documentId = String(document?.id || "");
  const authority = contextSourceAuthority(document, resolvedModuleId, documentId);
  const sourceKind = inferSourceKind({ document, moduleId: resolvedModuleId, documentId });
  return {
    sourceKind,
    authority,
    domain: String(domain || document?.domain || "general"),
    moduleId: resolvedModuleId,
    canUseForCanon: authority === "canon",
    canUseForContinuity: authority === "canon" || sourceKind === "outline" || sourceKind === "state" || sourceKind === "ledger",
    canUseAsReference: authority !== "deprecated",
  };
};
