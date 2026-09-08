const text = (value = "") => String(value ?? "").trim();
const list = (value) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const clone = (value) => value == null ? value : structuredClone(value);

export const TASK_CONTRACT_PROTOCOL = "shensi_task_contract_v1";
export const TASK_CONTRACT_SCHEMA_VERSION = 1;

export const TASK_CONTRACT_PERSISTENCE_MODES = Object.freeze([
  "commit",
  "candidate_only",
  "none",
  "unspecified",
]);

export const TASK_CONTRACT_TARGET_RESOLUTIONS = Object.freeze([
  "exact",
  "ambiguous",
  "unresolved",
]);

const TASK_CONTRACT_OPERATIONS = new Set([
  "create",
  "patch",
  "append",
  "replace",
  "rename",
  "batch",
  "assist",
  "transform",
  "export",
  "operate",
]);

const NEGATIVE_CLAUSE = /(?:不要|不用|无需|不必|禁止|不得|不可|不能|不允许|(?<!分)别|先别|暂不|避免|不(?=写入|落盘|保存|创建|新建|生成|记录|同步|补充|更新|修改|写|创作|续写|改写|重写))/u;
const ACCEPTANCE_CLAUSE = /(?:验收|校验|核验|检查|确认|确保|完成条件|通过条件|是否).{0,48}(?:存在|创建|写入|落盘|非空|为空|标题|顺序|位置|类型|结构|完整|正确|回执|哈希)|(?:必须|需要).{0,36}(?:全部完成|通过验收|回读一致|回执完整)/u;
const CONFIRMED_CONTENT_REFERENCE = /(?:已经|已)?确认(?:过|好|完成)?(?:的)?(?:内容|事实|要求|决定|方案|设定|大纲|资料)/gu;
const WRITING_ACTION = /(?:写作|创作|撰写|写出|生成|产出|创建|新建|续写|落盘|写入|保存|定稿|成稿|完成).{0,40}(?:设定|世界观|人物|角色|大纲|章纲|卷纲|正文|章节|小说|故事|剧本|文档|内容)|(?:设定|世界观|人物|角色|大纲|章纲|卷纲|正文|章节|小说|故事|剧本|文档|内容).{0,40}(?:写作|创作|撰写|写出|生成|产出|创建|新建|续写|落盘|写入|保存|定稿|成稿|完成)/u;

const stableContractKey = (value = "") => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const taskContractInstructionSections = (instruction = "") => {
  const source = text(instruction);
  const exclusions = [];
  const acceptanceCriteria = [];
  const affirmative = [];
  let blockMode = "affirmative";
  const lines = source.split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:禁止(?:混入)?|排除|exclusions?)\s*[：:]?\s*$/iu.test(line)) {
      blockMode = "exclusion";
      continue;
    }
    if (/^(?:验收(?:条件)?|完成条件|通过条件|acceptance(?:\s+criteria)?)\s*[：:]?\s*$/iu.test(line)) {
      blockMode = "acceptance";
      continue;
    }
    if (/^(?:交付物(?:清单)?|任务|目标|deliverables?)\s*[：:]?\s*$/iu.test(line)) {
      blockMode = "affirmative";
      affirmative.push(line);
      continue;
    }

    const bulletBody = line.replace(/^\s*(?:[-*•]|(?:\d+|[A-Za-z一二三四五六七八九十]+)[.、:)）])\s*/u, "").trim();
    if (blockMode === "exclusion" || NEGATIVE_CLAUSE.test(bulletBody) && /^\s*(?:[-*•]\s*)?(?:不要|不用|无需|不必|禁止|不得|不可|不能|不允许|别|先别|暂不|避免|不(?=写入|落盘|保存|创建|新建|生成|记录|同步|补充|更新|修改|写|创作|续写|改写|重写))/u.test(line)) {
      exclusions.push(bulletBody);
      continue;
    }
    if (blockMode === "acceptance") {
      acceptanceCriteria.push(bulletBody);
      continue;
    }

    const clauses = line
      .split(/(?<=[，,。！？!?；;])/u)
      .map((clause) => clause.replace(/^[，,。！？!?；;\s]+|[，,。！？!?；;\s]+$/gu, "").trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (NEGATIVE_CLAUSE.test(clause)) exclusions.push(clause);
      else if (ACCEPTANCE_CLAUSE.test(clause.replace(CONFIRMED_CONTENT_REFERENCE, "已定内容"))) acceptanceCriteria.push(clause);
      else affirmative.push(clause);
    }
  }
  return {
    affirmativeInstruction: affirmative.join("\n").trim(),
    exclusions: list(exclusions),
    acceptanceCriteria: list(acceptanceCriteria),
  };
};

export const TASK_TYPES = Object.freeze([
  "writing",
  "planning",
  "modification",
  "testing",
  "diagnosis",
  "export",
  "operation",
  "discussion",
]);

export const DELIVERABLE_STATUSES = Object.freeze([
  "pending",
  "generated",
  "written",
  "verified",
  "failed",
]);

const TASK_TYPE_ALIASES = new Map([
  ["write", "writing"], ["create", "writing"], ["generate", "writing"], ["创作", "writing"], ["写作", "writing"],
  ["plan", "planning"], ["规划", "planning"], ["整理", "planning"],
  ["modify", "modification"], ["patch", "modification"], ["修改", "modification"], ["改写", "modification"],
  ["test", "testing"], ["测试", "testing"],
  ["diagnose", "diagnosis"], ["review", "diagnosis"], ["诊断", "diagnosis"], ["审计", "diagnosis"],
  ["export", "export"], ["导出", "export"],
  ["operate", "operation"], ["operation", "operation"], ["操作", "operation"],
  ["discuss", "discussion"], ["discussion", "discussion"], ["讨论", "discussion"],
]);

const normalizeTaskType = (value) => {
  const candidate = text(value).toLowerCase();
  return TASK_TYPE_ALIASES.get(candidate) || (TASK_TYPES.includes(candidate) ? candidate : "discussion");
};

const inferTaskType = ({ taskType = "", operation = "", instruction = "" } = {}) => {
  if (taskType) return normalizeTaskType(taskType);
  const action = text(operation).toLowerCase();
  if (["patch", "replace", "rename", "transform"].includes(action)) return "modification";
  if (["create", "append", "batch"].includes(action)) return "writing";
  const source = taskContractInstructionSections(instruction).affirmativeInstruction || text(instruction);
  if (WRITING_ACTION.test(source)) return "writing";
  if (/(?:修改|改写|重写|替换|润色|patch|replace)/iu.test(source)) return "modification";
  if (/(?:导出|export)/iu.test(source)) return "export";
  if (/(?:测试|test|回归|验收)/iu.test(source)) return "testing";
  if (/(?:诊断|排查|审计|分析|检查|diagnos|audit)/iu.test(source)) return "diagnosis";
  if (/(?:规划|计划|整理|大纲|设定|plan)/iu.test(source)) return "planning";
  if (/(?:写|创作|生成|撰写|续写|writing|write)/iu.test(source)) return "writing";
  return "discussion";
};

const inferredKind = (target = {}) => {
  const moduleId = text(target.moduleId).toLowerCase();
  const viewId = text(target.viewId).toLowerCase();
  const contentType = text(target.contentType).toLowerCase();
  const documentId = text(target.documentId).toLowerCase();
  if (moduleId === "reports" || documentId.startsWith("report-")) return "report";
  if (moduleId === "canon" || /设定|世界观|人物|角色/.test(text(target.title))) return "setting";
  if (moduleId === "outline" || /outline|大纲|章纲|卷纲|集纲/.test(`${contentType} ${target.title || ""}`)) return "outline";
  if (moduleId === "reports" || /report|报告|diagnos|自检/.test(`${contentType} ${target.title || ""}`)) return "report";
  if (moduleId === "memory") return "memory";
  if (viewId === "prompts" || documentId.startsWith("prompt-") || contentType.includes("prompt")) return "visual_prompt";
  if (viewId === "script" || contentType.includes("script") || /剧本|短剧/.test(text(target.title))) return "script";
  if (moduleId === "manuscript" || /^chapter-|正文|章节/.test(`${target.documentId || ""}${target.title || ""}`)) return "prose";
  if (moduleId === "library") return "reference";
  return contentType || "document";
};

const normalizeTarget = (target = {}, fallbackDocumentId = "") => {
  if (typeof target === "string") return { documentId: text(target), title: "", moduleId: "" };
  return {
    documentId: text(target.documentId || target.id || fallbackDocumentId),
    title: text(target.title || target.requestedTitle),
    moduleId: text(target.moduleId || target.directoryId),
    viewId: text(target.viewId),
    contentType: text(target.contentType),
    workspacePath: text(target.workspacePath),
    minCharacters: Math.max(0, Number(target.minCharacters) || 0),
    folderId: text(target.folderId),
    folderLabel: text(target.folderLabel || target.plannedFolderLabel),
    volumeFolder: text(target.volumeFolder || target.plannedFolderLabel),
    plannedFolderLabel: text(target.plannedFolderLabel),
    plannedVolumeTitle: text(target.plannedVolumeTitle),
    plannedVolumeNumber: Math.max(0, Number(target.plannedVolumeNumber) || 0),
    folderSourceDocumentId: text(target.folderSourceDocumentId),
  };
};

const defaultAcceptance = ({ targetDocument = "", kind = "document", order = 0, minCharacters = 0, folderLabel = "" } = {}) => [
  `target_exists:${targetDocument}`,
  "content_non_empty",
  ...(minCharacters > 0 ? [`minimum_characters:${minCharacters}`] : []),
  "document_type_bound",
  ...(folderLabel ? [`target_folder:${folderLabel}`] : []),
  ...(order > 0 ? [`document_order:${order}`] : []),
  `deliverable_kind:${kind}`,
];

const normalizeDeliverable = (item = {}, index = 0) => {
  const target = {
    ...normalizeTarget(item.target ?? item.targetDocument ?? item.targetDocumentId ?? item.documentId ?? ""),
    ...(text(item.moduleId) ? { moduleId: text(item.moduleId) } : {}),
    ...(text(item.viewId) ? { viewId: text(item.viewId) } : {}),
    ...(text(item.workspacePath) ? { workspacePath: text(item.workspacePath) } : {}),
  };
  const targetDocument = target.documentId;
  const declaredKind = text(item.kind).toLowerCase();
  // Agent contracts sometimes use a transport-level placeholder for an
  // artifact.  The document binding remains authoritative; resolve the
  // placeholder from that binding before validation so reports do not enter
  // the generic document path.
  const kind = ["", "artifact", "document"].includes(declaredKind)
    ? inferredKind({ ...target, title: item.title || target.title })
    : declaredKind;
  const status = DELIVERABLE_STATUSES.includes(text(item.status)) ? text(item.status) : "pending";
  const acceptanceCriteria = list(item.acceptanceCriteria);
  return {
    id: text(item.id) || `deliverable-${String(index + 1).padStart(3, "0")}`,
    kind,
    targetDocument,
    targetDocumentId: targetDocument,
    target: clone(target),
    required: item.required !== false,
    status,
    order: Math.max(1, Number(item.order) || index + 1),
    title: text(item.title || target.title),
    minCharacters: Math.max(0, Number(item.minCharacters ?? target.minCharacters) || 0),
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : defaultAcceptance({
      targetDocument,
      kind,
      order: index + 1,
      minCharacters: Math.max(0, Number(item.minCharacters ?? target.minCharacters) || 0),
      folderLabel: target.plannedFolderLabel || target.folderLabel || target.volumeFolder,
    }),
    ...(text(item.generatedContentHash) ? { generatedContentHash: text(item.generatedContentHash) } : {}),
    ...(text(item.failureReason) ? { failureReason: text(item.failureReason) } : {}),
  };
};

const deliverablesFromTargets = ({ target = {}, operation = "", taskType = "", instruction = "" } = {}) => {
  const explicit = Array.isArray(target.documents) ? target.documents : [];
  const inferredType = taskType ? normalizeTaskType(taskType) : inferTaskType({ taskType, operation, instruction });
  const inferredTargetIsContextOnly = ["assist", "discussion"].includes(text(operation).toLowerCase())
    || ["discussion", "diagnosis", "testing"].includes(inferredType);
  if (!explicit.length && inferredTargetIsContextOnly) return [];
  const candidates = explicit.length ? explicit : target.documentId ? [target] : [];
  return candidates.map((item, index) => {
    const normalizedTarget = normalizeTarget(item);
    return normalizeDeliverable({
      ...item,
      targetDocument: normalizedTarget,
      kind: item.kind || inferredKind(normalizedTarget),
      order: index + 1,
    }, index);
  });
};

export const compileTaskContract = ({
  contractId = "",
  revision = 1,
  taskType = "",
  objective = "",
  instruction = "",
  operation = "",
  target = {},
  deliverables = null,
  exclusions = [],
  acceptanceCriteria = [],
  requiredContextDocumentIds = [],
  optionalReferenceDocumentIds = [],
  skillIds = [],
  persistence = "unspecified",
  targetResolution = "",
  semanticSource = "fallback",
  sourceMessageId = "",
} = {}) => {
  const sections = taskContractInstructionSections(instruction);
  const normalizedType = inferTaskType({ taskType, operation, instruction: sections.affirmativeInstruction || instruction });
  const items = (Array.isArray(deliverables) ? deliverables : deliverablesFromTargets({ target, operation, taskType: normalizedType, instruction }))
    .map(normalizeDeliverable)
    .filter((item) => item.targetDocument || item.kind === "document");
  const taskObjective = text(objective) || text(instruction);
  const criteria = list([...sections.acceptanceCriteria, ...(Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [])]);
  const normalizedExclusions = list([...sections.exclusions, ...(Array.isArray(exclusions) ? exclusions : [])]);
  const normalizedSourceMessageId = text(sourceMessageId);
  const normalizedOperation = TASK_CONTRACT_OPERATIONS.has(text(operation).toLowerCase())
    ? text(operation).toLowerCase()
    : items.length ? (items.length > 1 ? "batch" : "create") : "assist";
  const normalizedPersistence = TASK_CONTRACT_PERSISTENCE_MODES.includes(text(persistence).toLowerCase())
    ? text(persistence).toLowerCase()
    : "unspecified";
  const normalizedTargetResolution = TASK_CONTRACT_TARGET_RESOLUTIONS.includes(text(targetResolution).toLowerCase())
    ? text(targetResolution).toLowerCase()
    : items.length ? "exact" : "unresolved";
  return {
    protocol: TASK_CONTRACT_PROTOCOL,
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    contractId: text(contractId) || `contract-${normalizedSourceMessageId || stableContractKey(`${normalizedType}\n${taskObjective}`)}`,
    revision: Math.max(1, Number(revision) || 1),
    taskType: normalizedType,
    operation: normalizedOperation,
    objective: taskObjective,
    deliverables: items,
    exclusions: normalizedExclusions,
    acceptanceCriteria: criteria.length ? criteria : ["all_required_deliverables_verified"],
    requiredContextDocumentIds: list(requiredContextDocumentIds),
    optionalReferenceDocumentIds: list(optionalReferenceDocumentIds),
    skillIds: list(skillIds),
    persistence: normalizedPersistence,
    targetResolution: normalizedTargetResolution,
    semanticSource: ["agent", "model", "fallback"].includes(text(semanticSource).toLowerCase())
      ? text(semanticSource).toLowerCase()
      : "fallback",
    completionStatus: items.some((item) => item.required) ? "pending" : "completed",
    sourceMessageId: normalizedSourceMessageId,
  };
};

export const normalizeTaskContract = (contract = {}, options = {}) => compileTaskContract({
  ...contract,
  ...options,
  deliverables: Array.isArray(contract.deliverables) ? contract.deliverables : options.deliverables,
  taskType: contract.taskType || options.taskType,
  objective: contract.objective || options.objective,
  instruction: contract.objective || options.instruction,
  exclusions: contract.exclusions ?? options.exclusions,
  acceptanceCriteria: contract.acceptanceCriteria ?? options.acceptanceCriteria,
  requiredContextDocumentIds: contract.requiredContextDocumentIds ?? options.requiredContextDocumentIds,
  optionalReferenceDocumentIds: contract.optionalReferenceDocumentIds ?? options.optionalReferenceDocumentIds,
  skillIds: contract.skillIds ?? options.skillIds,
  persistence: contract.persistence ?? options.persistence,
  targetResolution: contract.targetResolution ?? options.targetResolution,
  semanticSource: contract.semanticSource ?? options.semanticSource,
  operation: contract.operation || options.operation,
  target: contract.target ?? options.target,
  contractId: contract.contractId || options.contractId,
  revision: contract.revision || options.revision,
  sourceMessageId: contract.sourceMessageId || options.sourceMessageId,
});

const targetMatchesDeliverableKind = (kind = "document", documentId = "") => {
  const normalizedKind = text(kind).toLowerCase();
  const id = text(documentId).toLowerCase();
  if (!id) return false;
  if (normalizedKind === "setting") return /^(?:canon-|script-canon-)/u.test(id);
  if (normalizedKind === "outline") return /^(?:outline-|script-outline-)/u.test(id);
  if (normalizedKind === "prose") return /^chapter-\d+$/u.test(id);
  if (["script", "script_prose"].includes(normalizedKind)) return /^script-episode-\d+$/u.test(id);
  if (["report", "review_report"].includes(normalizedKind)) return /^report-/u.test(id);
  if (normalizedKind === "memory") return /^(?:memory-|script-memory-)/u.test(id);
  if (normalizedKind === "visual_prompt") return /^prompt-/u.test(id);
  if (normalizedKind === "reference") return /^library-/u.test(id);
  return true;
};

export const validateTaskContractForExecution = (contract = null) => {
  if (!contract || contract.protocol !== TASK_CONTRACT_PROTOCOL) {
    return { recognized: false, valid: false, authoritative: false, issues: ["missing_or_unknown_protocol"] };
  }
  const deliverables = Array.isArray(contract.deliverables) ? contract.deliverables : [];
  const persistence = TASK_CONTRACT_PERSISTENCE_MODES.includes(text(contract.persistence).toLowerCase())
    ? text(contract.persistence).toLowerCase()
    : "unspecified";
  const targetResolution = TASK_CONTRACT_TARGET_RESOLUTIONS.includes(text(contract.targetResolution).toLowerCase())
    ? text(contract.targetResolution).toLowerCase()
    : deliverables.length ? "exact" : "unresolved";
  const issues = [];
  const ids = [];
  for (const item of deliverables) {
    const documentId = text(item?.targetDocumentId || item?.targetDocument || item?.target?.documentId);
    if (!documentId) issues.push(`missing_target:${text(item?.id) || "deliverable"}`);
    else {
      ids.push(documentId);
      if (!targetMatchesDeliverableKind(item?.kind, documentId)) {
        issues.push(`document_type_mismatch:${text(item?.id) || documentId}`);
      }
    }
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) issues.push(`duplicate_target:${list(duplicates).join(",")}`);
  if (["commit", "candidate_only"].includes(persistence) && !deliverables.length) issues.push("missing_deliverables");
  if (persistence === "commit" && targetResolution !== "exact") issues.push(`target_${targetResolution}`);
  const operation = TASK_CONTRACT_OPERATIONS.has(text(contract.operation).toLowerCase())
    ? text(contract.operation).toLowerCase()
    : "assist";
  const semanticSource = ["agent", "model", "fallback"].includes(text(contract.semanticSource).toLowerCase())
    ? text(contract.semanticSource).toLowerCase()
    : "fallback";
  return {
    recognized: true,
    valid: issues.length === 0,
    // A fallback contract is prepared before the unified Agent has understood
    // the turn.  It is useful as legacy evidence, but it must never freeze a
    // provisional task type, target or write intent and then overrule the
    // Agent's structured decision.
    authoritative: persistence !== "unspecified" && semanticSource !== "fallback",
    issues,
    persistence,
    targetResolution,
    operation,
    semanticSource,
    deliverables,
    targetDocumentIds: list(ids),
    skillIds: list(contract.skillIds),
  };
};

export const taskContractWriteAction = (contract = null) => {
  const decision = validateTaskContractForExecution(contract);
  if (!decision.valid) return "analyze";
  if (["patch", "append", "replace", "rename", "create"].includes(decision.operation)) return decision.operation;
  return contract?.taskType === "modification" ? "replace" : "generate";
};

const receiptMap = (receipts = []) => new Map((Array.isArray(receipts) ? receipts : Object.values(receipts || {}))
  .filter((receipt) => receipt && text(receipt.targetDocumentId))
  .map((receipt) => [text(receipt.targetDocumentId), receipt]));

const documentMap = (documents = {}) => Array.isArray(documents)
  ? new Map(documents.map((document) => [text(document?.documentId || document?.id), document]).filter(([id]) => id))
  : new Map(Object.entries(documents || {}).map(([id, document]) => [text(id), document]));

const documentContent = (document = {}) => String(document.markdown ?? document.text ?? document.html ?? "")
  .replace(/<[^>]+>/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const documentFolderLabel = (document = {}) => text(
  document.folderLabel
  || document.customFolderLabel
  || document.customFolderName
  || document.volumeLabel
  || document.volumeFolder,
);

export const taskContractContentCharacterCount = (document = {}) => documentContent(document)
  .replace(/\s/gu, "")
  .length;

const titleMatches = (deliverable = {}, actualTitle = "") => {
  const expected = text(deliverable.title);
  const actual = text(actualTitle);
  if (!expected || !actual || expected === actual) return true;
  const chapter = String(deliverable.targetDocumentId || "").match(/^chapter-(\d+)$/u)?.[1];
  // “第 N 章”是批量任务在生成具体章名之前使用的结构占位符。
  // 正文文档内部只保存章名，序号由 chapter-N 与目录标签负责；因此生成出
  // “今日退婚”这类正式章名后，不应被占位标题误判为 title_mismatch。
  return Boolean(chapter && expected === `第${chapter}章`);
};

export const evaluateTaskContract = ({
  contract = null,
  documents = {},
  receipts = [],
  requireVerifiedWrite = true,
  generatedDeliverableIds = [],
} = {}) => {
  const normalized = normalizeTaskContract(contract || {});
  const byReceipt = receiptMap(receipts);
  const byDocument = documentMap(documents);
  const generated = new Set(list(generatedDeliverableIds));
  const evaluated = normalized.deliverables.map((deliverable) => {
    const documentId = deliverable.targetDocumentId;
    const document = byDocument.get(documentId);
    const receipt = byReceipt.get(documentId);
    const content = documentContent(document);
    const actualCharacters = taskContractContentCharacterCount(document);
    const failures = [];
    if (!documentId) failures.push("missing_target_document");
    if (!document) failures.push("target_document_missing");
    if (!content) failures.push("content_empty");
    if (deliverable.minCharacters > 0 && actualCharacters < deliverable.minCharacters) failures.push(`content_too_short:${actualCharacters}/${deliverable.minCharacters}`);
    if (document && deliverable.target?.moduleId && text(document.moduleId) && text(document.moduleId) !== deliverable.target.moduleId) {
      failures.push("document_type_mismatch");
    }
    const expectedFolderLabel = text(deliverable.target?.plannedFolderLabel || deliverable.target?.folderLabel || deliverable.target?.volumeFolder);
    if (document && expectedFolderLabel && documentFolderLabel(document) !== expectedFolderLabel) failures.push("target_folder_mismatch");
    if (!titleMatches(deliverable, document?.title)) failures.push("title_mismatch");
    if (deliverable.target?.workspacePath && receipt?.workspacePath && text(receipt.workspacePath) !== deliverable.target.workspacePath) {
      failures.push("target_location_mismatch");
    }
    if (requireVerifiedWrite && (!receipt || receipt.verified !== true || (receipt.writtenHash && receipt.verifiedHash && receipt.writtenHash !== receipt.verifiedHash))) {
      failures.push("write_receipt_unverified");
    }
    const status = failures.length
      ? generated.has(deliverable.id) || content ? "failed" : deliverable.status
      : requireVerifiedWrite ? "verified" : content ? "written" : "pending";
    return {
      ...deliverable,
      status,
      ...(failures.length ? { failureReason: failures.join(",") } : { failureReason: "" }),
      ...(content ? { actualCharacters } : { actualCharacters: 0 }),
      ...(receipt ? { receiptVerified: receipt.verified === true } : { receiptVerified: false }),
    };
  });
  const required = evaluated.filter((item) => item.required);
  const acceptedStatus = requireVerifiedWrite ? "verified" : "written";
  const complete = required.length > 0
    ? required.every((item) => item.status === acceptedStatus)
    : true;
  const failed = required.filter((item) => item.status === "failed");
  const next = {
    ...normalized,
    deliverables: evaluated,
    completionStatus: complete ? "completed" : failed.length ? "blocked" : "in_progress",
  };
  return {
    contract: next,
    complete,
    failed: failed.length,
    required: required.length,
    verified: required.filter((item) => item.status === "verified").length,
    missing: required.filter((item) => item.status !== "verified").map((item) => ({ id: item.id, targetDocument: item.targetDocument, reason: item.failureReason || "not_verified" })),
  };
};

export const markTaskContractGenerated = (contract = null, { deliverableIds = [] } = {}) => {
  const normalized = normalizeTaskContract(contract || {});
  const ids = new Set(list(deliverableIds));
  const markAll = ids.size === 0;
  return {
    ...normalized,
    deliverables: normalized.deliverables.map((item) => (
      (markAll || ids.has(item.id)) && item.status === "pending"
        ? { ...item, status: "generated" }
        : item
    )),
    completionStatus: normalized.deliverables.some((item) => item.required) ? "in_progress" : "completed",
  };
};

export const isTaskContractComplete = (options = {}) => evaluateTaskContract(options).complete;

export const taskContractOutputContract = (contract = null) => {
  const normalized = normalizeTaskContract(contract || {});
  if (!normalized.deliverables.length) return "";
  return [
    "# TaskContract 交付物协议",
    `任务类型：${normalized.taskType}`,
    `执行操作：${normalized.operation}`,
    `落盘决策：${normalized.persistence}`,
    `目标解析：${normalized.targetResolution}`,
    normalized.skillIds.length ? `使用 Skill：${normalized.skillIds.join("、")}` : "",
    `目标：${normalized.objective || "未声明"}`,
    "必须逐项生成以下交付物；交付物只能写入绑定的目标文档，不得合并、错写或用说明文字代替：",
    ...normalized.deliverables.sort((left, right) => left.order - right.order).map((item, index) => {
      const folderLabel = item.target?.plannedFolderLabel || item.target?.folderLabel || item.target?.volumeFolder;
      return `${index + 1}. ${item.kind}｜${item.title || item.targetDocument}｜${item.targetDocument}${folderLabel ? `｜文件夹：${folderLabel}` : ""}${item.minCharacters > 0 ? `｜至少 ${item.minCharacters} 字符` : ""}`;
    }),
    normalized.exclusions.length ? `禁止混入：${normalized.exclusions.join("、")}` : "",
    normalized.persistence === "candidate_only"
      ? "本轮只生成候选，不得写入正式文档；候选需由用户明确采用后另行取得事务授权。"
      : normalized.persistence === "none"
        ? "本轮仅返回对话结果，不写入正式文档。"
        : "模型返回内容只能证明已生成；全部目标写入、非空、标题/顺序和回读凭证通过后，任务才可报告完成。",
  ].filter(Boolean).join("\n");
};
