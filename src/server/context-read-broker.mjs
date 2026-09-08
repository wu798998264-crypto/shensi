import { createHash } from "node:crypto";
import { normalizeContextGapAssessment } from "../context-gap-contract.js";
import { compileContextSections, contextGateMarker, rankRelevantDocuments } from "../context-compiler.js";
import { classifyContextSource } from "../context-source-policy.js";
import { contextDocumentAllowed } from "../context-domain.js";
import { contextDocumentMayBeRead } from "../context-read-policy.js";
import { serverContextDocumentText } from "./server-context-verifier.mjs";
import { executionSourceMarker } from "./execution-source-proof.mjs";

const sha256 = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const abortError = () => Object.assign(new Error("资料补读已取消"), { name: "AbortError", code: "CONTEXT_READ_ABORTED" });
const assertNotAborted = (signal) => { if (signal?.aborted) throw abortError(); };

const documentMap = (documents) => {
  if (Array.isArray(documents)) return Object.fromEntries(documents.map((document) => [String(document?.id || ""), document]).filter(([id]) => id));
  return documents && typeof documents === "object" ? documents : {};
};

const manifestIds = (manifest, key) => (Array.isArray(manifest?.[key]) ? manifest[key] : [])
  .map((item) => String(typeof item === "string" ? item : item?.id || ""))
  .filter(Boolean);

const publicNeed = (need, code = "not_found") => ({
  id: String(need?.id || "context-need"),
  need: String(need?.need || "所需资料未找到").slice(0, 320),
  blocking: need?.blocking === true,
  reason: code,
});

const sourceRecord = (id, document, policy, compiledRecord = {}) => ({
  id,
  name: String(document?.title || id).slice(0, 200),
  type: policy.sourceKind,
  authority: policy.authority,
  includedReason: String(compiledRecord.reason || "可信资料代理召回").slice(0, 240),
  summaryHash: sha256(serverContextDocumentText(document, id)).slice(0, 16),
  truncated: compiledRecord.truncated === true,
  required: compiledRecord.required === true,
  fullText: compiledRecord.fullText === true,
  compressed: compiledRecord.compressed === true,
  sourceCharacters: Math.max(0, Number(compiledRecord.sourceCharacters) || 0),
  chunksRead: Math.max(0, Number(compiledRecord.chunksRead) || 0),
});

export async function resolveContextRequest({
  request,
  documents = {},
  project = {},
  target = {},
  initialManifest = {},
  initialContext = "",
  agentRequestedDocumentIds = [],
  budget = {},
  signal,
} = {}) {
  assertNotAborted(signal);
  const rawNeeds = Array.isArray(request?.needs) ? request.needs : [];
  const assessment = normalizeContextGapAssessment(request);
  if (assessment.sufficient) {
    return {
      status: "resolved",
      contextRevision: 1,
      prewriteContext: String(initialContext || ""),
      postwriteContext: String(initialContext || ""),
      manifest: { included: [], omitted: [], truncated: [], hardDependencies: [] },
      fulfilledNeedIds: [],
      unresolvedNeeds: [],
      warnings: [],
    };
  }
  if (!assessment.needs.length) {
    return {
      status: "rejected",
      contextRevision: 1,
      prewriteContext: "",
      postwriteContext: "",
      manifest: { included: [], omitted: [], truncated: [], hardDependencies: [] },
      fulfilledNeedIds: [],
      unresolvedNeeds: rawNeeds.slice(0, 6).map((need) => publicNeed(need, "request_rejected")),
      warnings: ["资料请求不符合可信读取合同"],
    };
  }

  const allDocuments = documentMap(documents);
  const allowedProjectIds = new Set((Array.isArray(project?.documentIds) ? project.documentIds : Object.keys(allDocuments))
    .map(String)
    .filter(Boolean));
  const currentProjectId = String(project?.id || target?.projectId || "");
  // 跨域资料默认不读取，但模型明确请求（硬依赖或首选文档）时允许跨域，例如改编或参考场景。
  const explicitlyReferencedIds = new Set([
    ...manifestIds(initialManifest, "hardDependencies"),
  ]);
  const explicitlyRequestedIds = new Set([
    ...explicitlyReferencedIds,
    ...assessment.needs.flatMap((need) => need.preferredDocumentIds || []),
  ]);
  const semanticRequestedIds = new Set((Array.isArray(agentRequestedDocumentIds) ? agentRequestedDocumentIds : []).map(String).filter(Boolean));
  const allowedDocuments = Object.fromEntries(Object.entries(allDocuments).filter(([id, document]) => {
    if (!allowedProjectIds.has(id)) return false;
    if (currentProjectId && document?.projectId && String(document.projectId) !== currentProjectId) return false;
    if (!contextDocumentAllowed({
      targetDomain: target?.domain,
      documentDomain: document?.domain,
      explicit: explicitlyRequestedIds.has(id) || semanticRequestedIds.has(id),
    })) return false;
    if (!contextDocumentMayBeRead({
      documentId: id,
      title: document?.title || id,
      moduleId: document?.moduleId,
      document,
      instruction: target?.instruction || "",
      targetDomain: target?.domain,
      explicitlyReferenced: explicitlyReferencedIds.has(id),
      agentRequested: semanticRequestedIds.has(id),
    })) return false;
    const policy = classifyContextSource({ document: { ...document, id }, moduleId: document?.moduleId, domain: document?.domain });
    return policy.canUseAsReference;
  }));
  const policyFor = (id) => classifyContextSource({ document: { ...allowedDocuments[id], id }, moduleId: allowedDocuments[id]?.moduleId, domain: allowedDocuments[id]?.domain });
  const hardDependencyIds = [...new Set([
    ...manifestIds(initialManifest, "hardDependencies"),
    ...(Array.isArray(initialManifest?.included) ? initialManifest.included.filter((item) => item?.required === true).map((item) => String(item.id || "")) : []),
  ])].filter((id) => allowedDocuments[id]);
  const initialIds = manifestIds(initialManifest, "included").filter((id) => allowedDocuments[id]);
  const requestedMaxDocuments = Number(budget?.maxDocuments);
  const requestedMaxCharacters = Number(budget?.maxCharacters);
  const maxDocuments = Number.isFinite(requestedMaxDocuments) && requestedMaxDocuments > 0
    ? Math.max(hardDependencyIds.length, requestedMaxDocuments)
    : Number.POSITIVE_INFINITY;
  const maxCharacters = Number.isFinite(requestedMaxCharacters) && requestedMaxCharacters > 0
    ? Math.max(800, requestedMaxCharacters)
    : Number.POSITIVE_INFINITY;
  const selected = [...new Set([...hardDependencyIds, ...initialIds])].slice(0, maxDocuments);
  const fulfilledNeedIds = [];
  const unresolvedNeeds = [];
  const reasons = new Map(selected.map((id) => [id, hardDependencyIds.includes(id) ? ["本轮硬依赖"] : ["初始上下文来源"]]));

  for (const need of assessment.needs) {
    assertNotAborted(signal);
    const candidateIds = Object.keys(allowedDocuments).filter((id) => {
      const policy = policyFor(id);
      return need.sourceKinds.includes(policy.sourceKind);
    });
    const preferred = need.preferredDocumentIds.filter((id) => candidateIds.includes(id));
    const ranked = rankRelevantDocuments({
      ids: candidateIds.filter((id) => !preferred.includes(id)),
      query: [need.query, need.need, ...need.entityIds].join(" "),
      titleFor: (id) => allowedDocuments[id]?.title || id,
      contentFor: (id) => serverContextDocumentText(allowedDocuments[id], id, { titleFor: (targetId) => allowedDocuments[targetId]?.title || targetId }),
      limit: maxDocuments,
    }).map((item) => item.id);
    const matches = [...new Set([...preferred, ...ranked])];
    if (!matches.length) {
      unresolvedNeeds.push(publicNeed(need));
      continue;
    }
    fulfilledNeedIds.push(need.id);
    for (const id of matches) {
      if (!selected.includes(id) && Number.isFinite(maxDocuments) && selected.length >= maxDocuments) break;
      if (!selected.includes(id)) selected.push(id);
      reasons.set(id, [...new Set([...(reasons.get(id) || []), `补读：${need.need}`])]);
      if (Number.isFinite(maxDocuments) && selected.length >= maxDocuments) break;
    }
  }
  assertNotAborted(signal);

  const combinedQuery = assessment.needs.map((need) => `${need.need} ${need.query} ${need.entityIds.join(" ")}`).join("\n");
  const compile = (writingPhase) => compileContextSections({
    ids: selected,
    requiredIds: hardDependencyIds,
    fullDocumentIds: selected,
    titleFor: (id) => allowedDocuments[id]?.title || id,
    contentFor: (id) => serverContextDocumentText(allowedDocuments[id], id, { titleFor: (targetId) => allowedDocuments[targetId]?.title || targetId }),
    maxCharacters,
    perDocumentLimit: maxCharacters,
    query: combinedQuery,
    reasonsFor: (id) => reasons.get(id) || ["可信资料代理召回"],
    authorityFor: (id) => policyFor(id).authority,
    preserveLatestFor: (id) => policyFor(id).sourceKind === "state" || /snapshot$/i.test(id),
    sourceMarkerFor: (id, content) => executionSourceMarker({
      kind: "document",
      id,
      revision: allowedDocuments[id]?.revision || allowedDocuments[id]?.updatedAt || "current",
      content,
    }),
    focused: false,
  });
  const prewrite = compile("prewrite");
  const postwrite = compile("postwrite");
  const blockingUnresolved = unresolvedNeeds.some((need) => need.blocking);
  const status = blockingUnresolved || prewrite.missingRequiredIds.length ? "needs_confirmation" : unresolvedNeeds.length ? "partial" : "resolved";
  const compiledById = new Map(prewrite.manifest.map((item) => [item.id, item]));
  const records = Object.fromEntries(Object.keys(allowedDocuments).map((id) => [id, sourceRecord(id, allowedDocuments[id], policyFor(id), compiledById.get(id))]));
  const included = prewrite.includedIds.map((id) => records[id]);
  const omitted = [...new Set([...prewrite.omittedIds, ...Object.keys(allowedDocuments).filter((id) => !selected.includes(id))])].map((id) => records[id]).filter(Boolean);
  const truncated = prewrite.truncatedIds.map((id) => records[id]).filter(Boolean);
  const hardDependencies = hardDependencyIds.map((id) => records[id]).filter(Boolean);
  const header = [
    contextGateMarker({ status: status === "needs_confirmation" ? "blocked" : "ready", missingRequiredIds: prewrite.missingRequiredIds }),
    "# 可信资料补读",
    "以下内容由本地可信读取代理从当前项目允许资料中重新编译；模型未直接访问文件系统。",
  ].join("\n\n");
  return {
    status,
    contextRevision: 2,
    prewriteContext: `${header}\n\n${prewrite.text}`.trim(),
    postwriteContext: `${header}\n\n${postwrite.text}`.trim(),
    manifest: { included, omitted, truncated, hardDependencies },
    fulfilledNeedIds,
    unresolvedNeeds,
    warnings: [
      ...(prewrite.truncatedIds.length ? ["部分资料因上下文预算被截取"] : []),
      ...(blockingUnresolved ? ["仍有必读资料缺口；需告知用户并由用户选择补读或按现有资料继续"] : []),
    ],
  };
}

export function createServerContextReadBroker({
  documents = {},
  project = {},
  target = {},
  initialManifest = {},
  initialContext = "",
  agentRequestedDocumentIds = [],
} = {}) {
  const snapshotDocuments = structuredClone(documentMap(documents));
  const snapshotProject = structuredClone(project && typeof project === "object" ? project : {});
  const snapshotTarget = structuredClone(target && typeof target === "object" ? target : {});
  const snapshotManifest = structuredClone(initialManifest && typeof initialManifest === "object" ? initialManifest : {});
  const snapshotAgentRequestedDocumentIds = [...new Set((Array.isArray(agentRequestedDocumentIds) ? agentRequestedDocumentIds : []).map(String).filter(Boolean))];
  const snapshotVersion = sha256(JSON.stringify(Object.keys(snapshotDocuments).sort().map((id) => ({
    id,
    title: snapshotDocuments[id]?.title || "",
    moduleId: snapshotDocuments[id]?.moduleId || "",
    domain: snapshotDocuments[id]?.domain || "",
    contentHash: sha256(serverContextDocumentText(snapshotDocuments[id], id)),
  }))));
  return async ({ request, budget, signal } = {}) => ({
    ...await resolveContextRequest({
      request,
      documents: snapshotDocuments,
      project: snapshotProject,
      target: snapshotTarget,
      initialManifest: snapshotManifest,
      initialContext,
      agentRequestedDocumentIds: snapshotAgentRequestedDocumentIds,
      budget,
      signal,
    }),
    snapshotVersion,
  });
}
