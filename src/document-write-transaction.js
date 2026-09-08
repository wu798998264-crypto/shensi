import { hasSubstantiveVersionContent } from "./version-store.js";
import {
  createDocumentVersionSnapshot,
  documentVersionHash,
  verifyDocumentVersionSnapshot,
} from "./version-integrity.js?v=3.0.10-sync-document-hash";
import { validateFormalWriteAuthorization } from "./formal-write-authorization.js";

const OPERATIONS = new Set(["create", "replace", "partial-replace", "continuation", "rename", "restore"]);
const clean = (value = "") => String(value ?? "").trim();
const clone = (value) => value == null ? value : structuredClone(value);
const body = (documentState = {}) => String(documentState?.html ?? documentState?.markdown ?? documentState?.text ?? "");
const visible = (value = "") => String(value)
  .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/giu, " ")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const fail = (message, code) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

export const beginDocumentWriteTransaction = async ({
  transactionId = "",
  documentId = "",
  documentState = null,
  operation = "replace",
  source = "agent",
  candidateContent = "",
  authorizationCandidate = candidateContent,
  expectedDocumentHash = "",
  expectedRevision = "",
  parentVersionId = "",
  writeAuthorization = null,
  sourceMessageId = "",
  sourceInstruction = "",
} = {}) => {
  const id = clean(documentId);
  const type = clean(operation);
  if (!id) fail("写入事务缺少目标文档", "DOCUMENT_TRANSACTION_TARGET_MISSING");
  if (!OPERATIONS.has(type)) fail(`不支持的文档写入方式：${type}`, "DOCUMENT_TRANSACTION_OPERATION_INVALID");
  if (type !== "create" && !documentState) fail(`目标文档不存在：${id}`, "DOCUMENT_TRANSACTION_TARGET_NOT_FOUND");
  if (type === "create" && documentState) fail(`新建目标已存在：${id}`, "DOCUMENT_TRANSACTION_TARGET_EXISTS");
  if (!visible(candidateContent)) fail("正式候选稿为空，已阻止写入", "DOCUMENT_TRANSACTION_EMPTY_CANDIDATE");
  const authorizationCheck = validateFormalWriteAuthorization(writeAuthorization, {
    requiredState: "commit",
    sourceMessageId,
    instruction: sourceInstruction,
    candidate: authorizationCandidate,
    targetDocumentIds: writeAuthorization?.targetDocumentIds,
    expectedRevisions: writeAuthorization?.expectedRevisions,
    requireBodyMutation: !["restore", "rename"].includes(type),
    requireTitleMutation: type === "rename",
  });
  if (!authorizationCheck.valid) fail(`正式写入授权无效：${authorizationCheck.reason}`, "DOCUMENT_TRANSACTION_UNAUTHORIZED");
  if (!writeAuthorization.targetDocumentIds.includes(id)) fail("写入目标不在授权范围内", "DOCUMENT_TRANSACTION_TARGET_UNAUTHORIZED");
  const currentRevision = clean(documentState?.revision ?? documentState?.contentRevision);
  if (clean(expectedRevision) && clean(expectedRevision) !== currentRevision) {
    fail("目标文档 revision 已变化", "DOCUMENT_TRANSACTION_REVISION_CONFLICT");
  }

  const beforeDocument = clone(documentState);
  const beforeHash = documentState ? await documentVersionHash(documentState) : "";
  if (clean(expectedDocumentHash) && clean(expectedDocumentHash) !== beforeHash) {
    fail("目标文档已在候选生成后变化", "DOCUMENT_TRANSACTION_BASELINE_CONFLICT");
  }
  const substantiveBefore = documentState && hasSubstantiveVersionContent(body(documentState), {
    title: documentState?.title ?? "",
    placeholder: documentState?.placeholder ?? "",
  });
  const snapshot = substantiveBefore || (documentState && documentState.kind !== "canvas" && documentState.documentKind !== "whiteboard")
    ? await createDocumentVersionSnapshot({
        documentId: id,
        documentState,
        parentVersionId,
        source,
        operation: type,
        transactionId,
      })
    : null;
  if (snapshot) {
    const verification = await verifyDocumentVersionSnapshot(snapshot);
    if (!verification.ok) fail(verification.reason, verification.code);
    if (snapshot.documentHash !== beforeHash || body(snapshot.document) !== body(documentState)) {
      fail("历史快照与写入前正文不一致", "DOCUMENT_TRANSACTION_SNAPSHOT_MISMATCH");
    }
  }
  const baseline = documentState && !substantiveBefore ? {
    kind: "blank_document_baseline",
    documentId: id,
    transactionId: clean(transactionId),
    title: clean(documentState.title),
    moduleId: clean(documentState.moduleId),
    revision: currentRevision,
    documentHash: beforeHash,
  } : type === "create" ? {
    kind: "new_document_structure",
    documentId: id,
    transactionId: clean(transactionId),
  } : null;
  return {
    schemaVersion: 1,
    transactionId: clean(transactionId) || `write-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`,
    documentId: id,
    operation: type,
    source: clean(source) || "agent",
    beforeHash,
    beforeBody: body(beforeDocument),
    beforeDocument,
    snapshot,
    baseline,
    writeAuthorization: clone(writeAuthorization),
    candidateHash: await documentVersionHash({ candidateContent: String(candidateContent) }),
    status: "prepared",
  };
};

export const commitDocumentWriteTransaction = async ({ transaction, nextDocument } = {}) => {
  if (!transaction || transaction.status !== "prepared") fail("写入事务没有完成预检", "DOCUMENT_TRANSACTION_NOT_PREPARED");
  if (!nextDocument) fail("写入结果不存在", "DOCUMENT_TRANSACTION_RESULT_MISSING");
  const nextBody = body(nextDocument);
  if (transaction.operation !== "rename" && !hasSubstantiveVersionContent(nextBody, {
    title: nextDocument.title ?? "",
    placeholder: nextDocument.placeholder ?? "",
  })) fail("写入结果没有有效正文，已阻止覆盖", "DOCUMENT_TRANSACTION_EMPTY_RESULT");
  if (transaction.operation === "continuation" && transaction.beforeBody && !nextBody.startsWith(transaction.beforeBody)) {
    fail("续写结果没有保留原正文，已阻止覆盖", "DOCUMENT_TRANSACTION_APPEND_VIOLATION");
  }
  // A create transaction has no prior title to mutate. Its initial title is
  // part of the authorized document structure, not an implicit rename.
  const titleChanged = transaction.operation !== "create"
    && clean(nextDocument.title) !== clean(transaction.beforeDocument?.title);
  if (transaction.operation === "rename" && !titleChanged) {
    fail("标题没有发生变化，未创建空操作版本", "DOCUMENT_TRANSACTION_TITLE_NO_CHANGE");
  }
  if (titleChanged && transaction.writeAuthorization?.allowTitleMutation !== true) {
    fail("标题变更未获授权", "DOCUMENT_TRANSACTION_TITLE_UNAUTHORIZED");
  }
  if (nextBody !== transaction.beforeBody && transaction.writeAuthorization?.allowBodyMutation !== true) {
    fail("正文变更未获授权", "DOCUMENT_TRANSACTION_BODY_UNAUTHORIZED");
  }
  const afterHash = await documentVersionHash(nextDocument);
  if (transaction.beforeHash && transaction.beforeHash === afterHash) {
    fail("写入结果与当前版本相同，未创建空操作版本", "DOCUMENT_TRANSACTION_NO_CHANGE");
  }
  return {
    schemaVersion: 1,
    transactionId: transaction.transactionId,
    documentId: transaction.documentId,
    operation: transaction.operation,
    source: transaction.source,
    beforeHash: transaction.beforeHash,
    afterHash,
    snapshotHash: transaction.snapshot?.snapshotHash || "",
    baselineKind: transaction.baseline?.kind || "",
    verified: true,
    status: "committed",
  };
};

export const rollbackDocumentWriteTransaction = (transaction = {}) => clone(transaction.beforeDocument);

export const beginDocumentWriteBatch = async ({ transactionId = "", writes = [] } = {}) => {
  const requested = Array.isArray(writes) ? writes : [];
  if (!requested.length) fail("批量写入没有目标", "DOCUMENT_TRANSACTION_BATCH_EMPTY");
  const ids = requested.map((write) => clean(write?.documentId));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("批量写入目标缺失或重复", "DOCUMENT_TRANSACTION_BATCH_TARGET_INVALID");
  }
  const transactions = [];
  for (let index = 0; index < requested.length; index += 1) {
    transactions.push(await beginDocumentWriteTransaction({
      ...requested[index],
      transactionId: clean(transactionId) ? `${clean(transactionId)}:${index + 1}` : "",
    }));
  }
  return { schemaVersion: 1, transactionId: clean(transactionId), status: "prepared", transactions };
};

export const commitDocumentWriteBatch = async ({ batch = null, results = [] } = {}) => {
  if (!batch || batch.status !== "prepared") fail("批量写入未完成预检", "DOCUMENT_TRANSACTION_BATCH_NOT_PREPARED");
  const resultMap = new Map((Array.isArray(results) ? results : []).map((result) => [clean(result?.documentId), result?.nextDocument]));
  if (resultMap.size !== batch.transactions.length) fail("批量写入结果不完整", "DOCUMENT_TRANSACTION_BATCH_RESULT_MISMATCH");
  const receipts = [];
  for (const transaction of batch.transactions) {
    const nextDocument = resultMap.get(transaction.documentId);
    if (!nextDocument) fail(`批量写入缺少目标结果：${transaction.documentId}`, "DOCUMENT_TRANSACTION_BATCH_RESULT_MISMATCH");
    receipts.push(await commitDocumentWriteTransaction({ transaction, nextDocument }));
  }
  return { schemaVersion: 1, transactionId: batch.transactionId, status: "committed", verified: receipts.every((receipt) => receipt.verified), receipts };
};
