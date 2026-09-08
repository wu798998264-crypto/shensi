import { compileContextSections, contextCompilationBudget, contextGateMarker } from "../context-compiler.js";
import { contextSourceAuthority } from "../context-source-policy.js";
import { projectContextDocumentText } from "../context-content-policy.js";
import { documentContentState } from "../version-store.js";
import { executionSourceMarker } from "./execution-source-proof.mjs";
import { formalDocumentContentPolicy } from "../formal-content-policy.js";
import { reviewContextPlan } from "../review-context-plan.js";
import { contextDocumentAllowed } from "../context-domain.js";
import { contextDocumentMayBeRead } from "../context-read-policy.js";

const SOURCE_MARKER = /<!--\s*shensi-context-source\s+({[^\n]*})\s*-->/g;
const SELECTION_BLOCK = /<!--\s*shensi-context-selection\s+({[^\n]*})\s*-->\s*\n([\s\S]*?)\n<!--\s*\/shensi-context-selection\s*-->/g;

const decodeEntities = (value) => String(value || "")
  .replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

export const serverDocumentText = (document = {}) => {
  const source = [document.html, document.content, document.markdown, document.text]
    .map((value) => String(value ?? ""))
    .find((value) => value.replace(/<[^>]+>/gu, " ").replace(/&nbsp;|&#160;/giu, " ").trim()) || "";
  return decodeEntities(source
  .replace(/<\s*br\s*\/?\s*>/gi, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
};

export const serverContextDocumentText = (document = {}, documentId = document?.id || "", { titleFor = (id) => id } = {}) => projectContextDocumentText({
  documentId,
  text: serverDocumentText(document),
  continuityDelta: document?.continuityDelta,
  labelFor: titleFor,
});

export const suppliedContextSources = (context = "") => {
  const records = new Map();
  for (const match of String(context || "").matchAll(SOURCE_MARKER)) {
    try {
      const parsed = JSON.parse(match[1]);
      const id = String(parsed?.id || "").trim();
      if (!id || records.has(id)) continue;
      records.set(id, {
        id,
        required: parsed.required === true,
        authority: ["canon", "plan", "memory", "reference"].includes(parsed.authority) ? parsed.authority : "reference",
      });
    } catch {}
  }
  return [...records.values()];
};

const nonCanonCreativeIntent = (context = "") => String(context || "")
  .match(/# 已确认的长篇创作意图（非 canon）\s*\n([\s\S]*?)(?=\n# |\n## |$)/)?.[1]
  ?.trim()
  .slice(0, 6_000) || "";

const normalizedSelection = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

const verifiedContextSelections = ({ suppliedContext = "", documents = {} } = {}) => {
  const selections = [];
  for (const match of String(suppliedContext).matchAll(SELECTION_BLOCK)) {
    try {
      const metadata = JSON.parse(match[1]);
      const documentId = String(metadata?.id || "").trim();
      const selected = String(match[2] || "").trim().slice(0, 40_000);
      const current = normalizedSelection(serverDocumentText(documents[documentId]));
      if (!documentId || !selected || !current.includes(normalizedSelection(selected))) continue;
      selections.push({ documentId, title: documents[documentId]?.title || documentId, text: selected });
    } catch {}
  }
  return selections.slice(0, 4);
};

export const compileServerVerifiedContext = ({
  suppliedContext = "",
  documents = {},
  prompt = "",
  targetDocumentId = "",
  explicitReferenceDocumentIds = [],
  declaredRequiredIds = [],
  fullDocumentIds = [],
  agentRequestedDocumentIds = [],
  writingPhase = "prewrite",
  reviewSourceDocumentIds = [],
} = {}) => {
  const sources = suppliedContextSources(suppliedContext);
  const ids = new Set(sources.map((item) => item.id));
  const explicitIds = new Set(explicitReferenceDocumentIds.map(String).filter(Boolean));
  const semanticIds = new Set((Array.isArray(agentRequestedDocumentIds) ? agentRequestedDocumentIds : []).map(String).filter(Boolean));
  const reviewIds = new Set((Array.isArray(reviewSourceDocumentIds) ? reviewSourceDocumentIds : []).map(String).filter(Boolean));
  const targetDomain = documents[targetDocumentId]?.contextDomain || documents[targetDocumentId]?.domain || "novel";
  const mayRead = (id) => {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return false;
    const document = documents[normalizedId];
    if (!document) return false;
    const explicit = explicitIds.has(normalizedId) || semanticIds.has(normalizedId) || reviewIds.has(normalizedId);
    if (!contextDocumentAllowed({
      targetDomain,
      documentDomain: document?.contextDomain || document?.domain || "novel",
      explicit,
    })) return false;
    return contextDocumentMayBeRead({
      documentId: normalizedId,
      title: document?.title || normalizedId,
      moduleId: document?.moduleId,
      document,
      instruction: prompt,
      targetDomain,
      explicitlyReferenced: explicitIds.has(normalizedId) || reviewIds.has(normalizedId),
      agentRequested: semanticIds.has(normalizedId),
    });
  };
  // Client-supplied source markers are declarations only. Keep them only when
  // the current server-side policy authorizes the corresponding document.
  for (const id of [...ids]) if (!mayRead(id)) ids.delete(id);
  const emptyOutputTarget = Boolean(
    targetDocumentId
    && documents[targetDocumentId]
    && documentContentState(serverDocumentText(documents[targetDocumentId]), {
      title: documents[targetDocumentId]?.title || "",
      placeholder: documents[targetDocumentId]?.placeholder || "",
    }) !== "substantive"
    && !explicitIds.has(String(targetDocumentId)),
  );
  for (const id of explicitReferenceDocumentIds) if (mayRead(id)) ids.add(String(id || ""));
  for (const id of fullDocumentIds) {
    const normalizedId = String(id || "");
    if (emptyOutputTarget && normalizedId === String(targetDocumentId)) continue;
    if (mayRead(normalizedId)) ids.add(normalizedId);
  }
  if (targetDocumentId && documents[targetDocumentId]
    && formalDocumentContentPolicy({ documentId: targetDocumentId, moduleId: documents[targetDocumentId].moduleId }).mode !== "review_report") ids.add(targetDocumentId);
  const requiredIds = [...new Set([
    ...sources.filter((item) => item.required).map((item) => item.id),
    ...explicitReferenceDocumentIds.map(String).filter((id) => mayRead(id)),
    ...declaredRequiredIds.map(String).filter(Boolean),
    ...fullDocumentIds.map(String).filter((id) => mayRead(id)),
    ...reviewContextPlan({ sourceDocumentIds: reviewSourceDocumentIds, documents, contentFor: (id) => serverContextDocumentText(documents[id], id) }).requiredDocumentIds,
  ])].filter((id) => !(emptyOutputTarget && id === String(targetDocumentId)));
  for (const id of requiredIds) ids.add(id);
  const authorityFor = (id) => contextSourceAuthority(documents[id], documents[id]?.moduleId, id);
  // A declared dependency cannot silently become a relevance-picked excerpt.
  // Re-read it from the current workspace; authority and budget gates still apply.
  const fullRequiredCharacters = requiredIds
    .reduce((sum, id) => sum + serverContextDocumentText(documents[id], id).length, 0);
  const budget = contextCompilationBudget({
    modelContextCharacters: Math.max(96_000, String(suppliedContext || "").length * 2, Math.ceil(fullRequiredCharacters / 0.58) + 20_000),
    mode: "creative",
    selectedDocumentCount: ids.size,
  });
  const compiled = compileContextSections({
    ids: [...ids].filter((id) => mayRead(id)),
    requiredIds,
    fullDocumentIds: requiredIds,
    titleFor: (id) => documents[id]?.title || id,
    contentFor: (id) => !mayRead(id) || authorityFor(id) === "deprecated"
      ? ""
      : serverContextDocumentText(documents[id], id, { titleFor: (targetId) => documents[targetId]?.title || targetId }),
    maxCharacters: budget.maxCharacters,
    perDocumentLimit: budget.perDocumentLimit,
    query: [prompt, documents[targetDocumentId]?.title].filter(Boolean).join("\n"),
    reasonFor: (id) => requiredIds.includes(id) ? "服务端核验的本轮硬依赖" : "服务端按客户端清单重新读取",
    // Authority is recomputed from the current workspace document. A client
    // source marker may declare the read list and hard dependencies, but may
    // not promote a retired/reference document into canon.
    authorityFor,
    preserveLatestFor: (id) => /memory-snapshot$/.test(id),
    sourceMarkerFor: (id, content, options) => options.fullText
      ? executionSourceMarker({ kind: "document", id, revision: documents[id]?.revision || documents[id]?.updatedAt || "current", content })
      : "",
  });
  // Missing explicit references are reported as recoverable. The server must
  // never silently claim they were read, but a user-confirmed fresh start can
  // proceed with the available context and still land into the authorized
  // target.
  const status = compiled.missingRequiredIds.length ? "recoverable" : "ready";
  const creativeIntent = nonCanonCreativeIntent(suppliedContext);
  const selections = verifiedContextSelections({ suppliedContext, documents });
  const manifest = compiled.manifest.map((item) => (
    `- ${item.included ? "已读" : "未读"}｜${item.id}｜${documents[item.id]?.title || item.id}｜${item.reason}${item.required ? "｜硬依赖" : ""}`
  ));
  return {
    status,
    missingRequiredIds: compiled.missingRequiredIds,
    includedIds: compiled.includedIds,
    manifest: {
      included: compiled.manifest.filter((item) => item.included).map((item) => ({ ...item })),
      omitted: compiled.manifest.filter((item) => !item.included).map((item) => ({ ...item })),
      truncated: compiled.manifest.filter((item) => item.truncated).map((item) => ({ ...item })),
      hardDependencies: compiled.manifest.filter((item) => item.required).map((item) => ({ ...item })),
    },
    context: [
      contextGateMarker({ status: status === "recoverable" ? "blocked" : status, missingRequiredIds: compiled.missingRequiredIds }),
      "# 服务端现场读取说明",
      "以下资料由本地服务端从当前工作区文件重新读取；客户端传入正文只用于声明读取清单，不作为正史来源。",
      `本轮目标文档：${targetDocumentId || "未指定"}`,
      creativeIntent ? `# 客户端声明的已确认创作意图（非正史偏好）\n${creativeIntent}` : "",
      ...selections.map((selection) => `# 服务端核验的当前选中文字\n来源文档：${selection.title}\n${selection.text}`),
      compiled.text,
      "# 上下文读取清单",
      ...manifest,
    ].filter(Boolean).join("\n\n"),
  };
};
