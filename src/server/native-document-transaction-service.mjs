import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import { applyDocumentPatchPlan } from "../document-patch-engine.js";
import { createBlankNotebookState, createBlankProjectState } from "../data.js";
import { contentRevision } from "../workspace-operations.js";
import { formalDocumentWriteRevisionFromState } from "../document-write-revision.js";
import { createBlankDocumentBaseline, createResourceVersion, hasSubstantiveVersionContent } from "../version-store.js";
import { validateFormalWriteAuthorization } from "../formal-write-authorization.js";
import { preserveProtectedDocumentMedia } from "../protected-document-media.js";
import { managedDocumentFormatMetadata, validateManagedDocumentFormat } from "../managed-document-format.js";
import { loadWorkspaceState, saveWorkspaceState, workspaceKindForPath } from "./workspace.mjs";
import { addDocumentHierarchyPrewriteHistory } from "./document-hierarchy-prewrite-history.mjs";
import { applyWorkspaceDocumentLocationInState, ensureWorkspaceFolderInState, refreshWorkspaceFolderMetadata } from "./native-workspace-structure-service.mjs";

const clone = (value) => structuredClone(value);
const clean = (value = "") => String(value ?? "").trim();
const documentContent = (document = {}) => String(document?.markdown || document?.text || document?.html || "");
const operationFingerprint = (operation = {}) => createHash("sha256")
  .update(JSON.stringify({
    type: clean(operation.type) || "replace",
    targetDocumentId: clean(operation.targetDocumentId),
    targetDirectoryId: clean(operation.targetDirectoryId),
    contentType: clean(operation.contentType),
    requestedTitle: clean(operation.requestedTitle),
    viewId: clean(operation.viewId),
    folderId: clean(operation.folderId),
    folderLabel: clean(operation.folderLabel),
    parentFolderId: clean(operation.parentFolderId),
    formatContractId: clean(operation.formatContractId),
    formatContractVersion: Number(operation.formatContractVersion) || 0,
    formatContract: operation.formatContract && typeof operation.formatContract === "object" ? operation.formatContract : null,
    content: String(operation.content ?? ""),
    patches: Array.isArray(operation.patches) ? operation.patches : [],
  }))
  .digest("hex");
const basicHtml = (markdown = "") => String(markdown).split(/\n{2,}/u)
  .map((paragraph) => `<p>${paragraph.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`)
  .join("");

const initialTransactionWorkspaceState = ({ appRoot, workspacePath, task }) => {
  const name = clean(task?.target?.workId) || basename(workspacePath);
  const options = { name, workspacePath };
  return workspaceKindForPath({ appRoot, requestedPath: workspacePath }) === "notebook"
    ? createBlankNotebookState(options)
    : createBlankProjectState(options);
};

const ensureTargetIsNotSource = (task, targetDocumentId) => {
  if (task?.operation !== "transform") return;
  if ((task?.source?.documentIds ?? []).map(String).includes(String(targetDocumentId))) {
    const error = new Error("跨文体 Target 不能覆盖 Source");
    error.code = "CROSS_FORMAT_SOURCE_TARGET_COLLISION";
    throw error;
  }
};

const operationDocumentId = (operation) => clean(operation.targetDocumentId)
  || `document-${clean(operation.operationId).replace(/[^A-Za-z0-9_-]/g, "-") || randomUUID()}`;

const defaultDocumentTitle = (documentId = "", contentType = "") => {
  const chapter = clean(documentId).match(/^chapter-(\d+)$/u)?.[1];
  if (chapter) return `第${chapter}章 未命名`;
  const episode = clean(documentId).match(/^script-episode-(\d+)$/u)?.[1];
  if (episode) return `第${episode}集 未命名`;
  if (clean(contentType) === "script") return "未命名剧本";
  return "未命名文档";
};

const applyOperation = ({ state, task, operation, expectedRevisions, transactionId, writeAuthorization }) => {
  const operationId = clean(operation.operationId) || `op-${randomUUID()}`;
  const documentId = operationDocumentId({ ...operation, operationId });
  ensureTargetIsNotSource(task, documentId);
  state.documentTransactionLog ??= {};
  const replay = state.documentTransactionLog[operationId];
  if (replay?.targetDocumentId === documentId && state.documents?.[documentId]) {
    const fingerprint = operationFingerprint(operation);
    if (replay.operationFingerprint && replay.operationFingerprint !== fingerprint) {
      const error = new Error(`操作 ${operationId} 已用于不同的文档写入内容`);
      error.code = "DOCUMENT_TRANSACTION_IDEMPOTENCY_CONFLICT";
      throw error;
    }
    return {
      operationId,
      documentId,
      idempotentReplay: true,
      changed: false,
      logicalOperation: clean(operation.type) || "replace",
      requestedTitle: clean(operation.requestedTitle) || state.documents[documentId]?.title || documentId,
      targetDirectoryId: clean(operation.targetDirectoryId) || state.documents[documentId]?.moduleId || "library",
      contentType: clean(operation.contentType),
      versionId: replay.versionId || "",
      beforeRevision: replay.beforeRevision || "",
      afterRevision: replay.afterRevision || replay.contentHash || "",
      changeSet: replay.changeSet || [],
    };
  }
  const existing = state.documents?.[documentId] ?? null;
  const previousContent = documentContent(existing);
  const expectedRevision = clean(expectedRevisions?.[documentId]);
  const currentWriteRevision = existing ? formalDocumentWriteRevisionFromState(state, documentId) : "";
  if (expectedRevision && expectedRevision !== currentWriteRevision) {
    const error = new Error(`目标 ${documentId} 的磁盘最新版已变化`);
    error.code = "DOCUMENT_REVISION_CONFLICT";
    throw error;
  }
  const type = clean(operation.type) || "replace";
  if (type !== "create" && !existing) throw Object.assign(new Error(`目标文档不存在：${documentId}`), { code: "DOCUMENT_TARGET_NOT_FOUND" });
  if (type === "create" && existing) throw Object.assign(new Error(`新建目标已存在：${documentId}`), { code: "DOCUMENT_TARGET_EXISTS" });
  if (type !== "rename" && writeAuthorization?.allowBodyMutation !== true) {
    throw Object.assign(new Error(`目标 ${documentId} 的正文变更未获授权`), { code: "DOCUMENT_BODY_MUTATION_UNAUTHORIZED" });
  }
  const requestedTitle = clean(operation.requestedTitle);
  if (requestedTitle && requestedTitle !== clean(existing?.title) && writeAuthorization?.allowTitleMutation !== true) {
    throw Object.assign(new Error(`目标 ${documentId} 的标题变更未获授权`), { code: "DOCUMENT_TITLE_MUTATION_UNAUTHORIZED" });
  }
  const patchResult = type === "patch"
    ? applyDocumentPatchPlan(previousContent, operation.patches, { expectedRevision: contentRevision(previousContent) })
    : null;
  const nextContent = type === "patch"
    ? patchResult.content
    : type === "append"
      ? `${previousContent}${previousContent.endsWith("\n") || !previousContent ? "" : "\n\n"}${String(operation.content ?? "")}`
      : type === "rename"
        ? previousContent
        : String(operation.content ?? "");
  const intendedModuleId = clean(operation.targetDirectoryId) || existing?.moduleId || clean(task?.target?.directoryId) || "library";
  const managedFormatCheck = type === "rename" ? { valid: true } : validateManagedDocumentFormat({
    documentId,
    moduleId: intendedModuleId,
    content: nextContent,
    formatContract: operation.formatContract,
    formatContractId: operation.formatContractId,
    formatContractVersion: operation.formatContractVersion,
    allowLegacyInference: false,
  });
  if (!managedFormatCheck.valid && task?.allowFormatMismatch !== true) {
    throw Object.assign(new Error(`目标 ${documentId} 没有通过结构化文档格式校验：${managedFormatCheck.reason}`), { code: "MANAGED_DOCUMENT_FORMAT_INVALID" });
  }
  let versionId = "";
  let blankBaseline = null;
  const textDocument = existing && existing.kind !== "canvas" && existing.documentKind !== "whiteboard";
  if (existing && (textDocument || hasSubstantiveVersionContent(previousContent, { title: existing.title || "", placeholder: existing.placeholder || "" }))) {
    state.histories ??= {};
    state.histories[documentId] ??= [];
    const parentVersionId = state.histories[documentId][0]?.versionId || state.histories[documentId][0]?.id || "";
    const resourceVersion = createResourceVersion({
      versionId: `version-${randomUUID()}`,
      resourceId: documentId,
      resourceType: existing.kind === "canvas" ? "whiteboard" : "document",
      parentVersionId,
      source: task?.executionSurface === "agent" ? "agent" : "chat",
      operation: type,
      content: previousContent,
      title: existing.title || "",
      structure: {
        moduleId: existing.moduleId || "",
        workspaceView: existing.workspaceView || "",
        contextDomain: existing.contextDomain || "",
      },
      attachmentRefs: existing.attachments?.map((attachment) => attachment.relativePath) ?? [],
      transactionId,
      beforeRevision: patchResult?.beforeRevision || contentRevision(previousContent),
      afterRevision: patchResult?.afterRevision || contentRevision(nextContent),
      changeSet: patchResult?.changeSet || [],
      changedCharacterCount: patchResult?.changedCharacterCount || 0,
    });
    versionId = resourceVersion.versionId;
    state.histories[documentId].unshift({
      ...resourceVersion,
      id: resourceVersion.versionId,
      title: `${existing.title || documentId} · 覆盖前版本`,
      version: `v${state.histories[documentId].length + 1}`,
      time: resourceVersion.createdAt,
      html: existing.html || basicHtml(previousContent),
      ...(textDocument ? { document: clone(existing) } : {}),
      afterContent: nextContent,
      changeSet: patchResult?.changeSet || [],
    });
    if (resourceVersion.contentHash !== contentRevision(previousContent)) {
      throw Object.assign(new Error(`目标 ${documentId} 的历史快照正文哈希不一致`), { code: "DOCUMENT_HISTORY_HASH_MISMATCH" });
    }
  }
  if (existing && !hasSubstantiveVersionContent(previousContent, {
    title: existing.title || "", placeholder: existing.placeholder || "",
  })) {
    blankBaseline = createBlankDocumentBaseline({
      resourceId: documentId,
      transactionId,
      title: existing.title || "",
      structure: { moduleId: existing.moduleId || "", workspaceView: existing.workspaceView || "", contextDomain: existing.contextDomain || "" },
      revision: contentRevision(previousContent),
    });
  }
  const targetContentType = clean(operation.contentType) || clean(task?.target?.contentType);
  const title = clean(operation.requestedTitle) || existing?.title || clean(task?.target?.requestedTitle) || defaultDocumentTitle(documentId, targetContentType);
  const workspaceView = targetContentType === "script" ? "script"
    : ["prompt", "storyboard"].includes(targetContentType) ? "prompts"
      : targetContentType === "novel" ? "novel" : existing?.workspaceView;
  const nextHtml = type === "rename"
    ? String(existing?.html || basicHtml(previousContent))
    : type === "append"
      ? `${String(existing?.html || basicHtml(previousContent))}${basicHtml(String(operation.content ?? ""))}`
      : existing
        ? preserveProtectedDocumentMedia({ previousHtml: existing.html || "", nextHtml: basicHtml(nextContent) })
        : basicHtml(nextContent);
  state.documents ??= {};
  state.documents[documentId] = {
    ...(existing ?? {}),
    title,
    markdown: nextContent,
    html: nextHtml,
    moduleId: intendedModuleId,
    ...(workspaceView ? { workspaceView } : {}),
    ...(targetContentType === "script" ? { contextDomain: "script" } : {}),
    placementOverride: true,
    updatedAt: new Date().toISOString(),
  };
  const managedFormat = managedDocumentFormatMetadata({
    documentId,
    moduleId: intendedModuleId,
    formatContract: operation.formatContract,
    formatContractId: operation.formatContractId,
    formatContractVersion: operation.formatContractVersion,
    allowLegacyInference: false,
    source: "native-document-transaction",
  });
  if (managedFormat) state.documents[documentId].managedFormat = managedFormat;
  state.moduleItems ??= {};
  const moduleId = state.documents[documentId].moduleId;
  state.moduleItems[moduleId] ??= [];
  const itemOptions = {
    ...(workspaceView ? { workspaceView } : {}),
    ...(targetContentType === "script" ? { contextDomain: "script", treeGroup: "scripts" } : {}),
    ...(["prompt", "storyboard"].includes(targetContentType) ? { treeGroup: "video" } : {}),
  };
  const existingItem = state.moduleItems[moduleId].find((item) => item?.[0] === documentId);
  if (existingItem) {
    existingItem[1] = title;
    existingItem[2] = { ...(existingItem[2] ?? {}), ...itemOptions };
  } else state.moduleItems[moduleId].push([documentId, title, itemOptions]);
  state.documentTransactionLog[operationId] = {
    operationId,
    targetDocumentId: documentId,
    contentHash: contentRevision(nextContent),
    status: "prepared",
    transactionId,
    operationFingerprint: operationFingerprint(operation),
    versionId,
    beforeRevision: patchResult?.beforeRevision || contentRevision(previousContent),
    afterRevision: patchResult?.afterRevision || contentRevision(nextContent),
    changeSet: patchResult?.changeSet || [],
    blankBaseline,
  };
  return {
    operationId,
    documentId,
    idempotentReplay: false,
    changed: true,
    logicalOperation: type,
    requestedTitle: title,
    targetDirectoryId: moduleId,
    contentType: targetContentType,
    versionId,
    beforeRevision: patchResult?.beforeRevision || contentRevision(previousContent),
    afterRevision: patchResult?.afterRevision || contentRevision(nextContent),
    changeSet: patchResult?.changeSet || [],
  };
};

const receiptForOperation = (batchReceipt, applied) => {
  const physical = batchReceipt?.results?.find((item) => item.targetDocumentId === applied.documentId);
  return physical ? {
    ...physical,
    operationId: applied.operationId,
    idempotentReplay: applied.idempotentReplay,
    logicalOperation: applied.logicalOperation,
    requestedTitle: applied.requestedTitle,
    targetDirectoryId: applied.targetDirectoryId,
    contentType: applied.contentType,
    versionId: applied.versionId,
    beforeRevision: applied.beforeRevision,
    afterRevision: applied.afterRevision,
    changeSet: applied.changeSet,
    navigationTarget: {
      documentId: applied.documentId,
      moduleId: applied.targetDirectoryId,
      ...(applied.viewId ? { viewId: applied.viewId } : {}),
      ...(applied.folderId ? { folderId: applied.folderId } : {}),
    },
  } : null;
};

export const executeDocumentTransaction = async ({
  appRoot,
  workspacePath,
  task,
  operations = [],
  expectedRevisions = {},
  commitMode = "atomic",
  requestId = "",
  batchId: requestedBatchId = "",
} = {}) => {
  const requested = Array.isArray(operations) ? operations : [];
  if (!requested.length) throw new Error("DocumentTransaction 缺少操作");
  if (["chat", "agent"].includes(task?.executionSurface) && commitMode !== "atomic") {
    throw Object.assign(new Error("AI 正文批量写入只允许原子提交"), { code: "DOCUMENT_TRANSACTION_ATOMIC_REQUIRED" });
  }
  const requestedDocumentIds = requested.map((operation) => clean(operation.targetDocumentId));
  if (requestedDocumentIds.some((documentId) => !documentId)) {
    throw Object.assign(new Error("DocumentTransaction 每个目标都必须显式指定 documentId"), { code: "DOCUMENT_TRANSACTION_TARGET_MISSING" });
  }
  if (new Set(requestedDocumentIds).size !== requestedDocumentIds.length) {
    throw Object.assign(new Error("DocumentTransaction 存在重复目标"), { code: "DOCUMENT_TRANSACTION_DUPLICATE_TARGET" });
  }
  const authorizationCheck = validateFormalWriteAuthorization(task?.writeAuthorization, {
    requiredState: "commit",
    sourceMessageId: task?.writeAuthorization?.sourceMessageId,
    instruction: task?.instruction || "",
    candidate: task?.authorizedCandidate || "",
    targetDocumentIds: requestedDocumentIds,
    expectedRevisions,
    requireBodyMutation: requested.some((operation) => clean(operation.type) !== "rename"),
    requireTitleMutation: false,
  });
  if (!authorizationCheck.valid) {
    throw Object.assign(new Error(`DocumentTransaction 正式写入授权无效：${authorizationCheck.reason}`), { code: "DOCUMENT_TRANSACTION_UNAUTHORIZED" });
  }
  for (const operation of requested) {
    const type = clean(operation.type) || "replace";
    if (type === "patch" && (!Array.isArray(operation.patches) || !operation.patches.length)) {
      throw Object.assign(new Error(`目标 ${operationDocumentId(operation)} 缺少有效局部修改`), { code: "DOCUMENT_TRANSACTION_EMPTY_PATCH" });
    }
    if (!['rename', 'patch'].includes(type) && !hasSubstantiveVersionContent(String(operation.content ?? ""), { title: operation.requestedTitle || "" })) {
      throw Object.assign(new Error(`目标 ${operationDocumentId(operation)} 没有非空正式正文`), { code: "DOCUMENT_TRANSACTION_EMPTY_CANDIDATE" });
    }
  }
  const batchId = clean(requestedBatchId) || `batch-${randomUUID()}`;
  if (commitMode === "atomic") {
    const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
    const before = clone(loaded.state ?? initialTransactionWorkspaceState({ appRoot, workspacePath, task }));
    const next = clone(before);
    const structuralOperations = requested.filter((operation) => clean(operation.folderId || operation.folderLabel || operation.parentFolderId || operation.viewId || operation.targetDirectoryId));
    if (structuralOperations.length) addDocumentHierarchyPrewriteHistory({ beforeState: before, nextState: next, operations: structuralOperations, reason: "文档与目录原子写入前的层级历史快照" });
    const applied = requested.map((operation) => {
      let placement = null;
      if (clean(operation.folderLabel || operation.name) && !clean(operation.folderId)) placement = ensureWorkspaceFolderInState(next, {
        moduleId: clean(operation.targetDirectoryId) || clean(operation.moduleId) || clean(task?.target?.directoryId) || "library",
        viewId: clean(operation.viewId) || clean(operation.workspaceView) || "novel",
        name: operation.folderLabel || operation.name,
        parentFolderId: operation.parentFolderId,
      });
      const item = applyOperation({ state: next, task, operation, expectedRevisions, transactionId: batchId, writeAuthorization: task.writeAuthorization });
      const folderId = clean(operation.folderId) || clean(placement?.folderId);
      const moduleId = clean(operation.targetDirectoryId) || item.targetDirectoryId;
      const viewId = clean(operation.viewId) || (clean(operation.contentType) === "script" ? "script" : clean(operation.contentType) === "novel" ? "novel" : "");
      if (folderId || viewId) {
        const location = applyWorkspaceDocumentLocationInState(next, {
          documentId: item.documentId,
          moduleId,
          viewId: viewId || "novel",
          folderId,
          folderLabel: operation.folderLabel,
          treeGroup: operation.treeGroup,
        });
        item.viewId = viewId || location?.viewId || "";
        item.folderId = folderId;
      }
      item.viewId ||= clean(operation.viewId);
      item.folderId ||= folderId;
      return item;
    });
    refreshWorkspaceFolderMetadata(next);
    const committed = await saveWorkspaceState({
      appRoot,
      requestedPath: workspacePath,
      state: next,
      expectedStateStamp: loaded.stateStamp,
      operationDocumentIds: applied.map((item) => item.documentId),
    });
    const results = applied.map((item) => receiptForOperation(committed.batchLandingReceipt, item));
    if (results.some((item) => !item?.verified)) throw new Error("原子事务存在未验证的操作");
    return { ...committed.batchLandingReceipt, batchId, requestId: clean(requestId), status: "completed", succeeded: results.length, failed: 0, results, retryOperations: [] };
  }
  if (commitMode !== "partial") throw new Error(`未知提交模式：${commitMode}`);
  const results = [];
  const failures = [];
  for (const operation of requested) {
    try {
      const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
      const next = clone(loaded.state ?? initialTransactionWorkspaceState({ appRoot, workspacePath, task }));
      const applied = applyOperation({ state: next, task, operation, expectedRevisions, transactionId: batchId, writeAuthorization: task.writeAuthorization });
      const committed = await saveWorkspaceState({
        appRoot,
        requestedPath: workspacePath,
        state: next,
        expectedStateStamp: loaded.stateStamp,
        operationDocumentIds: [applied.documentId],
      });
      const receipt = receiptForOperation(committed.batchLandingReceipt, applied);
      if (!receipt?.verified) throw new Error("分项事务磁盘复核失败");
      results.push(receipt);
    } catch (error) {
      failures.push({ operationId: clean(operation.operationId), error: error.message, code: clean(error.code), operation });
    }
  }
  return {
    schemaVersion: 1,
    type: "shensi_batch_landing_receipt",
    batchId,
    requestId: clean(requestId),
    status: failures.length ? (results.length ? "partial" : "failed") : "completed",
    succeeded: results.length,
    failed: failures.length,
    results,
    failures,
    retryOperations: failures.map((failure) => failure.operation),
    verified: failures.length === 0 && results.every((item) => item.verified),
  };
};
