import { contextSourceSignature } from "./context-compiler.js";

const clean = (value = "", limit = 240) => String(value ?? "")
  .replace(/[\r\n<>]+/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, limit);

const sourceKind = (source = {}) => clean(source.kind || source.type || "resource", 80).toLowerCase();

export const contextSourceIsolationDecision = (source = {}) => {
  const kind = sourceKind(source);
  if (source.disabled === true) return { allowed: false, reason: "disabled_skill" };
  if (source.deleted === true || ["deleted_content", "trash", "recycle_bin"].includes(kind)) {
    return source.explicitAuthorization === "recover_deleted_content"
      ? { allowed: true, reason: "explicit_deleted_content_recovery" }
      : { allowed: false, reason: "deleted_content_isolated" };
  }
  if (source.historical === true || kind === "historical_conversation") {
    return source.explicitlyReferenced === true
      ? { allowed: true, reason: "explicit_historical_reference" }
      : { allowed: false, reason: "other_conversation_isolated" };
  }
  if (kind === "candidate" && source.active !== true) {
    return source.comparisonRequested === true
      ? { allowed: true, reason: "explicit_candidate_comparison" }
      : { allowed: false, reason: "unselected_candidate_isolated" };
  }
  if (kind === "conversation_branch" && source.active !== true) {
    return source.explicitlyReferenced === true
      ? { allowed: true, reason: "explicit_branch_reference" }
      : { allowed: false, reason: "inactive_branch_isolated" };
  }
  if (source.crossWorkspace === true) {
    return source.explicitlyReferenced === true
      ? { allowed: true, reason: "explicit_cross_workspace_reference" }
      : { allowed: false, reason: "other_workspace_isolated" };
  }
  if (source.included === false) return { allowed: false, reason: clean(source.reason || "not_selected_for_task") };
  return { allowed: true, reason: clean(source.reason || "selected_for_task") };
};

const manifestRecord = (source = {}, decision = contextSourceIsolationDecision(source)) => {
  const content = String(source.content ?? "");
  const chunkReceipts = Array.isArray(source.chunkReceipts) ? source.chunkReceipts : [];
  return {
    kind: sourceKind(source),
    id: clean(source.id || source.sourceId, 240),
    title: clean(source.title || source.name || source.id || source.sourceId, 240),
    version: clean(source.version || source.revision || "current", 120),
    contentLength: content.length,
    contentHash: clean(source.contentHash || source.sourceSignature || contextSourceSignature(content), 120),
    included: decision.allowed === true,
    required: source.required === true,
    fullSourceRead: source.fullSourceRead === true,
    compressed: source.compressed === true,
    chunksRead: Math.max(0, Number(source.chunksRead) || chunkReceipts.length || 0),
    sourceMessageIds: Array.isArray(source.sourceMessageIds)
      ? source.sourceMessageIds.map((id) => clean(id, 240)).filter(Boolean)
      : [],
    reason: clean(decision.reason, 160),
  };
};

export const buildContextSourceManifest = ({ requestId = "", sources = [] } = {}) => {
  const records = (Array.isArray(sources) ? sources : [])
    .map((source) => manifestRecord(source, contextSourceIsolationDecision(source)))
    .filter((record) => record.id);
  return {
    schemaVersion: 1,
    requestId: clean(requestId, 240),
    included: records.filter((record) => record.included),
    excluded: records.filter((record) => !record.included),
  };
};

const readLabel = (record = {}) => {
  if (!record.included) return `隔离：${record.reason}`;
  if (record.fullSourceRead && record.compressed) return "全文已读·压缩";
  if (record.fullSourceRead) return "全文已读";
  return "未声明全文读取";
};

export const contextManifestPrompt = (manifest = {}) => [
  "# 本轮上下文来源清单",
  "只有 included 中的来源可作为本轮事实；excluded 只记录隔离原因，不得读取其内容。",
  ...(Array.isArray(manifest.included) ? manifest.included : []).map((record) => (
    `- ${record.kind}:${record.id} | ${record.title || "-"} | ${readLabel(record)} | ${record.contentLength}/${record.contentHash} | ${record.reason}`
  )),
  ...(Array.isArray(manifest.excluded) ? manifest.excluded : []).map((record) => (
    `- [排除] ${record.kind}:${record.id} | ${record.title || "-"} | ${readLabel(record)}`
  )),
].join("\n");
