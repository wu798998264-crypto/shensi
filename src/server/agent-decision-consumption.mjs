import { createHash } from "node:crypto";
import { validateTaskContractForExecution } from "../task-contract.js";

const text = (value = "", max = 1200) => String(value ?? "").trim().slice(0, max);
const normalizedLabel = (value = "") => text(value, 400).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
const unique = (values = []) => [...new Set(values.map((value) => text(value, 240)).filter(Boolean))];

const documentEntries = (documents = {}) => Object.entries(documents && typeof documents === "object" ? documents : {})
  .map(([key, document]) => ({
    id: text(document?.id || key, 240),
    title: text(document?.title || document?.name, 400),
  }))
  .filter((entry) => entry.id);

const explicitDocumentReference = (reference = "") => {
  const source = text(reference, 240);
  const match = source.match(/^(?:document|doc|文档)\s*[:：]\s*(.+)$/iu);
  const explicit = text(match?.[1] || source, 240);
  const wrapped = explicit.match(/^《\s*([\s\S]+?)\s*》$/u);
  return text(wrapped?.[1] || explicit, 240);
};

const documentRangeReference = (reference = "") => {
  const source = explicitDocumentReference(reference).normalize("NFKC").replace(/\s+/gu, "");
  const match = source.match(/^第?(\d+)(?:章)?(?:~|〜|-|—|–|至|到)第?(\d+)章(正文|章纲)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 200) return null;
  const documentKind = match[3] === "章纲" ? "chapter_outline" : "chapter_prose";
  const documentIds = Array.from({ length: end - start + 1 }, (_, index) => (
    documentKind === "chapter_outline" ? `outline-chapter-${start + index}` : `chapter-${start + index}`
  ));
  return { start, end, documentKind, documentIds };
};

const documentGroupReference = (reference = "", entries = []) => {
  const source = explicitDocumentReference(reference).normalize("NFKC").replace(/\s+/gu, "");
  const canonGroup = /^(?:(?:[一二两三四五六七八九十\d]+份)|全部|所有|现有|当前作品(?:的)?)(?:正史|正史设定)(?:文档)?$/u.test(source);
  const memoryGroup = /^(?:全部|所有|现有|当前作品(?:的)?)长文记忆(?:文档)?$/u.test(source);
  const documentIds = canonGroup
    ? entries.filter((entry) => /^(?:canon-|script-canon-)/u.test(entry.id)).map((entry) => entry.id)
    : memoryGroup
      ? entries.filter((entry) => /^(?:memory-|script-memory-)/u.test(entry.id)).map((entry) => entry.id)
      : [];
  if (!canonGroup && !memoryGroup) return null;
  return {
    groupKind: canonGroup ? "canon" : "memory",
    documentIds,
  };
};

export const resolveAgentDocumentReference = ({
  reference = "",
  documents = {},
  submittedDocumentId = "",
} = {}) => {
  const requested = explicitDocumentReference(reference);
  if (!requested) return { status: "unresolved", reference: "", documentId: "", reason: "empty_reference" };
  if (/^(?:attachment|web|url|https?):/iu.test(requested)) {
    return { status: "delegated_external", reference: requested, documentId: "", reason: "external_read_pipeline" };
  }
  if (["submitted_document", "current_document", "当前文档", "发送时文档", "发送时打开的文档"].includes(normalizedLabel(requested))) {
    const documentId = text(submittedDocumentId, 240);
    return documentId
      ? { status: "resolved", reference: requested, documentId, reason: "submitted_document" }
      : { status: "unresolved", reference: requested, documentId: "", reason: "submitted_document_unavailable" };
  }
  const entries = documentEntries(documents);
  const range = documentRangeReference(requested);
  if (range) {
    const existingIds = new Set(entries.map((entry) => entry.id));
    const documentIds = range.documentIds.filter((documentId) => existingIds.has(documentId));
    const missingDocumentIds = range.documentIds.filter((documentId) => !existingIds.has(documentId));
    return {
      status: missingDocumentIds.length ? (documentIds.length ? "partial" : "unresolved") : "resolved",
      reference: requested,
      documentId: documentIds.length === 1 ? documentIds[0] : "",
      documentIds,
      missingDocumentIds,
      rangeStart: range.start,
      rangeEnd: range.end,
      rangeKind: range.documentKind,
      reason: missingDocumentIds.length ? "range_incomplete" : "document_range",
    };
  }
  const group = documentGroupReference(requested, entries);
  if (group) {
    return {
      status: group.documentIds.length ? "resolved" : "unresolved",
      reference: requested,
      documentId: group.documentIds.length === 1 ? group.documentIds[0] : "",
      documentIds: group.documentIds,
      groupKind: group.groupKind,
      reason: group.documentIds.length ? "document_group" : "group_empty",
    };
  }
  const exactId = entries.find((entry) => entry.id === requested);
  if (exactId) return { status: "resolved", reference: requested, documentId: exactId.id, reason: "exact_id" };
  const label = normalizedLabel(requested);
  const titleMatches = entries.filter((entry) => entry.title && normalizedLabel(entry.title) === label);
  if (titleMatches.length === 1) {
    return { status: "resolved", reference: requested, documentId: titleMatches[0].id, reason: "unique_exact_title" };
  }
  return {
    status: titleMatches.length > 1 ? "ambiguous" : "unresolved",
    reference: requested,
    documentId: "",
    reason: titleMatches.length > 1 ? "duplicate_title" : "not_found",
    candidates: titleMatches.map((entry) => entry.id),
  };
};

export const resolveAgentReadPlan = ({
  readPlan = [],
  documents = {},
  submittedDocumentId = "",
} = {}) => {
  const resolutions = (Array.isArray(readPlan) ? readPlan : []).map((item) => ({
    ...resolveAgentDocumentReference({ reference: item?.reference, documents, submittedDocumentId }),
    required: item?.required === true,
    purpose: text(item?.purpose, 600),
  }));
  const resolvedIds = (resolution) => unique([
    ...(Array.isArray(resolution?.documentIds) ? resolution.documentIds : []),
    resolution?.documentId,
  ]);
  return {
    documentIds: unique(resolutions.flatMap(resolvedIds)),
    requiredDocumentIds: unique(resolutions.filter((item) => item.required).flatMap(resolvedIds)),
    optionalDocumentIds: unique(resolutions.filter((item) => !item.required).flatMap(resolvedIds)),
    externalReferences: unique(resolutions.filter((item) => item.status === "delegated_external").map((item) => item.reference)),
    unresolvedRequired: resolutions.filter((item) => item.required && !["resolved", "delegated_external"].includes(item.status)),
    resolutions,
  };
};

export const agentReadPlanFailureMessage = ({ agentDecision = null, unresolvedRequired = [] } = {}) => {
  const missing = Array.isArray(unresolvedRequired) ? unresolvedRequired : [];
  const qualityReview = agentDecision?.taskKind === "quality_review"
    || (Array.isArray(agentDecision?.skillCapabilities) && agentDecision.skillCapabilities.some((capability) => ["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer"].includes(capability)));
  if (!qualityReview) return "没有找到这次需要的内容，暂时无法继续。";
  const proseRange = missing.find((item) => item?.rangeKind === "chapter_prose");
  const requested = explicitDocumentReference(proseRange?.reference || "");
  return requested
    ? `没有找到${requested}，暂时无法自检。`
    : "没有找到这次要检查的正文，暂时无法自检。";
};

export const resolveAgentWritePlanTarget = ({
  writePlan = {},
  documents = {},
  submittedDocumentId = "",
  fallbackDocumentId = "",
} = {}) => {
  const intent = ["none", "candidate", "commit"].includes(writePlan?.intent) ? writePlan.intent : "none";
  const targetKind = ["current", "existing", "new", "unspecified"].includes(writePlan?.targetKind)
    ? writePlan.targetKind
    : "unspecified";
  if (intent === "none") return { status: "not_requested", intent, targetKind, documentId: "", requestedTitle: "" };
  if (targetKind === "current") {
    const resolved = resolveAgentDocumentReference({ reference: "submitted_document", documents, submittedDocumentId });
    return { ...resolved, intent, targetKind, requestedTitle: "" };
  }
  if (targetKind === "existing") {
    const resolved = resolveAgentDocumentReference({ reference: writePlan?.targetRef, documents, submittedDocumentId });
    return { ...resolved, intent, targetKind, requestedTitle: "" };
  }
  if (targetKind === "new") {
    const requestedTitle = text(writePlan?.targetRef, 240);
    return requestedTitle
      ? { status: "new", intent, targetKind, documentId: "", requestedTitle, reason: "new_document" }
      : { status: "unresolved", intent, targetKind, documentId: "", requestedTitle: "", reason: "new_title_required" };
  }
  const documentId = text(fallbackDocumentId, 240);
  return documentId
    ? { status: "resolved", intent, targetKind, documentId, requestedTitle: "", reason: "verified_fallback_target" }
    : { status: "unresolved", intent, targetKind, documentId: "", requestedTitle: "", reason: "target_unspecified" };
};

export const reconcileAgentWriteTargetWithTaskContract = ({
  semanticWriteTarget = {},
  taskContract = null,
} = {}) => {
  const semanticTarget = semanticWriteTarget && typeof semanticWriteTarget === "object"
    ? semanticWriteTarget
    : {};
  if (!["candidate", "commit"].includes(semanticTarget.intent)) return semanticTarget;
  const contractDecision = validateTaskContractForExecution(taskContract);
  const authoritativeDocumentId = contractDecision.valid
    && contractDecision.authoritative
    && contractDecision.targetResolution === "exact"
    && contractDecision.targetDocumentIds.length === 1
    ? contractDecision.targetDocumentIds[0]
    : "";
  if (!authoritativeDocumentId) return semanticTarget;
  const semanticDocumentId = text(semanticTarget.documentId, 240);
  return {
    ...semanticTarget,
    status: "resolved",
    documentId: authoritativeDocumentId,
    reason: "authoritative_task_contract_target",
    authoritative: true,
    ...(semanticTarget.status !== "resolved" || semanticDocumentId !== authoritativeDocumentId
      ? {
        semanticStatus: text(semanticTarget.status, 80),
        semanticReason: text(semanticTarget.reason, 120),
      }
      : {}),
  };
};

export const agentSemanticSkillRoutingText = ({ prompt = "", skillQueries = [], skillCapabilities = [] } = {}) => {
  const queries = unique(Array.isArray(skillQueries) ? skillQueries : []).slice(0, 8);
  const capabilities = unique(Array.isArray(skillCapabilities) ? skillCapabilities : []).slice(0, 16);
  // The classifier has already interpreted the user's request. Feeding the
  // raw prompt into the legacy trigger matcher here would let a keyword make
  // a second, competing Skill decision. Explicit picker selections are added
  // separately, so automatic routing must consume only the Agent's semantic
  // capability request.
  void prompt;
  if (!queries.length && !capabilities.length) return "";
  return [
    "# Agent 语义能力需求",
    ...(capabilities.length ? [`能力 ID：${capabilities.join("、")}`] : []),
    ...queries.map((query) => `- ${query}`),
  ].join("\n");
};

export const agentSemanticSkillCapabilities = ({ skillCapabilities = [] } = {}) => unique(
  Array.isArray(skillCapabilities) ? skillCapabilities : [],
).slice(0, 16);

const decisionFingerprint = ({ taskId = "", contractRevision = 1, openDecision = {} } = {}) => createHash("sha256")
  .update(JSON.stringify({
    taskId: text(taskId, 120),
    contractRevision: Math.max(1, Number(contractRevision) || 1),
    semanticId: text(openDecision?.id, 120),
    question: text(openDecision?.question, 1000),
    options: (Array.isArray(openDecision?.options) ? openDecision.options : []).map((option) => ({
      id: text(option?.id, 80),
      label: text(option?.label, 240),
      entityRefs: unique(option?.entityRefs),
      scopeDelta: text(option?.scopeDelta, 800),
    })),
    allowFreeText: openDecision?.allowFreeText !== false,
  }))
  .digest("hex");

export const materializeAgentOpenDecision = ({
  openDecision = null,
  taskId = "",
  conversationId = "",
  contractRevision = 1,
  now = Date.now(),
  ttlMs = 24 * 60 * 60 * 1000,
} = {}) => {
  if (!openDecision?.question || !taskId) return null;
  const revision = Math.max(1, Number(contractRevision) || 1);
  const fingerprint = decisionFingerprint({ taskId, contractRevision: revision, openDecision });
  return {
    ...openDecision,
    id: `agent-decision-${fingerprint.slice(0, 24)}`,
    semanticId: text(openDecision.id, 120),
    taskId: text(taskId, 120),
    conversationId: text(conversationId, 180),
    contractRevision: revision,
    createdAt: Math.max(0, Number(now) || Date.now()),
    expiresAt: Math.max(0, Number(now) || Date.now()) + Math.max(60_000, Number(ttlMs) || 0),
    fingerprint,
  };
};

export const validateAgentDecisionResolution = ({
  pendingDecision = null,
  resolution = null,
  conversationId = "",
  contractRevision = 1,
  now = Date.now(),
} = {}) => {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!pendingDecision || !resolution || typeof resolution !== "object") {
    return fail("AGENT_DECISION_NOT_FOUND", "待确认决定不存在或已失效，请重新发送原任务。");
  }
  if (text(resolution.decisionId, 160) !== text(pendingDecision.id, 160)
    || text(resolution.taskId, 160) !== text(pendingDecision.taskId, 160)) {
    return fail("AGENT_DECISION_ID_MISMATCH", "本次回答不属于当前待确认任务。");
  }
  if (pendingDecision.conversationId
    && text(conversationId, 180) !== text(pendingDecision.conversationId, 180)) {
    return fail("AGENT_DECISION_CONVERSATION_MISMATCH", "本次回答不属于当前对话。");
  }
  if (Math.max(1, Number(contractRevision) || 1) !== pendingDecision.contractRevision
    || Math.max(1, Number(resolution.contractRevision) || 1) !== pendingDecision.contractRevision) {
    return fail("AGENT_DECISION_CONTRACT_STALE", "任务合同已变化，请基于当前状态重新确认。");
  }
  if (Number(now) > Number(pendingDecision.expiresAt)) {
    return fail("AGENT_DECISION_EXPIRED", "这项确认已经过期，请重新发送原任务。");
  }
  const optionId = text(resolution.optionId, 80);
  const freeText = text(resolution.answer, 4000);
  const option = optionId
    ? (pendingDecision.options ?? []).find((item) => text(item?.id, 80) === optionId)
    : null;
  if (optionId && !option) return fail("AGENT_DECISION_OPTION_INVALID", "所选项已不属于当前决定。");
  if (!option && !freeText) return fail("AGENT_DECISION_ANSWER_REQUIRED", "请给出选择或直接说明你的决定。");
  if (!option && pendingDecision.allowFreeText === false) {
    return fail("AGENT_DECISION_FREE_TEXT_FORBIDDEN", "这项决定需要从当前有效选项中选择。");
  }
  return {
    ok: true,
    resolution: {
      decisionId: pendingDecision.id,
      taskId: pendingDecision.taskId,
      contractRevision: pendingDecision.contractRevision,
      optionId: option?.id || "",
      answer: option?.label || freeText,
      entityRefs: option?.entityRefs ?? [],
      scopeDelta: option?.scopeDelta || "",
      resolvedAt: Math.max(0, Number(now) || Date.now()),
    },
  };
};
