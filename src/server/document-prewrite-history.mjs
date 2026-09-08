import { randomUUID } from "node:crypto";
import { documentVersionHash, stampHistoryEntryIntegrity, verifyHistoryEntryIntegrity } from "../version-integrity.js";

const entryId = (entry) => String(entry?.id || entry?.versionId || "");
const entries = (value) => Array.isArray(value) ? value : [];

// The workspace lock owns this call. It does not choose a write operation or
// change its semantics; it adds a complete, restorable before-image only.
export const prepareFullPrewriteHistory = async ({ currentState, nextState, changedDocumentIds = [], transactionId }) => {
  if (!currentState) return [];
  nextState.histories ??= {};
  const receipts = [];
  for (const [id, previousEntries] of Object.entries(currentState.histories || {})) {
    const requested = entries(nextState.histories[id]);
    const known = new Set(requested.map(entryId));
    // A renderer can still hold the pre-save history list. Do not let its
    // next autosave erase a server-created mandatory before-image.
    nextState.histories[id] = [...entries(previousEntries).filter((entry) => entry.fullPrewriteSnapshot === true && !known.has(entryId(entry))), ...requested];
  }
  for (const id of new Set(changedDocumentIds)) {
    const before = currentState.documents?.[id];
    if (!before || before.kind === "canvas" || before.documentKind === "whiteboard") continue;
    const documentHash = await documentVersionHash(before);
    const previousIds = new Set(entries(currentState.histories?.[id]).map(entryId));
    const requested = entries(nextState.histories[id]);
    let existing = null;
    for (const candidate of requested) {
      if (!previousIds.has(entryId(candidate)) && candidate.document
        && await documentVersionHash(candidate.document) === documentHash) {
        existing = candidate;
        break;
      }
    }
    const idForVersion = entryId(existing) || `version-${randomUUID()}`;
    const createdAt = existing?.createdAt || new Date().toISOString();
    const version = stampHistoryEntryIntegrity({
      ...existing,
      id: idForVersion,
      versionId: idForVersion,
      resourceId: id,
      scopeType: "document",
      scopeId: id,
      version: existing?.version || `v${requested.length + 1}`,
      title: existing?.title || `${before.title || id} · 修改前完整版本`,
      time: existing?.time || createdAt,
      createdAt,
      document: structuredClone(before),
      html: String(before.html ?? ""),
      markdown: String(before.markdown ?? before.text ?? ""),
      fullPrewriteSnapshot: true,
      prewriteTransactionId: transactionId,
      documentHash,
    }, { source: existing?.source || "user", operationType: existing?.operationType || "snapshot" });
    if (!verifyHistoryEntryIntegrity(version).ok) throw new Error(`文档 ${id} 的完整历史快照校验失败`);
    nextState.histories[id] = [version, ...requested.filter((entry) => entryId(entry) !== idForVersion)];
    receipts.push({ documentId: id, versionId: idForVersion, documentHash });
  }
  return receipts;
};

export const verifyFullPrewriteHistory = async ({ histories = {}, receipts = [] }) => {
  for (const receipt of receipts) {
    const version = entries(histories[receipt.documentId]).find((entry) => entryId(entry) === receipt.versionId);
    if (!version?.document || !verifyHistoryEntryIntegrity(version).ok
      || await documentVersionHash(version.document) !== receipt.documentHash) {
      throw Object.assign(new Error(`文档 ${receipt.documentId} 的完整历史版本未成功保存，已阻止修改`), { code: "DOCUMENT_PREWRITE_HISTORY_UNVERIFIED" });
    }
  }
};
