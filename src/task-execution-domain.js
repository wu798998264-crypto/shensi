const text = (value, limit = 500) => String(value || "").trim().slice(0, limit);
const values = (items, mapper, limit = 64) => [...new Set((Array.isArray(items) ? items : []).map(mapper).map((item) => text(item, 500)).filter(Boolean))].slice(0, limit);

export const normalizeReferenceContextContract = (scope = {}) => ({
  schemaVersion: 2,
  documentReferenceIds: values(scope.references ?? scope.documentReferenceIds, (item) => typeof item === "string" ? item : item?.id),
  workspaceReferenceIds: values(scope.workspaceReferences ?? scope.workspaceReferenceIds, (item) => typeof item === "string" ? item : item?.key || `${item?.workspaceKind || ""}:${item?.workspacePath || ""}:${item?.documentId || ""}`),
  skillReferenceIds: values(scope.skillReferences ?? scope.skillReferenceIds, (item) => typeof item === "string" ? item : item?.id || item?.relativePath || item?.name),
  attachmentReferenceIds: values(scope.attachments ?? scope.attachmentReferenceIds, (item) => typeof item === "string" ? item : item?.id || item?.relativePath || item?.sourceUrl || item?.name),
  sourceMessageId: text(scope.sourceMessageId, 160),
  cleared: scope.cleared === true,
});

export const createTaskPacket = ({
  requestId = "",
  conversationId = "",
  branchId = "",
  threadScopeId = "",
  executionOwner = "",
  executionSurface = "",
  referenceContext = {},
  messageCount = 0,
} = {}) => ({
  schemaVersion: 1,
  requestId: text(requestId, 160),
  conversationId: text(conversationId, 160),
  branchId: text(branchId, 160),
  threadScopeId: text(threadScopeId, 320),
  executionOwner: text(executionOwner, 80),
  executionSurface: text(executionSurface, 40),
  referenceContext: normalizeReferenceContextContract(referenceContext),
  messageCount: Math.max(0, Math.min(1_000_000, Number(messageCount) || 0)),
});

export const normalizeTaskPacket = (packet = {}) => {
  if (!packet || Number(packet.schemaVersion) !== 1) return null;
  return createTaskPacket(packet);
};

export const createExecutionContract = ({ taskPacket = {}, executor = "", taskRoute = {}, target = {} } = {}) => ({
  schemaVersion: 1,
  taskPacket: normalizeTaskPacket(taskPacket) || createTaskPacket(taskPacket),
  executor: text(executor, 80),
  taskRoute: {
    mode: text(taskRoute?.mode, 80),
    owner: text(taskRoute?.owner || taskRoute?.executionOwner, 80),
    reason: text(taskRoute?.reason, 500),
  },
  target: {
    documentId: text(target?.documentId, 160),
    moduleId: text(target?.moduleId, 80),
    contextDomain: text(target?.contextDomain, 80),
  },
});

export const normalizeExecutionContract = (contract = {}) => {
  if (!contract || Number(contract.schemaVersion) !== 1) return null;
  const taskPacket = normalizeTaskPacket(contract.taskPacket);
  return taskPacket ? createExecutionContract({ ...contract, taskPacket }) : null;
};

export const createModificationIntent = ({ transactionId = "", promptHash = "", baselineId = "", createdAt = "" } = {}) => ({
  schemaVersion: 1,
  transactionId: text(transactionId, 160),
  promptHash: text(promptHash, 128),
  baselineId: text(baselineId, 500),
  createdAt: text(createdAt, 80) || new Date().toISOString(),
});

export const createPostconditionReport = ({ transactionId = "", changedFiles = [], verified = false, reason = "", checkedAt = "" } = {}) => ({
  schemaVersion: 1,
  transactionId: text(transactionId, 160),
  verified: verified === true,
  changedFiles: values(changedFiles, (item) => item, 512),
  reason: text(reason, 1_000),
  checkedAt: text(checkedAt, 80) || new Date().toISOString(),
});

export const createUndoTransactionContract = ({ transactionId = "", turnId = "", baselineId = "", modificationIntent = null, state = "prepared", createdAt = "", completedAt = "", undoneAt = "" } = {}) => ({
  schemaVersion: 1,
  transactionId: text(transactionId, 160),
  turnId: text(turnId, 160),
  baselineId: text(baselineId, 128),
  modificationIntent: modificationIntent && typeof modificationIntent === "object" ? createModificationIntent(modificationIntent) : null,
  state: ["prepared", "committed", "undone"].includes(state) ? state : "prepared",
  createdAt: text(createdAt, 80) || new Date().toISOString(),
  completedAt: text(completedAt, 80),
  undoneAt: text(undoneAt, 80),
});
