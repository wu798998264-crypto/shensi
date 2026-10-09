import { buildMemoryReadPlan } from "./memory-compiler.js";
import { CREATIVE_CONTRACT_DOCUMENT_ID, normalizeCreativeContract } from "./creative-contract.js";

const text = (value = "") => String(value ?? "").trim();
const unique = (values = []) => [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
const body = (document = {}) => text(document.markdown || document.text || document.html || document.content)
  .replace(/<[^>]+>/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const creativeContractHasContent = (document = {}) => {
  const contract = normalizeCreativeContract(document);
  return Boolean(text(contract.bannedTerms) || text(contract.specialNotes));
};

const formalWritingTask = (taskRoute = null) => {
  const route = taskRoute && typeof taskRoute === "object" ? taskRoute : {};
  const intent = route.intentEnvelope && typeof route.intentEnvelope === "object" ? route.intentEnvelope : {};
  const mode = text(route.mode || route.recommendedMode);
  const taskType = text(intent.taskType || route.taskType || route.taskKind);
  const writeMode = text(intent.writeMode || route.writeMode);
  const hasFormalWriteAuthorization = writeMode === "formal_auto"
    || writeMode === "confirm_required"
    || route.formalArtifactExpected === true
    || route.writeAuthorization?.state === "commit";
  const writingMode = ["creative", "visual_prompt", "quick_revision"].includes(mode);
  const writingType = ["writing", "modification", "planning"].includes(taskType);
  return hasFormalWriteAuthorization && (writingMode || writingType);
};

const documentReason = ({ documentId, requiredIds, explicitIds, targetDocumentId, memoryPlan, creativeContractRequired = false }) => {
  if (documentId === targetDocumentId) return "本轮冻结目标文档";
  if (documentId === CREATIVE_CONTRACT_DOCUMENT_ID && creativeContractRequired) return "正式创作/修改任务必须读取非空创作合同";
  if (explicitIds.includes(documentId)) return "用户明确引用";
  if (requiredIds.includes(documentId)) return "结构化任务合同要求读取";
  return memoryPlan?.reasons?.[documentId] || "按本轮任务语义读取";
};

export const compileNativeAgentDocumentReadManifest = ({
  documents = {},
  targetDocumentId = "",
  explicitDocumentIds = [],
  taskRoute = null,
  contextDomain = "",
  maxDocuments = 16,
} = {}) => {
  const inventory = documents && typeof documents === "object" ? documents : {};
  const availableIds = Object.keys(inventory);
  const available = new Set(availableIds);
  const explicitIds = unique(explicitDocumentIds);
  const targetId = text(targetDocumentId);
  const routeRequiredIds = unique(taskRoute?.intentEnvelope?.requiredContextDocumentIds || []);
  const creativeContractRequired = available.has(CREATIVE_CONTRACT_DOCUMENT_ID)
    && creativeContractHasContent(inventory[CREATIVE_CONTRACT_DOCUMENT_ID])
    && formalWritingTask(taskRoute);
  const scriptDomain = text(contextDomain || taskRoute?.contextDomain).includes("script")
    || targetId.startsWith("script-episode-");
  const targetIsNarrativeUnit = /^(?:chapter|script-episode)-\d+$/u.test(targetId);
  const memoryPlan = targetIsNarrativeUnit ? buildMemoryReadPlan({
    targetDocumentId: targetId,
    scriptDomain,
    explicitIds,
    availableIds,
    substantiveIds: availableIds.filter((documentId) => body(inventory[documentId]).length > 0),
    unitMemoryIds: availableIds.filter((documentId) => Boolean(inventory[documentId]?.continuityDelta)),
  }) : null;
  const requiredDocumentIds = unique([
    ...routeRequiredIds,
    ...explicitIds,
    ...(targetId && available.has(targetId) ? [targetId] : []),
    ...(creativeContractRequired ? [CREATIVE_CONTRACT_DOCUMENT_ID] : []),
  ]);
  const priorityDocumentIds = unique([
    ...requiredDocumentIds,
    ...(memoryPlan?.priorityIds || []),
  ]).slice(0, Math.max(1, Number(maxDocuments) || 16));
  const entries = priorityDocumentIds.map((documentId) => ({
    documentId,
    title: text(inventory[documentId]?.title) || documentId,
    displayCharacterCount: Math.max(0, Number(inventory[documentId]?.displayCharacterCount) || 0),
    required: requiredDocumentIds.includes(documentId),
    available: available.has(documentId),
    reason: documentReason({ documentId, requiredIds: routeRequiredIds, explicitIds, targetDocumentId: targetId, memoryPlan, creativeContractRequired }),
  }));
  return {
    schemaVersion: 1,
    targetDocumentId: targetId,
    requiredDocumentIds,
    priorityDocumentIds,
    entries,
    creativeContractReadRequired: creativeContractRequired,
    memoryDocumentsPlanned: Boolean(memoryPlan?.priorityIds?.some((documentId) => /^(?:script-)?memory-/u.test(documentId))),
    memorySkillRequired: false,
  };
};

export const compileTextTaskExecutionContext = ({
  taskContextSnapshot = null,
  sourceMessageId = "",
  taskRoute = null,
  targetDocumentId = "",
  readManifest = null,
} = {}) => {
  const snapshot = taskContextSnapshot && typeof taskContextSnapshot === "object" ? taskContextSnapshot : {};
  const sourceId = text(sourceMessageId);
  const taskId = text(snapshot.taskId) || sourceId;
  const workspaceIdentity = text(snapshot.workspaceIdentity)
    || `${snapshot.workspaceKind === "notebook" ? "notebook" : "project"}:${text(snapshot.workspacePath || snapshot.workspaceName).toLocaleLowerCase("en-US")}`;
  const targetId = text(targetDocumentId || readManifest?.targetDocumentId || snapshot.boundDocumentId);
  const adoptedExperienceIds = formalWritingTask(taskRoute)
    ? unique(snapshot.adoptedExperienceIds || [])
    : [];
  return {
    schemaVersion: 1,
    taskId,
    sourceMessageId: sourceId,
    idempotencyKey: `text-task:${workspaceIdentity}:${taskId || sourceId || "unbound"}`,
    workspace: {
      kind: snapshot.workspaceKind === "notebook" ? "notebook" : "project",
      identity: workspaceIdentity,
      path: text(snapshot.workspacePath),
      name: text(snapshot.workspaceName),
    },
    target: {
      documentId: targetId,
      title: targetId === text(snapshot.activeDocumentId) || targetId === text(snapshot.boundDocumentId) ? text(snapshot.documentTitle) : "",
      revision: targetId === text(snapshot.activeDocumentId) || targetId === text(snapshot.boundDocumentId) ? text(snapshot.documentRevision) : "",
      contentHash: targetId === text(snapshot.activeDocumentId) || targetId === text(snapshot.boundDocumentId) ? text(snapshot.documentContentHash) : "",
    },
    route: {
      taskKind: text(taskRoute?.taskKind),
      taskType: text(taskRoute?.intentEnvelope?.taskType || taskRoute?.taskType || taskRoute?.taskKind),
      writeMode: text(taskRoute?.intentEnvelope?.writeMode || taskRoute?.writeMode),
      mode: text(taskRoute?.mode),
      deliverableType: text(taskRoute?.deliverableType),
      selectedTopLevelPlacementId: text(taskRoute?.selectedTopLevelPlacementId),
      selectedModulePlacementId: text(taskRoute?.selectedModulePlacementId || taskRoute?.selectedRoutePlacementId),
      selectedSkillPlacementIds: unique(taskRoute?.selectedSkillPlacementIds || []),
      relationType: text(taskRoute?.relationType),
      relationRole: text(taskRoute?.relationRole),
      reason: text(taskRoute?.routeReason || taskRoute?.reason),
    },
    readManifest: readManifest && typeof readManifest === "object" ? readManifest : {
      schemaVersion: 1,
      targetDocumentId: targetId,
      requiredDocumentIds: [],
      priorityDocumentIds: [],
      entries: [],
      memorySkillRequired: false,
    },
    adoptedExperienceIds,
    write: {
      authorization: taskRoute?.writeAuthorization || null,
      taskContract: taskRoute?.taskContract || null,
    },
    capturedAt: text(snapshot.capturedAt) || new Date().toISOString(),
  };
};

export const normalizeTextTaskExecutionContext = (value = null) => {
  if (!value || typeof value !== "object" || Number(value.schemaVersion) !== 1) return null;
  const taskId = text(value.taskId);
  const sourceMessageId = text(value.sourceMessageId);
  if (!taskId && !sourceMessageId) return null;
  const readManifest = value.readManifest && typeof value.readManifest === "object" ? value.readManifest : {};
  return {
    ...value,
    schemaVersion: 1,
    taskId,
    sourceMessageId,
    idempotencyKey: text(value.idempotencyKey),
    adoptedExperienceIds: unique(value.adoptedExperienceIds || []),
    readManifest: {
      ...readManifest,
      schemaVersion: 1,
      targetDocumentId: text(readManifest.targetDocumentId),
      requiredDocumentIds: unique(readManifest.requiredDocumentIds || []),
      priorityDocumentIds: unique(readManifest.priorityDocumentIds || []),
      entries: Array.isArray(readManifest.entries) ? readManifest.entries.map((entry) => ({
        documentId: text(entry?.documentId),
        title: text(entry?.title),
        displayCharacterCount: Math.max(0, Number(entry?.displayCharacterCount) || 0),
        required: entry?.required === true,
        available: entry?.available !== false,
        reason: text(entry?.reason),
      })).filter((entry) => entry.documentId) : [],
      memorySkillRequired: false,
    },
  };
};
