import { buildMemoryReadPlan } from "./memory-compiler.js";

const text = (value = "") => String(value ?? "").trim();
const unique = (values = []) => [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
const body = (document = {}) => text(document.markdown || document.text || document.html || document.content)
  .replace(/<[^>]+>/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const documentReason = ({ documentId, requiredIds, explicitIds, targetDocumentId, memoryPlan }) => {
  if (documentId === targetDocumentId) return "本轮冻结目标文档";
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
    reason: documentReason({ documentId, requiredIds: routeRequiredIds, explicitIds, targetDocumentId: targetId, memoryPlan }),
  }));
  return {
    schemaVersion: 1,
    targetDocumentId: targetId,
    requiredDocumentIds,
    priorityDocumentIds,
    entries,
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
