import { structurePlacementAllows } from "./structure-placement.js";
import { scanInternalArtifactLeakage, scanNovelLanguage } from "./content-guard.js";

export const WORKSPACE_MODULE_IDS = ["manuscript", "outline", "canon", "memory", "reports", "library", "index"];

export const WORKSPACE_OPERATION_TYPES = [
  "folder.ensure",
  "folder.rename",
  "document.create",
  "document.rename",
  "document.replace_text",
  "document.replace_content",
  "document.append_content",
  "document.clear",
  "document.delete",
  "document.move",
  "document.reorder",
  "scope.clear",
  "history.save_document",
  "history.restore",
  "history.delete",
  "trash.restore",
  "project.create",
  "notebook.create",
  "project.rename",
  "project.switch",
  "project.delete",
];

const OPERATION_PATTERN = /(?:清空|删除|移除|重命名|命名|改名|新建|创建|移动|移到|追加|写入|替换|恢复|找回|取回|捞回|还原|切换|保存版本|版本保存|调整顺序).{0,40}(?:文档|文件|文件夹|章节|第\s*\d+\s*章|正文|设定|大纲|卷纲|章纲|集纲|板块|目录|作品|笔记本|历史对话|对话|历史版本|版本\s*\d+|回收站)|(?:把|将).{0,48}(?:文档|文件|文件夹|章节|第\s*\d+\s*章|正文|设定|大纲|历史对话|对话|历史版本|版本\s*\d+|回收站).{0,36}(?:清空|删除|移除|重命名|命名|改名|改成|移动|移到|追加|写入|替换|恢复|找回|取回|捞回|还原|设为当前|保存为历史版本)|(?:给|为).{0,36}(?:文件夹|目录).{0,20}(?:命名|改名|重命名)|(?:把|将)?.{0,30}(?:当前文档|当前内容|正文|第\s*\d+\s*章).{0,16}保存为历史版本/;
const NEGATED_OPERATION_CLAUSE_PATTERN = /(?:不|不要|不用|无需|不必|别|禁止|无法|不能|不可|未能)(?:(?:再|要)?\s*(?:对.{0,8})?(?:清空|删除|移除|重命名|命名|改名|新建|创建|移动|移到|追加|写入|替换|恢复|找回|取回|捞回|还原|切换|保存版本|版本保存|调整顺序).{0,40}?(?:文档|文件|文件夹|章节|第\s*\d+\s*章|正文|设定|大纲|卷纲|章纲|集纲|板块|目录|作品|历史对话|对话|历史版本|版本\s*\d+|回收站)|\s*(?:给|为).{0,36}(?:文件夹|目录).{0,20}(?:命名|改名|重命名))/g;
const EXPLICIT_OPERATION_TYPE_PATTERN = /\b(?:folder\.(?:ensure|rename)|document\.(?:create|rename|replace_text|replace_content|append_content|clear|delete|move|reorder)|scope\.clear|history\.(?:save_document|restore|delete)|trash\.restore|project\.(?:create|rename|switch|delete)|notebook\.create)\b/;
const NEGATED_EXPLICIT_OPERATION_TYPE_PATTERN = /(?:不|不要|不用|无需|不必|别|禁止|无法|不能|不可|未能)(?:再|要)?\s*(?:使用|调用|执行)?\s*\b(?:folder\.|document\.|scope\.|history\.|trash\.|project\.|notebook\.)/;

const cleanText = (value, max = 20_000) => String(value ?? "").trim().slice(0, max);
const cleanId = (value, max = 180) => String(value ?? "").trim().slice(0, max);
const validModule = (value) => WORKSPACE_MODULE_IDS.includes(value) ? value : null;
const validView = (value) => ["novel", "script", "prompts"].includes(value) ? value : "novel";
const validScopeView = (value) => ["novel", "script", "prompts"].includes(value) ? value : null;

export const looksLikeWorkspaceOperation = (value = "") => {
  const source = String(value);
  if (EXPLICIT_OPERATION_TYPE_PATTERN.test(source) && !NEGATED_EXPLICIT_OPERATION_TYPE_PATTERN.test(source)) return true;
  if (!OPERATION_PATTERN.test(source)) return false;
  // A creative revision often constrains scope with phrases such as
  // “不要新建设定或大纲”. Those are prohibitions, not operation requests.
  // Remove only negated operation clauses and then check whether a positive
  // workspace mutation remains elsewhere in the instruction.
  return OPERATION_PATTERN.test(source.replace(NEGATED_OPERATION_CLAUSE_PATTERN, " "));
};

const formalProseLocation = (location = {}) => location?.moduleId === "manuscript"
  && ["novel", "script"].includes(location?.viewId);

const literalReplacement = (source, find, replacement, replaceAll = false) => {
  const text = String(source ?? "");
  const needle = String(find ?? "");
  if (!needle) return text;
  return replaceAll ? text.split(needle).join(String(replacement ?? "")) : text.replace(needle, String(replacement ?? ""));
};

const occurrenceCounts = (items = []) => {
  const counts = new Map();
  for (const item of items) {
    const key = `${item?.id || ""}|${item?.term || ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

export const workspaceProseMutationViolations = ({
  plan = null,
  documentTexts = {},
  documentLocations = [],
  absoluteTerms = [],
  referenceTextsByDocument = {},
} = {}) => {
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  if (!operations.length) return [];
  const texts = new Map(Object.entries(documentTexts ?? {}).map(([id, value]) => [String(id), String(value ?? "")]));
  const locations = new Map((Array.isArray(documentLocations) ? documentLocations : Object.values(documentLocations ?? {}))
    .map((item) => [String(item?.id || item?.documentId || ""), { moduleId: item?.moduleId, viewId: item?.viewId }])
    .filter(([id]) => id));
  const mutations = new Map();
  const remember = (documentId, { before = "", after = "", location = {}, full = false } = {}) => {
    const existing = mutations.get(documentId);
    mutations.set(documentId, {
      documentId,
      before: existing?.before ?? String(before ?? ""),
      after: String(after ?? ""),
      location,
      full: existing?.full === true || full === true,
    });
  };

  operations.forEach((operation, operationIndex) => {
    if (!operation || typeof operation !== "object") return;
    if (operation.type === "document.create") {
      const documentId = `create:${operationIndex}`;
      const location = { moduleId: operation.moduleId, viewId: operation.viewId };
      const after = String(operation.content ?? "");
      if (formalProseLocation(location) && after.trim()) remember(documentId, { before: "", after, location, full: true });
      return;
    }
    const documentId = String(operation.documentId ?? "");
    if (!documentId) return;
    const before = texts.get(documentId) ?? "";
    const previousLocation = locations.get(documentId) ?? {};
    let location = previousLocation;
    let after = before;
    let contentChanged = false;
    let full = false;
    if (operation.type === "document.replace_content") {
      after = String(operation.content ?? "");
      contentChanged = true;
      full = true;
    } else if (operation.type === "document.append_content") {
      const addition = String(operation.content ?? "").trim();
      after = [before.trimEnd(), addition].filter(Boolean).join("\n\n");
      contentChanged = Boolean(addition);
    } else if (operation.type === "document.replace_text") {
      after = literalReplacement(before, operation.find, operation.replace, operation.replaceAll === true);
      contentChanged = after !== before;
    } else if (operation.type === "document.clear") {
      after = "";
      contentChanged = before.length > 0;
    } else if (operation.type === "document.move") {
      location = { moduleId: operation.moduleId, viewId: operation.viewId };
      locations.set(documentId, location);
      full = !formalProseLocation(previousLocation) && formalProseLocation(location);
    } else if (operation.type === "document.delete") {
      texts.delete(documentId);
      mutations.delete(documentId);
      return;
    }
    if (contentChanged) texts.set(documentId, after);
    const movedIntoFormalProse = operation.type === "document.move" && full;
    if ((contentChanged || movedIntoFormalProse) && formalProseLocation(location)) {
      remember(documentId, { before, after, location, full });
    } else if (operation.type === "document.move" && !formalProseLocation(location)) {
      mutations.delete(documentId);
    } else if (contentChanged && mutations.has(documentId)) {
      remember(documentId, { before, after, location, full });
    }
  });

  const violations = [];
  for (const mutation of mutations.values()) {
    if (!formalProseLocation(mutation.location) || !mutation.after.trim()) continue;
    const references = typeof referenceTextsByDocument === "function"
      ? referenceTextsByDocument(mutation.documentId)
      : referenceTextsByDocument?.[mutation.documentId];
    const scanOptions = {
      absoluteTerms,
      referenceTexts: Array.isArray(references) ? references : [],
    };
    const afterLanguage = scanNovelLanguage(mutation.after, scanOptions);
    const beforeLanguage = mutation.full ? scanNovelLanguage("") : scanNovelLanguage(mutation.before, scanOptions);
    const beforeAbsoluteCounts = occurrenceCounts(beforeLanguage.absoluteViolations);
    const emittedAbsoluteCounts = new Map();
    for (const issue of afterLanguage.absoluteViolations) {
      const key = `${issue.id || ""}|${issue.term || ""}`;
      const emitted = (emittedAbsoluteCounts.get(key) ?? 0) + 1;
      emittedAbsoluteCounts.set(key, emitted);
      if (!mutation.full && emitted <= (beforeAbsoluteCounts.get(key) ?? 0)) continue;
      violations.push({ ...issue, kind: "language", documentId: mutation.documentId });
    }
    const beforeFamilyCounts = new Map(beforeLanguage.frequencySummary.map((item) => [item.id, item.count]));
    for (const issue of afterLanguage.frequencyViolations) {
      const familyId = String(issue.id || "").replace(/:window-\d+$/u, "");
      if (!mutation.full && issue.count <= (beforeFamilyCounts.get(familyId) ?? 0)) continue;
      violations.push({
        ...issue,
        kind: "frequency",
        documentId: mutation.documentId,
        term: `${issue.count} 处 / 上限 ${issue.ceiling} 处`,
      });
    }

    const afterArtifacts = scanInternalArtifactLeakage(mutation.after).violations;
    const beforeArtifactCounts = occurrenceCounts(mutation.full ? [] : scanInternalArtifactLeakage(mutation.before).violations);
    const emittedArtifactCounts = new Map();
    for (const issue of afterArtifacts) {
      const key = `${issue.id || ""}|${issue.term || ""}`;
      const emitted = (emittedArtifactCounts.get(key) ?? 0) + 1;
      emittedArtifactCounts.set(key, emitted);
      if (!mutation.full && emitted <= (beforeArtifactCounts.get(key) ?? 0)) continue;
      violations.push({ ...issue, kind: "artifact", documentId: mutation.documentId });
    }
  }
  const unique = new Map(violations.map((issue) => [
    `${issue.documentId}|${issue.kind}|${issue.id}|${issue.term}`,
    issue,
  ]));
  return [...unique.values()];
};

export const contentRevision = (value = "") => {
  let hash = 2166136261;
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const workspaceOperationPlanHash = (operations = []) => contentRevision(JSON.stringify(operations ?? []));

export const bindWorkspaceOperationConfirmation = (plan, {
  required = true,
  source = "model_planner",
  reason = "操作目标或影响范围包含规划判断，需要用户确认后执行",
  workspaceRevision = "",
} = {}) => {
  if (!plan?.operations?.length) return plan;
  return {
    ...plan,
    confirmation: {
      required: required !== false,
      source: String(source || "model_planner"),
      reason: String(reason || "").trim(),
      planHash: workspaceOperationPlanHash(plan.operations),
      workspaceRevision: String(workspaceRevision || ""),
      status: required === false ? "authorized_by_instruction" : "pending",
      confirmedAt: "",
    },
  };
};

export const workspaceOperationConfirmationIsCurrent = (plan, { workspaceRevision = "" } = {}) => {
  if (!plan?.operations?.length || !plan.confirmation) return false;
  if (plan.confirmation.planHash !== workspaceOperationPlanHash(plan.operations)) return false;
  const expectedWorkspaceRevision = String(plan.confirmation.workspaceRevision || "");
  return !expectedWorkspaceRevision || expectedWorkspaceRevision === String(workspaceRevision || "");
};

export const findWorkspaceTextBlockRange = ({ blocks = [], find = "", startIndex = 0 } = {}) => {
  const target = String(find ?? "").replace(/\r\n?/g, "\n").trim();
  if (!target || !Array.isArray(blocks) || !blocks.length) return null;
  const normalizedBlocks = blocks.map((block) => String(block ?? "").replace(/\r\n?/g, "\n").trim());
  for (let start = Math.max(0, Number(startIndex) || 0); start < normalizedBlocks.length; start += 1) {
    let joined = "";
    for (let end = start; end < normalizedBlocks.length; end += 1) {
      joined = joined ? `${joined}\n\n${normalizedBlocks[end]}` : normalizedBlocks[end];
      if (joined === target) return { start, end };
      if (joined.length >= target.length) break;
    }
  }
  return null;
};

export const normalizeBackupScope = (value, { documentIds = [] } = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = ["document", "volume", "view", "module", "project"].includes(value.type) ? value.type : null;
  if (!type) return null;
  if (type === "project") return { type: "project", id: "project" };
  if (type === "document") {
    const documentId = cleanId(value.documentId ?? value.id);
    return documentId && new Set(documentIds.map(String)).has(documentId) ? { type, documentId } : null;
  }
  const moduleId = validModule(value.moduleId ?? value.id);
  if (!moduleId) return null;
  if (type === "module") return { type, moduleId };
  const viewId = validScopeView(value.viewId);
  if (!viewId) return null;
  if (type === "view") return { type, moduleId, viewId };
  const volumeId = cleanId(value.volumeId ?? value.id);
  if (moduleId !== "manuscript" || viewId !== "novel" || !volumeId) return null;
  return { type, moduleId, viewId, volumeId, label: cleanText(value.label, 120) };
};

export const inferCommandBackupScope = (prompt = "", inventory = []) => {
  const source = String(prompt).replace(/[\s　]+/g, "");
  if (!source) return null;

  if (/(?:整个|全部|所有|完整)(?:当前)?(?:作品|项目)|(?:作品|项目)(?:全文|整体|全部|所有内容)|全书(?!大纲)|整本作品/.test(source)) {
    return { type: "project", id: "project" };
  }

  const modulePatterns = [
    ["manuscript", /(?:整个|全部|所有)?正文(?:板块|总目录)|正文(?:板块|总目录)(?:整体|全部)?/],
    ["outline", /(?:整个|全部|所有)?大纲(?:板块|总目录)|大纲(?:板块|总目录)(?:整体|全部)?/],
    ["canon", /(?:整个|全部|所有)?设定(?:板块|总目录)|设定(?:板块|总目录)(?:整体|全部)?/],
    ["memory", /(?:整个|全部|所有)?记忆(?:板块|总目录)|记忆(?:板块|总目录)(?:整体|全部)?/],
    ["reports", /(?:整个|全部|所有)?编译报告(?:板块|总目录)|编译报告(?:板块|总目录)(?:整体|全部)?/],
    ["library", /(?:整个|全部|所有)?资料库(?:板块|总目录)|资料库(?:板块|总目录)(?:整体|全部)?/],
    ["index", /(?:整个|全部|所有)?索引(?:板块|总目录)|索引(?:板块|总目录)(?:整体|全部)?/],
  ];
  const moduleMatch = modulePatterns.find(([, pattern]) => pattern.test(source));
  if (moduleMatch) return { type: "module", moduleId: moduleMatch[0] };

  const broadVolume = /(?:整卷|全卷|第[^，。；、]{1,12}卷(?:全文|全部|整体|所有章节))/.test(source);
  if (broadVolume) {
    const volume = inventory.find((item) => item?.folderId && item?.folderLabel && source.includes(String(item.folderLabel).replace(/[\s　]+/g, "")));
    if (volume) return { type: "volume", moduleId: "manuscript", viewId: "novel", volumeId: String(volume.folderId), label: String(volume.folderLabel) };
  }

  const specificDocument = /第\s*\d+\s*[章集]|单章|当前章|本章|这一章|当前文档|这个文档|这句话|一句|一段|局部/.test(source);
  if (specificDocument && !/(?:全文|全部|整体|全篇|通篇)/.test(source)) return null;

  const viewPatterns = [
    ["manuscript", "script", /剧本正文(?:全文|全部|整体|全篇|通篇)|(?:只|仅)(?:需要|要求)?(?:修改|改写|调整|替换|清空)剧本正文/],
    ["manuscript", "prompts", /提示词(?:目录|内容)(?:全部|整体|全文)|(?:全部|所有)(?:视频|视觉资产|全景调度图)提示词/],
    ["manuscript", "novel", /小说正文(?:全文|全部|整体|全篇|通篇)|正文(?:全文|全篇|通篇)|(?:只|仅)(?:需要|要求)?(?:修改|改写|调整|替换|清空)(?:小说)?正文/],
    ["outline", "script", /剧本大纲(?:全部|整体|全文|全套)|(?:全部|所有)剧本大纲/],
    ["outline", "novel", /小说大纲(?:全部|整体|全文|全套)|(?:全部|所有)小说大纲/],
    ["canon", "script", /剧本设定(?:全部|整体|全文|全套)|(?:全部|所有)剧本设定/],
    ["canon", "novel", /(?:小说|正史)设定(?:全部|整体|全文|全套)|(?:全部|所有)(?:小说|正史)设定/],
    ["memory", "script", /剧本(?:连续性|记忆)(?:全部|整体|全文|全套)|(?:全部|所有)剧本(?:连续性|记忆)/],
    ["memory", "novel", /小说(?:连续性|记忆)(?:全部|整体|全文|全套)|(?:全部|所有)小说(?:连续性|记忆)/],
  ];
  const viewMatch = viewPatterns.find(([, , pattern]) => pattern.test(source));
  return viewMatch ? { type: "view", moduleId: viewMatch[0], viewId: viewMatch[1] } : null;
};

const normalizeOperation = (operation, context) => {
  const { knownDocumentIds, knownFolderIds, documentRevisions, documentTitles, historyKeys, trashIds, projectNames } = context;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  const type = WORKSPACE_OPERATION_TYPES.includes(operation.type) ? operation.type : null;
  if (!type) return null;
  const documentId = cleanId(operation.documentId);
  const needsDocument = type.startsWith("document.") && type !== "document.create" || type === "history.save_document";
  if (needsDocument && !knownDocumentIds.has(documentId)) return null;

  if (type === "folder.ensure") {
    const moduleId = validModule(operation.moduleId);
    const viewId = validView(operation.viewId);
    const name = cleanText(operation.name || operation.folderLabel, 120);
    const parentFolderId = cleanId(operation.parentFolderId);
    if (!moduleId || !name || parentFolderId && !knownFolderIds.has(parentFolderId)) return null;
    return { type, moduleId, viewId, name, parentFolderId };
  }
  if (type === "folder.rename") {
    const folderId = cleanId(operation.folderId);
    const name = cleanText(operation.name || operation.folderLabel, 120);
    return folderId && knownFolderIds.has(folderId) && name ? { type, folderId, name } : null;
  }

  if (type === "document.create") {
    const moduleId = validModule(operation.moduleId);
    const viewId = validView(operation.viewId);
    const title = cleanText(operation.title, 120);
    if (!moduleId || !title) return null;
    const placement = structurePlacementAllows({ title, moduleId, viewId });
    if (!placement.allowed) {
      context.structureViolation = true;
      return null;
    }
    return {
      type,
      moduleId,
      viewId,
      title,
      content: cleanText(operation.content, 80_000),
      treeGroup: cleanId(operation.treeGroup, 80) || placement.expected?.treeGroup || "",
      folderId: cleanId(operation.folderId),
      folderLabel: cleanText(operation.folderLabel, 120),
      volumeFolder: cleanId(operation.volumeFolder),
    };
  }

  if (type === "document.rename") {
    const title = cleanText(operation.title, 120);
    return title ? { type, documentId, title, expectedRevision: documentRevisions.get(documentId) ?? "" } : null;
  }
  if (type === "document.replace_text") {
    const find = cleanText(operation.find, 20_000);
    if (!find) return null;
    return { type, documentId, find, replace: cleanText(operation.replace, 40_000), replaceAll: operation.replaceAll === true, expectedRevision: documentRevisions.get(documentId) ?? "" };
  }
  if (type === "document.replace_content") return { type, documentId, content: cleanText(operation.content, 100_000), expectedRevision: documentRevisions.get(documentId) ?? "" };
  if (type === "document.append_content") {
    const content = cleanText(operation.content, 80_000);
    return content ? { type, documentId, content, expectedRevision: documentRevisions.get(documentId) ?? "" } : null;
  }
  if (["document.clear", "document.delete"].includes(type)) return { type, documentId, expectedRevision: documentRevisions.get(documentId) ?? "" };
  if (type === "document.move") {
    const moduleId = validModule(operation.moduleId);
    const viewId = validView(operation.viewId);
    if (!moduleId) return null;
    const title = documentTitles.get(documentId) ?? "";
    const placement = structurePlacementAllows({ documentId, title, moduleId, viewId });
    if (!placement.allowed) {
      context.structureViolation = true;
      return null;
    }
    return {
      type,
      documentId,
      moduleId,
      viewId,
      treeGroup: cleanId(operation.treeGroup, 80) || placement.expected?.treeGroup || "",
      folderId: cleanId(operation.folderId),
      folderLabel: cleanText(operation.folderLabel, 120),
      volumeFolder: cleanId(operation.volumeFolder),
      expectedRevision: documentRevisions.get(documentId) ?? "",
    };
  }

  if (type === "document.reorder") {
    const beforeDocumentId = cleanId(operation.beforeDocumentId);
    const afterDocumentId = cleanId(operation.afterDocumentId);
    if (beforeDocumentId && !knownDocumentIds.has(beforeDocumentId)) return null;
    if (afterDocumentId && !knownDocumentIds.has(afterDocumentId)) return null;
    if (!beforeDocumentId && !afterDocumentId) return null;
    return { type, documentId, beforeDocumentId, afterDocumentId, expectedRevision: documentRevisions.get(documentId) ?? "" };
  }

  if (type === "history.save_document") return documentId && documentId !== "library-trash"
    ? { type, documentId, expectedRevision: documentRevisions.get(documentId) ?? "" }
    : null;
  if (["history.restore", "history.delete"].includes(type)) {
    const scopeType = ["document", "volume", "view", "module", "project"].includes(operation.scopeType) ? operation.scopeType : null;
    const scopeId = cleanId(operation.scopeId);
    const versionId = cleanId(operation.versionId);
    if (!scopeType || !scopeId || !versionId || !historyKeys.has(`${scopeType}|${scopeId}|${versionId}`)) return null;
    return { type, scopeType, scopeId, versionId };
  }
  if (type === "trash.restore") {
    const trashId = cleanId(operation.trashId);
    return trashIds.has(trashId) ? { type, trashId } : null;
  }
  if (["project.create", "notebook.create"].includes(type)) {
    const name = cleanText(operation.name, 100);
    if (!name) return null;
    const notebook = type === "notebook.create";
    const initialDocuments = (Array.isArray(operation.initialDocuments) ? operation.initialDocuments : [])
      .slice(0, 40)
      .map((document) => {
        const sourceDocumentId = cleanId(document?.sourceDocumentId);
        if (sourceDocumentId && !knownDocumentIds.has(sourceDocumentId)) return null;
        const normalized = normalizeOperation({
          ...document,
          type: "document.create",
          ...(notebook ? { moduleId: "library", viewId: "novel" } : {}),
        }, context);
        if (!normalized || (!normalized.content && !sourceDocumentId)) return null;
        return {
          ...normalized,
          ...(sourceDocumentId ? {
            sourceDocumentId,
            sourceExpectedRevision: documentRevisions.get(sourceDocumentId) ?? "",
          } : {}),
        };
      })
      .filter(Boolean);
    return {
      type,
      name,
      creationRequirements: cleanText(operation.creationRequirements, 12_000),
      initialDocuments,
    };
  }
  if (["project.rename", "project.switch", "project.delete"].includes(type)) {
    const projectName = cleanText(operation.projectName, 100);
    if (!projectNames.has(projectName)) return null;
    if (type === "project.rename") {
      const name = cleanText(operation.name, 100);
      return name ? { type, projectName, name } : null;
    }
    return { type, projectName };
  }

  const scopeType = ["project", "module", "view", "volume"].includes(operation.scopeType) ? operation.scopeType : null;
  if (!scopeType) return null;
  const modules = [...new Set((Array.isArray(operation.modules) ? operation.modules : []).map(validModule).filter(Boolean))];
  const moduleId = scopeType === "volume" ? "manuscript" : validModule(operation.moduleId);
  if (scopeType === "project" && !modules.length) return null;
  if (["module", "view"].includes(scopeType) && !moduleId) return null;
  const volumeId = cleanId(operation.volumeId);
  if (scopeType === "volume" && !volumeId) return null;
  return { type, scopeType, modules, moduleId, viewId: validView(operation.viewId), volumeId };
};

export const normalizeWorkspaceOperationPlan = (value, { documentIds = [], folders = [], documentRevisions = {}, documentTitles = {}, historyEntries = [], trashIds = [], projectNames = [] } = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = {
    knownDocumentIds: new Set(documentIds.map(String)),
    knownFolderIds: new Set((Array.isArray(folders) ? folders : []).map((folder) => String(folder?.id || folder?.folderId || "")).filter(Boolean)),
    documentRevisions: new Map(Object.entries(documentRevisions ?? {}).map(([id, revision]) => [String(id), String(revision)])),
    documentTitles: new Map(Object.entries(documentTitles ?? {}).map(([id, title]) => [String(id), String(title)])),
    historyKeys: new Set(historyEntries.map((entry) => `${entry.scopeType}|${entry.scopeId}|${entry.versionId}`)),
    trashIds: new Set(trashIds.map(String)),
    projectNames: new Set(projectNames.map(String)),
  };
  let operations = (Array.isArray(value.operations) ? value.operations : [])
    .map((operation) => normalizeOperation(operation, context))
    .filter(Boolean)
    .slice(0, 80);
  if (context.structureViolation) return null;
  const stateReplacingOperation = operations.find((operation) => operation.type.startsWith("project.") || operation.type === "notebook.create" || operation.type === "history.restore" || operation.type === "trash.restore");
  if (stateReplacingOperation) operations = [stateReplacingOperation];
  if (!operations.length) return null;
  return bindWorkspaceOperationConfirmation({
    id: cleanId(value.id) || `operation-${Date.now()}`,
    intent: cleanText(value.intent, 500),
    summary: cleanText(value.summary, 800) || `准备执行 ${operations.length} 项工作区操作`,
    backupScope: normalizeBackupScope(value.backupScope, { documentIds }),
    operations,
    status: "waiting_confirm",
  });
};

export const workspaceOperationIsDestructive = (operation = {}) => (
  ["document.clear", "document.delete", "scope.clear", "document.replace_content", "document.move", "history.delete", "project.delete"].includes(operation.type)
);

export const workspacePlanRequiresConfirmation = (plan) => Boolean(plan?.operations?.length)
  && plan?.confirmation?.required !== false;

export const workspaceOperationLabel = (operation = {}, titleForDocument = () => "目标文档") => {
  const title = operation.documentId ? titleForDocument(operation.documentId) : "";
  if (operation.type === "folder.ensure") return `确保文件夹“${operation.name}”存在`;
  if (operation.type === "folder.rename") return `将指定文件夹重命名为“${operation.name}”`;
  if (operation.type === "document.create") return `新建“${operation.title}”`;
  if (operation.type === "document.rename") return `将“${title}”重命名为“${operation.title}”`;
  if (operation.type === "document.replace_text") return `替换“${title}”中的指定文字`;
  if (operation.type === "document.replace_content") return `覆盖“${title}”的全部内容`;
  if (operation.type === "document.append_content") return `向“${title}”追加内容`;
  if (operation.type === "document.clear") return `清空“${title}”的内容`;
  if (operation.type === "document.delete") return `将“${title}”移入回收站`;
  if (operation.type === "document.move") return `移动“${title}”到其他结构位置`;
  if (operation.type === "document.reorder") return `调整“${title}”在目录中的顺序`;
  if (operation.type === "scope.clear") {
    if (operation.scopeType === "project") return `清空作品中的${operation.modules.join("、")}板块`;
    if (operation.scopeType === "module") return `清空${operation.moduleId}板块`;
    if (operation.scopeType === "view") return `清空${operation.moduleId}:${operation.viewId}分类`;
    return "清空指定分卷";
  }
  if (operation.type === "history.save_document") return `将“${title}”保存为历史版本`;
  if (operation.type === "history.restore") return "将指定历史版本设为当前";
  if (operation.type === "history.delete") return "将指定历史版本移入回收站";
  if (operation.type === "trash.restore") return "从回收站恢复指定内容";
  if (operation.type === "project.create") return `新建作品“${operation.name}”`;
  if (operation.type === "notebook.create") return `新建笔记本“${operation.name}”`;
  if (operation.type === "project.rename") return `将作品“${operation.projectName}”重命名为“${operation.name}”`;
  if (operation.type === "project.switch") return `切换到作品“${operation.projectName}”`;
  if (operation.type === "project.delete") return `将作品“${operation.projectName}”移入30日回收区`;
  return "工作区操作";
};
