import { createHash } from "node:crypto";

const clean = (value = "") => String(value ?? "").replace(/\s+/gu, " ").trim();
const list = (value) => Array.isArray(value) ? value : [];
const fingerprint = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 24);

const parseObject = (value = "") => {
  const source = String(value ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
};

const normalizedSource = (value = {}, documentsById = new Map()) => {
  const documentId = clean(value.documentId || value.id);
  const document = documentsById.get(documentId);
  const quote = clean(value.quote || value.excerpt);
  if (!document || !quote || !clean(document.content).includes(quote)) return null;
  return {
    documentId,
    title: clean(document.title || value.title || documentId),
    path: clean(document.path || value.path || document.title || documentId),
    heading: clean(value.heading || value.section),
    quote,
    revision: clean(document.revision),
  };
};

const normalizedIssue = (value = {}, documentsById = new Map()) => {
  const question = clean(value.question || value.issue);
  const conflictExplanation = clean(value.conflictExplanation || value.explanation || value.reason);
  const sources = list(value.sources).map((source) => normalizedSource(source, documentsById)).filter(Boolean).slice(0, 8);
  if (question.length < 8 || !conflictExplanation || sources.length < 2) return null;
  const conflictPoints = list(value.conflictPoints).map(clean).filter(Boolean).slice(0, 8);
  const identity = JSON.stringify({
    question,
    documents: sources.map((source) => source.documentId).sort(),
    quotes: sources.map((source) => source.quote).sort(),
  });
  const issueFingerprint = clean(value.issueFingerprint) || fingerprint(identity);
  return {
    id: `pending-conflict-${issueFingerprint}`,
    issueFingerprint,
    sourceFingerprint: issueFingerprint,
    question,
    conflictExplanation,
    context: conflictExplanation,
    conflictPoints,
    sources,
    sourcePath: sources.map((source) => source.path).join(" ↔ "),
    affectedScopes: [...new Set(sources.map((source) => clean(documentsById.get(source.documentId)?.moduleId)).filter(Boolean))],
    status: "pending",
    detectedAt: new Date().toISOString(),
  };
};

const normalizedResolution = (value = {}, existingByFingerprint = new Map(), documentsById = new Map()) => {
  const issueFingerprint = clean(value.issueFingerprint || value.fingerprint);
  const existing = existingByFingerprint.get(issueFingerprint);
  const resolutionEvidence = clean(value.resolutionEvidence || value.explanation);
  const sources = list(value.sources).map((source) => normalizedSource(source, documentsById)).filter(Boolean);
  if (!existing || !resolutionEvidence || !sources.length) return null;
  return { issueFingerprint, resolutionEvidence, sources, resolvedAt: new Date().toISOString() };
};

export const creativeIntegritySystemPrompt = () => [
  "你是神思的作品一致性核验器，只检查用户当前版本的资料、大纲、设定、正文与记忆。",
  "只报告两个或更多当前文档中的明确事实互相矛盾，且必须由作者选择最终口径的问题。",
  "不要报告文风建议、质量建议、缺少资料、待完善内容、文件维护、状态正常、可能风险或可以自行确定的普通细节。",
  "每个问题必须逐字引用至少两个来源文档的连续原句；quote 必须真实存在于对应 documentId 的当前内容中。",
  "问题描述必须直接写清两种冲突口径、为何不能同时成立、会影响哪些剧情或设定，以及作者究竟需要决定什么。",
  "对 existingIssues 逐项复核。只有当前文档原句已明确证明冲突消失时，才放入 resolutions；不能因未再次发现就宣称解决。",
  "只输出 JSON：{\"issues\":[{\"question\":\"\",\"conflictExplanation\":\"\",\"conflictPoints\":[\"\"],\"sources\":[{\"documentId\":\"\",\"heading\":\"\",\"quote\":\"\"}]}],\"resolutions\":[{\"issueFingerprint\":\"\",\"resolutionEvidence\":\"\",\"sources\":[{\"documentId\":\"\",\"quote\":\"\"}]}]}",
].join("\n");

export const runCreativeIntegrityScan = async ({ settings = {}, documents = [], existingIssues = [], trigger = {}, runModel, signal } = {}) => {
  if (typeof runModel !== "function") throw new TypeError("runModel is required");
  const normalizedDocuments = list(documents).map((document) => ({
    documentId: clean(document.documentId || document.id),
    title: clean(document.title),
    path: clean(document.path || document.sourcePath || document.title),
    moduleId: clean(document.moduleId),
    revision: clean(document.revision),
    content: String(document.content || "").trim().slice(0, 36_000),
  })).filter((document) => document.documentId && document.content).slice(0, 80);
  const documentsById = new Map(normalizedDocuments.map((document) => [document.documentId, document]));
  const existingByFingerprint = new Map(list(existingIssues)
    .filter((issue) => clean(issue.issueFingerprint || issue.sourceFingerprint))
    .map((issue) => [clean(issue.issueFingerprint || issue.sourceFingerprint), issue]));
  const result = await runModel({
    settings,
    system: creativeIntegritySystemPrompt(),
    messages: [{ role: "user", content: JSON.stringify({ trigger, documents: normalizedDocuments, existingIssues: [...existingByFingerprint.values()] }) }],
    signal,
    attachments: [],
  });
  const parsed = parseObject(result?.text);
  if (!parsed) throw new Error("一致性检查没有返回合法 JSON");
  const issues = list(parsed.issues).map((issue) => normalizedIssue(issue, documentsById)).filter(Boolean);
  const resolutions = list(parsed.resolutions)
    .map((resolution) => normalizedResolution(resolution, existingByFingerprint, documentsById)).filter(Boolean);
  return {
    issues,
    resolutions,
    checkedDocumentIds: normalizedDocuments.map((document) => document.documentId),
    providerResponseId: result?.responseId || result?.providerResponseId || "",
  };
};

