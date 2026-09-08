import { compileTaskContract, normalizeTaskContract } from "./task-contract.js";

const text = (value = "") => String(value ?? "").trim();
const list = (value) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const targets = (value) => [...new Map((Array.isArray(value) ? value : [])
  .map((target) => ({
    documentId: text(target?.documentId),
    moduleId: text(target?.moduleId),
    viewId: text(target?.viewId),
    contextDomain: text(target?.contextDomain),
    title: text(target?.title),
    operation: text(target?.operation),
    folderId: text(target?.folderId),
    folderLabel: text(target?.folderLabel),
    volumeFolder: text(target?.volumeFolder),
    plannedFolderLabel: text(target?.plannedFolderLabel),
    plannedVolumeTitle: text(target?.plannedVolumeTitle),
    plannedVolumeNumber: Math.max(0, Number(target?.plannedVolumeNumber) || 0),
    folderSourceDocumentId: text(target?.folderSourceDocumentId),
  }))
  .filter((target) => target.documentId)
  .map((target) => [target.documentId, target]))
  .values()];
const clone = (value) => value == null ? value : structuredClone(value);

export const CREATIVE_TASK_OPERATIONS = new Set(["create", "patch", "append", "replace", "rename", "batch", "assist", "transform"]);

export const creativeCommitAuthorization = ({
  candidate = "",
  targetResolved = true,
  targetAmbiguous = false,
  multipleCandidates = false,
  explicitlyDeferred = false,
  permissionGranted = true,
  revisionConflict = false,
  selfCheckStatus = "passed",
} = {}) => {
  if (!text(candidate)) return { allowed: false, code: "NO_VALID_ARTIFACT", warning: "" };
  if (explicitlyDeferred) return { allowed: false, code: "USER_DEFERRED", warning: "" };
  if (multipleCandidates) return { allowed: false, code: "CANDIDATE_SELECTION_REQUIRED", warning: "" };
  if (!permissionGranted) return { allowed: false, code: "WRITE_PERMISSION_DENIED", warning: "" };
  if (revisionConflict) return { allowed: false, code: "REVISION_CONFLICT", warning: "" };
  if (!targetResolved || targetAmbiguous) return { allowed: false, code: "TARGET_AMBIGUOUS", warning: "" };
  const status = text(selfCheckStatus).toLowerCase();
  return {
    allowed: true,
    code: status === "blocked" || status === "warning" ? "AUTHORIZED_WITH_REVIEW_WARNING" : "AUTHORIZED",
    warning: status === "blocked" || status === "warning"
      ? "自检意见作为质量提示保留；用户授权的有效正式文稿自动落盘"
      : "",
  };
};

export const buildUnifiedCreativeTask = ({
  taskId = "",
  instruction = "",
  taskType = "",
  objective = "",
  deliverables = null,
  exclusions = [],
  acceptanceCriteria = [],
  taskContract = null,
  sourceMessageId = "",
  executionSurface = "chat",
  source = {},
  context = {},
  target = {},
  operation = "assist",
  writeAuthorization = null,
} = {}) => {
  const prompt = text(instruction);
  const selectedSkillIds = list([
    ...list(context.skillIds),
    ...list(taskContract?.skillIds),
  ]);
  const selfCheckRequested = /(?:自检|检查|审稿|诊断)(?:并|后|再)?(?:修改|优化|修复|落盘|写入)?/u.test(prompt)
    && !/(?:不要|无需|不必|禁止|跳过|取消)\s*(?:额外)?(?:自检|检查|审稿|诊断)/u.test(prompt);
  const fullRewriteRequested = /(?:全文|整体|全部|完整)(?:重新)?(?:重写|改写|替换)|重新写一版完整正文/u.test(prompt);
  const requestedOperation = CREATIVE_TASK_OPERATIONS.has(operation) ? operation : "assist";
  const authorizationState = ["candidate_only", "commit"].includes(writeAuthorization?.state)
    ? writeAuthorization.state
    : "none";
  const normalizedOperation = authorizationState === "none" ? "assist" : requestedOperation;
  const defaultDisposition = authorizationState === "commit"
    ? "auto_commit"
    : authorizationState === "candidate_only" ? "candidate_only" : "no_artifact";
  const normalizedTarget = {
    workId: text(target.workId || source.workId),
    workspaceKind: target.workspaceKind === "notebook" ? "notebook" : target.workspaceKind === "project" ? "project" : (context.workspaceKind === "notebook" ? "notebook" : "project"),
    workspacePath: text(target.workspacePath || context.workspacePath),
    workspaceName: text(target.workspaceName || context.workspaceName),
    contentType: text(target.contentType) || text(source.contentType) || "document",
    documentId: text(target.documentId),
    directoryId: text(target.directoryId),
    requestedTitle: text(target.requestedTitle),
    folderId: text(target.folderId),
    folderLabel: text(target.folderLabel),
    volumeFolder: text(target.volumeFolder),
    plannedFolderLabel: text(target.plannedFolderLabel),
    plannedVolumeTitle: text(target.plannedVolumeTitle),
    plannedVolumeNumber: Math.max(0, Number(target.plannedVolumeNumber) || 0),
    folderSourceDocumentId: text(target.folderSourceDocumentId),
    forceCreateNew: target.forceCreateNew === true,
    allowMultiple: target.allowMultiple === true,
    allowFormatMismatch: target.allowFormatMismatch === true,
    documents: targets(target.documents ?? target.primaryTargets),
  };
  const normalizedTaskContract = taskContract?.protocol
    ? normalizeTaskContract(taskContract, {
        instruction: prompt,
        operation: normalizedOperation,
        target: normalizedTarget,
        skillIds: selectedSkillIds,
        sourceMessageId,
      })
    : compileTaskContract({
        taskType,
        objective,
        instruction: prompt,
        operation: normalizedOperation,
        target: normalizedTarget,
        deliverables,
        exclusions,
        acceptanceCriteria,
        skillIds: selectedSkillIds,
        sourceMessageId,
      });
  return {
    schemaVersion: 1,
    taskId: text(taskId) || `creative-${Date.now().toString(36)}`,
    instruction: prompt,
    executionSurface: executionSurface === "agent" ? "agent" : "chat",
    source: {
      workId: text(source.workId),
      documentIds: list(source.documentIds ?? source.documentId),
      contentType: text(source.contentType) || "document",
      ...(Number(source.chapter) > 0 ? { chapter: Number(source.chapter) } : {}),
      ...(Number(source.episode) > 0 ? { episode: Number(source.episode) } : {}),
    },
    context: {
      workspaceKind: context.workspaceKind === "notebook" ? "notebook" : "project",
      workspacePath: text(context.workspacePath),
      workspaceName: text(context.workspaceName),
      associatedDocumentId: text(context.associatedDocumentId),
      activeDocumentId: text(context.activeDocumentId),
      associationEnabled: context.associationEnabled !== false,
      associationRevision: Math.max(0, Number(context.associationRevision) || 0),
      documentRevision: text(context.documentRevision),
      initialBoundDocumentId: text(context.initialBoundDocumentId || context.associatedDocumentId),
      referenceDocumentIds: list(context.referenceDocumentIds),
      skillIds: selectedSkillIds,
      loadingLevel: [1, 2, 3].includes(Number(context.loadingLevel)) ? Number(context.loadingLevel) : 1,
    },
    target: normalizedTarget,
    operation: normalizedOperation,
    taskContract: normalizedTaskContract,
    allowFormatMismatch: normalizedTarget.allowFormatMismatch === true,
    writeAuthorization: clone(writeAuthorization),
    qualityPolicy: { selfCheckRequested, fullRewriteRequested, maxRepairRounds: selfCheckRequested ? 2 : 0 },
    commitPolicy: {
      defaultDisposition,
      exceptions: ["explicit_user_deferral", "multiple_candidates", "ambiguous_target", "permission_denied", "revision_conflict", "invalid_artifact"],
      subjectiveReviewBlocksCommit: false,
      requiresFormalWriteAuthorization: true,
    },
  };
};
