import { validateMemoryProjectionFormat } from "./structured-memory-store.js";

const text = (value = "") => String(value ?? "").trim();
const plain = (value = "") => text(value)
  .replace(/<br\s*\/?\s*>/giu, "\n")
  .replace(/<\/(?:h[1-6]|p|div|li)>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const CANON_SCHEMAS = Object.freeze({
  "canon-characters": { id: "shensi.canon.characters.v1", label: "人物设定", record: "人物", fields: ["身份与定位", "核心目标", "性格与行为边界", "能力与限制", "当前状态"] },
  "canon-relations": { id: "shensi.canon.relations.v1", label: "人物关系", record: "关系", fields: ["关系双方", "当前关系", "利益或情感纽带", "冲突与变化条件"] },
  "canon-world": { id: "shensi.canon.world.v1", label: "世界观与基础规则", record: "规则或设定域", fields: ["当前规则", "适用范围", "限制与代价", "例外条件"] },
  "canon-locations": { id: "shensi.canon.locations.v1", label: "地图与地点", record: "地点", fields: ["位置与层级", "环境特征", "功能", "进入条件与风险"] },
  "canon-factions": { id: "shensi.canon.factions.v1", label: "势力与组织", record: "势力", fields: ["目标", "结构", "资源", "关系与冲突"] },
  "canon-events": { id: "shensi.canon.events.v1", label: "事件与时间线", record: "事件", fields: ["时间位置", "参与者", "原因", "结果与后续影响"] },
  "canon-items": { id: "shensi.canon.items.v1", label: "物品与道具", record: "物品", fields: ["归属", "功能", "限制或代价", "当前状态"] },
  "canon-glossary": { id: "shensi.canon.glossary.v1", label: "术语表", record: "术语", fields: ["定义", "适用范围", "禁止混淆项"] },
});

const scriptCanonSchema = (documentId = "") => {
  const baseId = String(documentId).replace(/^script-/, "");
  const base = CANON_SCHEMAS[baseId];
  return base ? { ...base, id: base.id.replace("shensi.canon", "shensi.script-canon"), label: `剧本${base.label}`, adaptation: true } : null;
};

const INDEX_SCHEMAS = Object.freeze({
  "index-language-blacklist": { id: "shensi.index.creative-contract.v1", label: "创作合同", systemManaged: true, fields: ["项目禁用词", "特别注意事项"] },
  "index-pending": { id: "shensi.index.pending-decisions.v1", label: "待确认事项", systemManaged: true, fields: ["question", "sourcePath", "status", "affectedScopes", "structuredNotices"] },
  "index-update-log": { id: "shensi.index.update-log.v1", label: "更新日志", systemManaged: true, fields: ["sourceCommit", "changedDocuments", "verifiedAt"] },
});

export const managedDocumentSchemaFor = ({ documentId = "", moduleId = "" } = {}) => {
  const id = text(documentId);
  if (CANON_SCHEMAS[id]) return { ...CANON_SCHEMAS[id], moduleId: "canon", version: 1 };
  const script = scriptCanonSchema(id);
  if (script) return { ...script, moduleId: "canon", version: 1 };
  if (INDEX_SCHEMAS[id]) return { ...INDEX_SCHEMAS[id], moduleId: "index", version: 1 };
  if (moduleId === "memory" || /^(?:memory-|script-memory-)/u.test(id)) {
    return { id: "shensi.memory.projection.v1", label: "结构化记忆投影", moduleId: "memory", version: 1, systemManaged: true };
  }
  return null;
};

export const managedDocumentFormatInstruction = (targets = []) => {
  const schemas = (Array.isArray(targets) ? targets : [])
    .map((target) => managedDocumentSchemaFor({ documentId: target?.documentId, moduleId: target?.moduleId }))
    .filter((schema) => schema?.moduleId === "canon");
  if (!schemas.length) return "";
  return [
    "# 设定文档格式合同",
    ...schemas.map((schema) => `- ${schema.label}（${schema.id}）：每个“${schema.record}”使用二级标题独立成项；内部按三级标题或明确字段维护${schema.fields.join("、")}。只写当前有效设定，不写执行过程、自检报告、旧版本或大纲正文。`),
    "原文已有明确结构时优先保持其结构并做最小范围更新；不得为了套模板删除用户已有字段。",
  ].join("\n");
};

const FOREIGN_TOP_LEVEL_PATTERN = /^(?:#{1,3}\s*)?(?:第\s*[零〇一二两三四五六七八九十百千万\d]+\s*章|全集大纲|全书大纲|卷纲|章纲|小说自检|剧本自检|任务完成|执行说明)(?:\s|[：:—-]|$)/mu;

export const validateManagedDocumentFormat = ({ documentId = "", moduleId = "", content = "", systemProjection = false } = {}) => {
  const schema = managedDocumentSchemaFor({ documentId, moduleId });
  if (!schema) return { valid: true, schema: null, reason: "unmanaged_document" };
  if (schema.systemManaged && systemProjection !== true && schema.moduleId !== "canon") {
    return { valid: false, schema, reason: "system_managed_document" };
  }
  if (schema.moduleId === "memory" && systemProjection === true) {
    const projection = validateMemoryProjectionFormat({ documentId, content });
    return { ...projection, schema };
  }
  const body = plain(content);
  if (!body) return { valid: false, schema, reason: "managed_document_empty" };
  if (schema.moduleId === "canon" && FOREIGN_TOP_LEVEL_PATTERN.test(String(content))) {
    return { valid: false, schema, reason: "foreign_document_type_content" };
  }
  return { valid: true, schema, reason: "format_contract_satisfied" };
};

export const managedDocumentFormatMetadata = ({ documentId = "", moduleId = "", source = "trusted-write", validatedAt = new Date().toISOString() } = {}) => {
  const schema = managedDocumentSchemaFor({ documentId, moduleId });
  return schema ? { schemaId: schema.id, schemaVersion: schema.version, source, validatedAt } : null;
};
