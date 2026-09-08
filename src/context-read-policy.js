const text = (value = "") => String(value ?? "").trim();

export const LIBRARY_MEMO_DOCUMENT_ID = "library-memo";
export const EXPLICIT_ONLY_CONTEXT_POLICY = "explicit-only";

const SELF_CHECK_REPORT_IDS = new Set(["report-novel", "report-script", "report-adaptation"]);
const REVIEW_SOURCE_PATTERN = /自检|审稿|审查|检查报告|质量报告|改编报告|编译报告/u;
const ARTICLE_MUTATION_PATTERN = /(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|增补|补写).{0,24}(?:正文|文章|章节|本章|稿件|文稿|剧本|单集)|(?:正文|文章|章节|本章|稿件|文稿|剧本|单集).{0,24}(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|增补|补写)/u;

export const documentUsesExplicitOnlyContext = ({ moduleId = "", document = null } = {}) => (
  text(moduleId || document?.moduleId) === "library"
  || text(document?.readPolicy || document?.contextReadPolicy) === EXPLICIT_ONLY_CONTEXT_POLICY
);

export const instructionExplicitlyNamesDocument = ({ instruction = "", title = "" } = {}) => {
  const source = text(instruction).replace(/\s+/gu, "");
  const label = text(title).replace(/\s+/gu, "");
  return label.length >= 2 && source.includes(label);
};

export const selfCheckReportMayBeReadForMutation = ({
  documentId = "",
  instruction = "",
  targetDomain = "novel",
} = {}) => {
  const id = text(documentId);
  const source = text(instruction);
  if (!SELF_CHECK_REPORT_IDS.has(id) || !REVIEW_SOURCE_PATTERN.test(source) || !ARTICLE_MUTATION_PATTERN.test(source)) return false;
  if (targetDomain === "script-adaptation") return id === "report-adaptation";
  return targetDomain === "script" ? id === "report-script" : id === "report-novel";
};

export const contextDocumentReadDecision = ({
  documentId = "",
  title = "",
  moduleId = "",
  document = null,
  instruction = "",
  targetDomain = "novel",
  explicitlyReferenced = false,
  explicitlyNamed = false,
  agentRequested = false,
  semanticRequested = false,
} = {}) => {
  const id = text(documentId || document?.id);
  const module = text(moduleId || document?.moduleId);
  const explicit = explicitlyReferenced === true
    || explicitlyNamed === true
    || instructionExplicitlyNamesDocument({ instruction, title: title || document?.title });
  const semantic = agentRequested === true || semanticRequested === true;
  if (documentUsesExplicitOnlyContext({ moduleId: module, document })) {
    return { allowed: explicit || semantic, required: explicit || semantic, mode: explicit ? "explicit" : semantic ? "agent_semantic_reference" : "excluded", contextRole: explicit || semantic ? "required" : "excluded", reason: explicit ? "user_explicit_reference" : semantic ? "agent_semantic_reference" : "explicit_only" };
  }
  if (SELF_CHECK_REPORT_IDS.has(id)) {
    const reviewMutation = selfCheckReportMayBeReadForMutation({ documentId: id, instruction, targetDomain });
    return {
      allowed: explicit || semantic || reviewMutation,
      required: explicit || semantic || reviewMutation,
      mode: explicit ? "explicit" : semantic ? "agent_semantic_reference" : reviewMutation ? "self_check_mutation" : "excluded",
      contextRole: explicit || semantic || reviewMutation ? "required" : "excluded",
      reason: explicit ? "user_explicit_reference" : semantic ? "agent_semantic_reference" : reviewMutation ? "self_check_report_for_article_mutation" : "report_not_needed",
    };
  }
  return { allowed: true, required: false, mode: "automatic", contextRole: "optional", reason: "ordinary_context_source" };
};

export const contextDocumentMayBeRead = (options = {}) => contextDocumentReadDecision(options).allowed;
