import { createHash } from "node:crypto";

import { compileManagedMaterialMutation } from "./material-update-plan.js";

export const LIBRARY_ARCHIVE_SCHEMA = "shensi.library-archive-plan.v1";

// These are the managed setting/outline documents that may be created by an
// archive plan. Existing custom documents are accepted only when their IDs
// already follow the same canon-/outline- namespace.
export const LIBRARY_ARCHIVE_TARGET_IDS = Object.freeze([
  "canon-characters",
  "canon-relations",
  "canon-world",
  "canon-locations",
  "canon-factions",
  "canon-events",
  "canon-items",
  "canon-glossary",
  "script-canon-characters",
  "script-canon-relations",
  "script-canon-world",
  "script-canon-locations",
  "script-canon-factions",
  "script-canon-events",
  "script-canon-items",
  "script-canon-glossary",
  "outline-series",
  "outline-volume-1",
  "outline-chapter-6",
  "script-outline-series",
  "script-outline-episode-1",
]);

const text = (value = "", max = 4_000) => String(value ?? "").replace(/\r\n?/gu, "\n").trim().slice(0, max);
const unique = (values = []) => [...new Set((Array.isArray(values) ? values : [values]).map((value) => text(value, 400)).filter(Boolean))];
const sha256 = (value = "") => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const documentText = (document = {}) => String(document?.markdown ?? document?.text ?? document?.html ?? "")
  .replace(/<br\s*\/?>(?=.)/giu, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&lt;/giu, "<")
  .replace(/&gt;/giu, ">")
  .replace(/&quot;/giu, '"')
  .replace(/&#39;|&apos;/giu, "'")
  .replace(/[ \t]+\n/gu, "\n")
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

const compact = (value = "") => String(value ?? "").replace(/\s+/gu, "").trim();
const quoteExists = (source = "", quote = "") => {
  const original = String(source ?? "");
  const wanted = String(quote ?? "").trim();
  return Boolean(wanted) && (original.includes(wanted) || compact(original).includes(compact(wanted)));
};

const sourceStatus = (document = {}) => String(document?.contextStatus || document?.context_status || "").trim().toLowerCase();

export const isLibraryArchiveSource = (documentId = "", document = {}) => {
  const id = text(documentId, 240);
  if (!/^library-/u.test(id) || id === "library-trash") return false;
  if (document?.disabled === true || document?.enabled === false) return false;
  return !["deprecated", "retired", "history", "deleted", "trash"].includes(sourceStatus(document));
};

export const isLibraryArchiveTarget = (documentId = "") => (
  /^(?:canon|outline|script-canon|script-outline)-[a-z0-9][a-z0-9-]*$/iu.test(text(documentId, 240))
);

export const libraryArchiveSourceText = documentText;

export const createLibraryArchiveSnapshot = ({ documents = {}, sourceDocumentIds = [], projectId = "", revisionFor = null } = {}) => {
  const sourceMap = documents && typeof documents === "object" ? documents : {};
  const ids = unique(sourceDocumentIds.length ? sourceDocumentIds : Object.keys(sourceMap));
  const missing = ids.filter((id) => !sourceMap[id]);
  if (missing.length) {
    throw Object.assign(new Error(`资料库来源不存在：${missing.join("、")}`), { code: "LIBRARY_ARCHIVE_SOURCE_NOT_FOUND", missing });
  }
  const rejected = ids.filter((id) => !isLibraryArchiveSource(id, sourceMap[id]));
  if (rejected.length) {
    throw Object.assign(new Error(`资料库来源不可读取：${rejected.join("、")}`), { code: "LIBRARY_ARCHIVE_SOURCE_NOT_READABLE", rejected });
  }
  const snapshotDocuments = Object.fromEntries(ids.map((id) => {
    const document = sourceMap[id] || {};
    const content = documentText(document);
    const resolvedRevision = typeof revisionFor === "function"
      ? revisionFor(id, document)
      : document.revision || document.updatedAt || "current";
    return [id, {
      id,
      title: text(document.title || id, 240),
      revision: text(resolvedRevision || "current", 240),
      contentHash: sha256(content),
      content,
    }];
  }));
  const snapshot = {
    schema: LIBRARY_ARCHIVE_SCHEMA,
    projectId: text(projectId, 240),
    sourceDocumentIds: ids,
    documents: snapshotDocuments,
  };
  return {
    ...snapshot,
    snapshotHash: sha256(canonicalJson(snapshot)),
  };
};

const parseJsonCandidates = (value = "") => {
  if (value && typeof value === "object" && !Array.isArray(value)) return [value];
  const source = text(value, 2_000_000);
  const candidates = [source.replace(/^```(?:json)?\s*|\s*```$/giu, "").trim()];
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  return candidates.map((candidate) => {
    try { return JSON.parse(candidate); } catch { return null; }
  }).filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
};

const normalizedOperation = (value = "") => ({
  new: "create",
  insert: "patch",
  update: "patch",
  patch: "patch",
  append: "append",
  replace: "replace",
  create: "create",
}[text(value, 40).toLowerCase()] || "patch");

const normalizedDisposition = (value = "") => ({
  duplicate: "duplicate",
  same: "duplicate",
  conflict: "conflict",
  unresolved: "conflict",
  defer: "defer",
  pending: "defer",
  new: "new",
  insert: "new",
  update: "update",
  patch: "update",
  append: "update",
  replace: "update",
  create: "new",
}[text(value, 40).toLowerCase()] || "update");

const confidenceValue = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const normalized = text(value, 40).toLowerCase();
  if (normalized === "high" || normalized === "高") return 0.9;
  if (normalized === "medium" || normalized === "中") return 0.65;
  if (normalized === "low" || normalized === "低") return 0.35;
  return 0;
};

const candidateFingerprint = (candidate) => sha256(canonicalJson({
  sourceDocumentId: candidate.sourceDocumentId,
  sourceRevision: candidate.sourceRevision,
  sourceHash: candidate.sourceHash,
  sourceQuote: candidate.sourceQuote,
  targetDocumentId: candidate.targetDocumentId,
  targetSection: candidate.targetSection,
  disposition: candidate.disposition,
  operation: candidate.operation,
  content: candidate.content,
})).slice(0, 24);

export const validateLibraryArchiveEvidence = ({ plan = null, snapshot = null } = {}) => {
  const sourceDocuments = snapshot?.documents && typeof snapshot.documents === "object" ? snapshot.documents : {};
  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  const errors = [];
  for (const candidate of candidates) {
    const source = sourceDocuments[candidate.sourceDocumentId];
    if (!source) {
      errors.push({ candidateId: candidate.candidateId, code: "SOURCE_NOT_IN_SNAPSHOT", sourceDocumentId: candidate.sourceDocumentId });
      continue;
    }
    if (candidate.sourceHash && candidate.sourceHash !== source.contentHash) {
      errors.push({ candidateId: candidate.candidateId, code: "SOURCE_HASH_CHANGED", sourceDocumentId: candidate.sourceDocumentId });
    }
    if (candidate.sourceRevision && candidate.sourceRevision !== source.revision) {
      errors.push({ candidateId: candidate.candidateId, code: "SOURCE_REVISION_CHANGED", sourceDocumentId: candidate.sourceDocumentId });
    }
    if (!quoteExists(source.content, candidate.sourceQuote)) {
      errors.push({ candidateId: candidate.candidateId, code: "EVIDENCE_NOT_FOUND", sourceDocumentId: candidate.sourceDocumentId });
    }
  }
  return { valid: errors.length === 0, errors };
};

export const archivePlanFingerprint = (plan = {}) => sha256(canonicalJson({
  schema: plan.schema || LIBRARY_ARCHIVE_SCHEMA,
  sourceSnapshotHash: plan.sourceSnapshotHash || plan.snapshotHash || "",
  sourceDocumentIds: unique(plan.sourceDocumentIds),
  targetRevisions: plan.targetRevisions || {},
  allowReplace: plan.allowReplace === true,
  candidates: (Array.isArray(plan.candidates) ? plan.candidates : []).map((candidate) => ({
    candidateId: candidate.candidateId,
    sourceDocumentId: candidate.sourceDocumentId,
    sourceRevision: candidate.sourceRevision,
    sourceHash: candidate.sourceHash,
    sourceQuote: candidate.sourceQuote,
    targetDocumentId: candidate.targetDocumentId,
    targetSection: candidate.targetSection,
    disposition: candidate.disposition,
    operation: candidate.operation,
    content: candidate.content,
  })),
}));

export const parseLibraryArchivePlan = (value = "", {
  snapshot = null,
  documents = {},
  sourceDocumentIds = [],
  allowedTargetDocumentIds = [],
  allowReplace = false,
  targetRevisions: suppliedTargetRevisions = {},
} = {}) => {
  const parsed = parseJsonCandidates(value)[0];
  if (!parsed) throw Object.assign(new Error("资料库归档没有返回可验证的结构化计划"), { code: "LIBRARY_ARCHIVE_PLAN_INVALID" });
  if (parsed.schema && parsed.schema !== LIBRARY_ARCHIVE_SCHEMA) {
    throw Object.assign(new Error("资料库归档计划版本不受支持"), { code: "LIBRARY_ARCHIVE_PLAN_SCHEMA_UNSUPPORTED" });
  }
  const sourceSnapshot = snapshot || createLibraryArchiveSnapshot({ documents, sourceDocumentIds });
  const sourceIds = new Set(unique(sourceSnapshot.sourceDocumentIds));
  const targetIds = new Set(unique(allowedTargetDocumentIds));
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates
    : Array.isArray(parsed.items) ? parsed.items
      : Array.isArray(parsed.changes) ? parsed.changes : [];
  const candidates = rawCandidates.map((item, index) => {
    const sourceDocumentId = text(item?.sourceDocumentId || item?.source || item?.documentId, 240);
    const targetDocumentId = text(item?.targetDocumentId || item?.target || item?.targetId, 240);
    const source = sourceSnapshot.documents[sourceDocumentId];
    if (!sourceIds.has(sourceDocumentId) || !source) throw Object.assign(new Error(`归档来源不在锁定快照中：${sourceDocumentId || "未指定"}`), { code: "LIBRARY_ARCHIVE_SOURCE_NOT_IN_SNAPSHOT" });
    if (!isLibraryArchiveTarget(targetDocumentId) || (targetIds.size && !targetIds.has(targetDocumentId))) {
      throw Object.assign(new Error(`归档目标必须是设定或大纲文档：${targetDocumentId || "未指定"}`), { code: "LIBRARY_ARCHIVE_TARGET_INVALID" });
    }
    const sourceQuote = text(item?.sourceQuote || item?.quote || item?.evidence?.quote || item?.evidence?.text, 1_200);
    if (!quoteExists(source.content, sourceQuote)) {
      throw Object.assign(new Error(`归档证据不在来源原文中：${sourceDocumentId}`), { code: "LIBRARY_ARCHIVE_EVIDENCE_INVALID" });
    }
    const disposition = normalizedDisposition(item?.disposition || item?.status || item?.changeType || item?.operation);
    const operation = normalizedOperation(item?.operation || item?.changeType || disposition);
    if (operation === "replace" && allowReplace !== true) {
      throw Object.assign(new Error(`归档默认禁止全文覆盖：${targetDocumentId}`), { code: "LIBRARY_ARCHIVE_REPLACE_FORBIDDEN" });
    }
    const target = documents?.[targetDocumentId] || {};
    const candidate = {
      candidateId: text(item?.candidateId, 120),
      sourceDocumentId,
      sourceTitle: source.title,
      sourceRevision: text(item?.sourceRevision, 240) || source.revision,
      sourceHash: text(item?.sourceHash, 128) || source.contentHash,
      sourceQuote,
      sourceLocation: text(item?.sourceLocation || item?.location || item?.range, 240),
      targetDocumentId,
      targetTitle: text(item?.targetTitle || target.title || targetDocumentId, 240),
      targetSection: text(item?.targetSection || item?.section || item?.entityHeading || item?.heading, 240),
      disposition,
      operation,
      reason: text(item?.reason || item?.summary, 1_000),
      content: text(item?.content || item?.targetContent || item?.patchContent, 80_000),
      confidence: confidenceValue(item?.confidence),
      expectedTargetRevision: text(item?.expectedTargetRevision || item?.targetRevision, 240)
        || text(target.revision || target.updatedAt, 240),
      userConfirmed: item?.userConfirmed === true,
      order: Math.max(0, Number(item?.order) || index + 1),
    };
    candidate.candidateId ||= `library-candidate-${candidateFingerprint(candidate)}`;
    if (!["duplicate", "conflict", "defer"].includes(candidate.disposition) && !candidate.content) {
      throw Object.assign(new Error(`归档候选缺少正式内容：${targetDocumentId}`), { code: "LIBRARY_ARCHIVE_CONTENT_MISSING" });
    }
    return candidate;
  });
  const targetRevisions = Object.fromEntries(unique(candidates.map((candidate) => candidate.targetDocumentId)).map((id) => [
    id,
    text(suppliedTargetRevisions?.[id] || documents?.[id]?.revision || documents?.[id]?.updatedAt, 240),
  ]));
  const plan = {
    schema: LIBRARY_ARCHIVE_SCHEMA,
    version: 1,
    summary: text(parsed.summary || parsed.reason, 1_200),
    sourceSnapshotHash: sourceSnapshot.snapshotHash,
    sourceDocumentIds: [...sourceIds],
    targetRevisions,
    allowReplace: allowReplace === true,
    candidates,
  };
  return { ...plan, fingerprint: archivePlanFingerprint(plan), evidence: validateLibraryArchiveEvidence({ plan, snapshot: sourceSnapshot }) };
};

export const compareLibraryArchiveCandidates = ({ plan = {}, documents = {} } = {}) => {
  const next = structuredClone(plan || {});
  next.candidates = (Array.isArray(next.candidates) ? next.candidates : []).map((candidate) => {
    const targetContent = documentText(documents?.[candidate.targetDocumentId] || {});
    const targetExists = Boolean(documents?.[candidate.targetDocumentId]);
    if (candidate.disposition === "conflict" || candidate.disposition === "defer") return candidate;
    if (candidate.content && targetContent && compact(targetContent).includes(compact(candidate.content))) {
      return { ...candidate, disposition: "duplicate", operation: "patch", comparison: "exact_content_already_present" };
    }
    if (targetExists && candidate.operation === "create") {
      return { ...candidate, disposition: "update", operation: "patch", comparison: "target_document_exists" };
    }
    if (candidate.targetSection && targetContent && new RegExp(`^##\\s+${candidate.targetSection.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "mu").test(targetContent)) {
      return { ...candidate, disposition: "update", operation: candidate.operation === "create" ? "patch" : candidate.operation, comparison: "target_section_exists" };
    }
    return { ...candidate, comparison: "new_or_unmatched" };
  });
  next.fingerprint = archivePlanFingerprint(next);
  return next;
};

export const libraryArchiveExecutionInstruction = (plan = {}) => {
  const candidates = (Array.isArray(plan?.candidates) ? plan.candidates : [])
    .filter((candidate) => !["duplicate", "conflict", "defer"].includes(candidate.disposition));
  return [
    "根据已经通过证据核验并经用户确认的资料库归档计划，更新设定或大纲。资料库原文只作为参考来源，不得被修改。",
    "只处理计划中的目标和候选，不得把推测、重复内容或冲突内容写入正史。默认使用局部 patch、append 或 create；全文 replace 必须有单独授权。",
    ...candidates.map((candidate, index) => [
      `交付物 ${String.fromCharCode(65 + index)}：${candidate.targetDocumentId}`,
      `来源：${candidate.sourceDocumentId}｜证据：${candidate.sourceQuote}`,
      `操作：${candidate.operation}｜目标段落：${candidate.targetSection || "按结构定位"}`,
    ].join("\n")),
  ].join("\n\n");
};

export const libraryArchiveOutputContract = (plan = {}) => {
  const targets = [...new Set((Array.isArray(plan?.candidates) ? plan.candidates : [])
    .filter((candidate) => !["duplicate", "conflict", "defer"].includes(candidate.disposition))
    .map((candidate) => candidate.targetDocumentId))];
  return [
    "# 资料库归档输出合同",
    "只返回一个 JSON 对象，不使用 Markdown 代码围栏。",
    `目标文档只能来自：${targets.join("、") || "无"}`,
    '格式：{"artifacts":[{"targetDocumentId":"canon-world 或 outline-series","operation":"patch|append|create|replace","content":"正式设定或大纲内容"}]}',
    "content 只能包含正式目标内容，不得包含分析、来源说明、执行回执或资料库原文之外的推测。",
  ].join("\n");
};

export const libraryArchivePlanningOutputContract = ({ targetDocumentIds = [] } = {}) => [
  "# 资料库归档计划输出合同",
  "只返回一个 JSON 对象，不使用 Markdown 代码围栏。",
  `schema 必须是 ${LIBRARY_ARCHIVE_SCHEMA}。`,
  `targetDocumentId 只能来自：${unique(targetDocumentIds).join("、") || "无"}。`,
  '格式：{"schema":"shensi.library-archive-plan.v1","summary":"本次归档摘要","candidates":[{"sourceDocumentId":"资料库文档 ID","sourceQuote":"来源中的连续原文","targetDocumentId":"设定或大纲文档 ID","targetTitle":"目标标题","targetSection":"目标段落","disposition":"new|update|duplicate|conflict|defer","operation":"create|patch|append","content":"准备写入的正式内容","reason":"判断依据","confidence":0.0}]}。',
  "每个候选必须绑定一个真实来源和一段可逐字复核的连续原文；不得把推测写成正史。",
  "已有相同内容标为 duplicate；与已有正史互斥且无法据来源裁决的标为 conflict；证据不足的标为 defer。",
  "只有 new 或 update 可以携带准备写入的正式内容。默认禁止 replace，不得修改资料库来源。",
].join("\n");

const operationPriority = { append: 1, patch: 2, create: 3, replace: 4 };

const archiveTargetMetadata = (documentId = "") => {
  const id = text(documentId, 240);
  const script = /^script-/iu.test(id);
  const isCanon = /^(?:script-)?canon-/iu.test(id);
  return {
    targetDirectoryId: isCanon ? "canon" : "outline",
    contentType: script ? "script" : isCanon ? "novel" : "outline",
  };
};

export const buildLibraryArchiveOperations = ({ plan = {}, documents = {} } = {}) => {
  const active = (Array.isArray(plan?.candidates) ? plan.candidates : [])
    .filter((candidate) => !["duplicate", "conflict", "defer"].includes(candidate.disposition));
  const grouped = new Map();
  for (const candidate of active) {
    const list = grouped.get(candidate.targetDocumentId) || [];
    list.push(candidate);
    grouped.set(candidate.targetDocumentId, list);
  }
  const operations = [];
  for (const [targetDocumentId, candidates] of grouped) {
    const current = documentText(documents?.[targetDocumentId] || {});
    const targetExists = Boolean(documents?.[targetDocumentId]);
    const requestedOperation = candidates.slice().sort((a, b) => (operationPriority[b.operation] || 0) - (operationPriority[a.operation] || 0))[0]?.operation || (targetExists ? "patch" : "create");
    const operation = targetExists && requestedOperation === "create" ? "patch" : requestedOperation;
    const content = candidates.map((candidate) => candidate.content).filter(Boolean).join("\n\n").trim();
    if (!content) continue;
    const operationId = `library-archive-${sha256(`${targetDocumentId}\n${candidates.map((candidate) => candidate.candidateId).sort().join("\n")}`).slice(0, 24)}`;
    const targetMetadata = archiveTargetMetadata(targetDocumentId);
    const requestedTitle = targetExists
      ? text(documents?.[targetDocumentId]?.title || targetDocumentId, 240)
      : text(candidates.find((candidate) => candidate.targetTitle)?.targetTitle || targetDocumentId, 240);
    if (!targetExists || operation === "create") {
      operations.push({
        operationId,
        type: "create",
        targetDocumentId,
        content,
        requestedTitle,
        ...targetMetadata,
      });
      continue;
    }
    if (operation === "replace") {
      if (plan.allowReplace !== true) throw Object.assign(new Error(`归档计划未授权全文覆盖：${targetDocumentId}`), { code: "LIBRARY_ARCHIVE_REPLACE_FORBIDDEN" });
      operations.push({ operationId, type: "replace", targetDocumentId, content, requestedTitle, ...targetMetadata });
      continue;
    }
    if (operation === "append") {
      operations.push({ operationId, type: "append", targetDocumentId, content, requestedTitle, ...targetMetadata });
      continue;
    }
    const mutation = compileManagedMaterialMutation({
      currentContent: current,
      candidateContent: content,
      changeType: "patch",
    });
    if (!mutation.changed) continue;
    operations.push({ operationId, type: "patch", targetDocumentId, patches: mutation.patches, requestedTitle, ...targetMetadata });
  }
  return {
    operations,
    expectedRevisions: Object.fromEntries(operations.map((operation) => [
      operation.targetDocumentId,
      text(plan?.targetRevisions?.[operation.targetDocumentId], 240),
    ])),
  };
};
