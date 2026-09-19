import { randomUUID } from "node:crypto";

import { documentVersionHash, stampHistoryEntryIntegrity, verifyHistoryEntryIntegrity } from "../version-integrity.js";
import { sameDocumentHistoryContent } from "../history-scope.js";

const entryId = (entry) => String(entry?.id || entry?.versionId || "");
const entries = (value) => Array.isArray(value) ? value : [];
const clone = (value) => value == null ? value : structuredClone(value);

const operationForDocument = (operations, documentId) => entries(operations).find((operation) => (
  String(operation?.targetDocumentId || operation?.documentId || "") === documentId
)) || null;

const operationChangeSet = (state, operation) => {
  const operationId = String(operation?.operationId || "");
  const recorded = operationId ? state?.documentTransactionLog?.[operationId]?.changeSet : null;
  if (Array.isArray(recorded)) return clone(recorded);
  return Array.isArray(operation?.changeSet) ? clone(operation.changeSet) : [];
};

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

const persistedComparableDocument = (value = {}) => {
  const source = value?.document && typeof value.document === "object" ? value.document : value;
  const document = historyDocument(source || {});
  if (typeof document?.html === "string") {
    // Markdown persistence rebuilds HTML and intentionally drops empty block
    // artifacts such as <p></p>. They are not a user-visible formatting
    // change and must not manufacture an extra pre-overwrite version.
    document.html = document.html.replace(/<p>(?:\s|&nbsp;|&#160;|<br\s*\/?\s*>)*<\/p>/giu, "");
  }
  return document;
};

const sameCommittedDocumentContent = (left, right) => sameDocumentHistoryContent(
  persistedComparableDocument(left),
  persistedComparableDocument(right),
);

const normalizedVisibleText = (value = "") => String(value || "")
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/^\s*#{1,6}\s+/u, "")
  .replace(/\s+/gu, " ")
  .trim();

const meaningfulDocumentBody = (documentState = {}) => {
  const document = documentState && typeof documentState === "object" ? documentState : {};
  const body = normalizedVisibleText(document.markdown ?? document.text ?? document.html ?? "");
  if (!body) return "";
  if (document.placeholder === true || document.emptyPlaceholder === true) return "";
  const title = normalizedVisibleText(document.title ?? "");
  return title && body === title ? "" : body;
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
    let requested = entries(nextState.histories[documentId]);
    const previousDocument = currentState.documents?.[documentId];
    const previousSnapshot = previousDocument ? historyDocument(previousDocument) : null;
    const agentWrite = source === "agent" || source === "chat";
    const previousBody = meaningfulDocumentBody(previousSnapshot);
    const previousNeedsSnapshot = agentWrite
      && previousSnapshot
      // The very first AI write into an empty/title-only landing slot creates
      // only the committed post-write version. A pre-write safeguard exists
      // solely to preserve meaningful edits that would otherwise be lost.
      && previousBody
      && !sameCommittedDocumentContent(previousSnapshot, committedSnapshot)
      && !requested.some((candidate) => candidate?.document
        && verifyHistoryEntryIntegrity(candidate).ok
        && sameCommittedDocumentContent(candidate, previousSnapshot));
    if (previousNeedsSnapshot) {
      const createdAt = new Date().toISOString();
      const id = `version-${randomUUID()}`;
      const previousHash = await documentVersionHash(previousSnapshot);
      const safeguard = stampHistoryEntryIntegrity({
        id,
        versionId: id,
        resourceId: documentId,
        scopeType: "document",
        scopeId: documentId,
        version: `v${requested.length + 1}`,
        title: `${previousSnapshot.title || documentId} · AI 覆盖前自动备份`,
        time: createdAt,
        createdAt,
        document: previousSnapshot,
        html: String(previousSnapshot.html ?? ""),
        markdown: String(previousSnapshot.markdown ?? previousSnapshot.text ?? ""),
        content: String(previousSnapshot.markdown ?? previousSnapshot.text ?? previousSnapshot.html ?? ""),
        operation: "snapshot",
        changeSet: [],
        preOverwriteSnapshot: true,
        writeTransactionId: transactionId,
        documentHash: previousHash,
      }, {
        reason: "AI 正式写入前保存当前完整文档",
        source: "user",
        operationType: "snapshot",
        parentVersionId: entryId(requested[0]),
      });
      if (!verifyHistoryEntryIntegrity(safeguard).ok) throw new Error(`文档 ${documentId} 的覆盖前历史版本校验失败`);
      requested = [safeguard, ...requested];
      nextState.histories[documentId] = requested;
    }
    const metadata = currentVersionMetadata(nextState, documentId);
    const reusableIndex = requested.findIndex((candidate) => previousIds.has(entryId(candidate))
      && candidate?.document
      && verifyHistoryEntryIntegrity(candidate).ok
      && sameCommittedDocumentContent(candidate, committedSnapshot));
    if (reusableIndex >= 0) {
      const reusable = requested[reusableIndex];
      const previousLatest = requested.find((candidate, index) => index !== reusableIndex && previousIds.has(entryId(candidate))) ?? null;
      if (reusableIndex > 0) {
        reusable.lastActivatedAt = new Date().toISOString();
        reusable.time = metadata?.time || reusable.lastActivatedAt;
        reusable.latestComparisonVersionId = entryId(previousLatest);
      }
      const pendingDuplicateIds = new Set(requested
        .filter((candidate) => !previousIds.has(entryId(candidate))
          && sameCommittedDocumentContent(candidate, committedSnapshot))
        .map(entryId));
      nextState.histories[documentId] = [
        reusable,
        ...requested.filter((candidate, index) => index !== reusableIndex && !pendingDuplicateIds.has(entryId(candidate))),
      ];
      clearCurrentVersionMetadata(nextState, documentId);
      receipts.push({
        documentId,
        versionId: entryId(reusable),
        documentHash: await documentVersionHash(reusable.document),
        reusedHistoryVersion: true,
      });
      continue;
    }
    let existing = null;
    for (const candidate of requested) {
      if (previousIds.has(entryId(candidate)) || !candidate.document) continue;
      if (await documentVersionHash(candidate.document) === documentHash
        || sameCommittedDocumentContent(candidate, committedSnapshot)) {
        existing = candidate;
        break;
      }
    }
    const operation = operationForDocument(operations, documentId);
    const operationType = String(operation?.type || operation?.operation || existing?.operation || "replace");
    const changeSet = Array.isArray(existing?.changeSet) ? clone(existing.changeSet) : operationChangeSet(nextState, operation);
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
      changeSet,
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
