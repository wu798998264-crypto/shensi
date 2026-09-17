import { randomUUID } from "node:crypto";

import { documentVersionHash, stampHistoryEntryIntegrity, verifyHistoryEntryIntegrity } from "../version-integrity.js";

const entryId = (entry) => String(entry?.id || entry?.versionId || "");
const entries = (value) => Array.isArray(value) ? value : [];
const clone = (value) => value == null ? value : structuredClone(value);

const operationForDocument = (operations, documentId) => entries(operations).find((operation) => (
  String(operation?.targetDocumentId || operation?.documentId || "") === documentId
)) || null;

const currentVersionMetadata = (state, documentId) => state?.currentVersionMeta?.documents?.[documentId] || null;

const clearCurrentVersionMetadata = (state, documentId) => {
  if (state?.currentVersionMeta?.documents) delete state.currentVersionMeta.documents[documentId];
};

const historyDocument = (documentState) => {
  const snapshot = clone(documentState);
  // contentRef identifies the mutable live file. A version owns its embedded
  // content in history-isolated and must not retain another version's file pointer.
  if (snapshot && typeof snapshot === "object") delete snapshot.contentRef;
  return snapshot;
};

// The transaction owns this call. It stores the exact document that is being
// committed, so the visible current document and its history version advance
// together instead of waiting for a later overwrite.
export const prepareCommittedDocumentHistory = async ({
  currentState,
  nextState,
  changedDocumentIds = [],
  transactionId,
  operations = [],
  source = "",
} = {}) => {
  if (!currentState || !nextState) return [];
  nextState.histories ??= {};
  const receipts = [];

  for (const [documentId, previousEntries] of Object.entries(currentState.histories || {})) {
    const requested = entries(nextState.histories[documentId]);
    const known = new Set(requested.map(entryId));
    nextState.histories[documentId] = [
      ...entries(previousEntries).filter((entry) => !known.has(entryId(entry))),
      ...requested,
    ];
  }

  for (const documentId of new Set(changedDocumentIds.map(String))) {
    const committedDocument = nextState.documents?.[documentId];
    if (!committedDocument || committedDocument.kind === "canvas" || committedDocument.documentKind === "whiteboard") continue;

    const committedSnapshot = historyDocument(committedDocument);
    const documentHash = await documentVersionHash(committedSnapshot);
    const previousIds = new Set(entries(currentState.histories?.[documentId]).map(entryId));
    const requested = entries(nextState.histories[documentId]);
    let existing = null;
    for (const candidate of requested) {
      if (previousIds.has(entryId(candidate)) || !candidate.document) continue;
      if (await documentVersionHash(candidate.document) === documentHash) {
        existing = candidate;
        break;
      }
    }

    const metadata = currentVersionMetadata(nextState, documentId);
    const operation = operationForDocument(operations, documentId);
    const operationType = String(operation?.type || operation?.operation || existing?.operation || "replace");
    const id = entryId(existing) || String(metadata?.id || "") || `version-${randomUUID()}`;
    const createdAt = existing?.createdAt || new Date().toISOString();
    const version = stampHistoryEntryIntegrity({
      ...clone(existing),
      id,
      versionId: id,
      resourceId: documentId,
      scopeType: "document",
      scopeId: documentId,
      version: existing?.version && existing.version !== "当前版本" ? existing.version : `v${requested.length + 1}`,
      title: existing?.title || metadata?.title || `${committedDocument.title || documentId} · 写入版本`,
      time: existing?.time || metadata?.time || createdAt,
      createdAt,
      document: committedSnapshot,
      html: String(committedDocument.html ?? ""),
      markdown: String(committedDocument.markdown ?? committedDocument.text ?? ""),
      content: String(committedDocument.markdown ?? committedDocument.text ?? committedDocument.html ?? ""),
      operation: operationType,
      committedWriteSnapshot: true,
      writeTransactionId: transactionId,
      documentHash,
    }, {
      reason: existing?.title || metadata?.title || "生成并写入后的完整版本",
      operations: operation ? [operation] : [],
      source: source || existing?.source || "",
      operationType,
      parentVersionId: requested.find((entry) => entryId(entry) !== id)?.id || "",
    });
    if (!verifyHistoryEntryIntegrity(version).ok) throw new Error(`文档 ${documentId} 的写入历史版本校验失败`);
    nextState.histories[documentId] = [version, ...requested.filter((entry) => entryId(entry) !== id)];
    clearCurrentVersionMetadata(nextState, documentId);
    receipts.push({ documentId, versionId: id, documentHash });
  }
  return receipts;
};

export const verifyCommittedDocumentHistory = async ({ histories = {}, receipts = [] } = {}) => {
  for (const receipt of receipts) {
    const version = entries(histories[receipt.documentId]).find((entry) => entryId(entry) === receipt.versionId);
    if (!version?.document || !verifyHistoryEntryIntegrity(version).ok
      || await documentVersionHash(version.document) !== receipt.documentHash) {
      throw Object.assign(new Error(`文档 ${receipt.documentId} 的新历史版本未与正文同步保存`), { code: "DOCUMENT_COMMITTED_HISTORY_UNVERIFIED" });
    }
  }
};
