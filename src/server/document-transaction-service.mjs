import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const manifestEntries = (value) => value?.manifest && typeof value.manifest === "object" ? value.manifest : {};
const entryPath = (entry) => typeof entry === "string" ? entry : String(entry?.path || "");
const entryHash = (entry) => typeof entry === "string" ? "" : String(entry?.hash || "");
const formalCharacterCount = (document = {}) => String(document.markdown || document.text || document.html || "").length;

const fullTextImportContract = (value) => {
  if (value?.kind !== "full_text_import_v1") return null;
  const batchId = String(value.batchId || "");
  const sourceSha256 = String(value.sourceSha256 || "").toLowerCase();
  const documents = Array.isArray(value.documents) ? value.documents.slice(0, 2_001).map((document) => ({
    id: String(document?.id || ""),
    title: String(document?.title || ""),
    sequenceNumber: Math.max(0, Number(document?.sequenceNumber) || 0),
    importOrder: Math.max(0, Number(document?.importOrder) || 0),
  })) : [];
  if (!/^fulltext-[a-f0-9]{32}$/u.test(batchId)
    || !/^[a-f0-9]{64}$/u.test(sourceSha256)
    || documents.length < 2
    || documents.length > 2_000
    || documents.some((document) => !document.id || !document.title || !document.importOrder)
    || new Set(documents.map((document) => document.id)).size !== documents.length) {
    const error = new Error("全文导入落盘验收合同无效");
    error.code = "FULL_TEXT_IMPORT_VERIFICATION_CONTRACT_INVALID";
    throw error;
  }
  return { batchId, sourceSha256, documents };
};

const verifyFullTextImportCommit = async ({ workspaceRoot, transactionId, manifest, desiredState, contract, committedAt }) => {
  if (!contract) return null;
  const batch = desiredState.fullTextImports?.[contract.batchId];
  if (!batch || batch.sourceSha256 !== contract.sourceSha256 || batch.status !== "committed") {
    throw Object.assign(new Error("全文导入批次元数据未随工作区事务提交"), { code: "FULL_TEXT_IMPORT_BATCH_METADATA_MISSING" });
  }
  const expectedIds = contract.documents.map((document) => document.id);
  if (Number(batch.chapterCount) !== expectedIds.length
    || JSON.stringify(batch.targetDocumentIds || []) !== JSON.stringify(expectedIds)) {
    throw Object.assign(new Error("全文导入批次的章节数量或顺序不一致"), { code: "FULL_TEXT_IMPORT_ORDER_MISMATCH" });
  }
  const manuscriptOrder = (desiredState.moduleItems?.manuscript || [])
    .map((item) => String(item?.[0] || ""))
    .filter((id) => expectedIds.includes(id));
  if (JSON.stringify(manuscriptOrder) !== JSON.stringify(expectedIds)) {
    throw Object.assign(new Error("全文导入正文目录顺序与解析顺序不一致"), { code: "FULL_TEXT_IMPORT_ORDER_MISMATCH" });
  }
  const paths = new Set();
  const results = [];
  for (let offset = 0; offset < contract.documents.length; offset += 32) {
    const verified = await Promise.all(contract.documents.slice(offset, offset + 32).map(async (expected, index) => {
      const document = desiredState.documents?.[expected.id];
      const manifestEntry = manifest?.[expected.id];
      const relativePath = entryPath(manifestEntry);
      if (!document || document.title !== expected.title
        || Number(document.sequenceNumber || 0) !== expected.sequenceNumber
        || Number(document.fullTextImportOrder || 0) !== expected.importOrder
        || document.fullTextImportId !== contract.batchId
        || document.fullTextSourceSha256 !== contract.sourceSha256) {
        throw Object.assign(new Error(`全文导入文档元数据不一致：${expected.id}`), { code: "FULL_TEXT_IMPORT_DOCUMENT_METADATA_MISMATCH" });
      }
      if (!Array.isArray(desiredState.histories?.[expected.id]) || !desiredState.histories[expected.id].length) {
        throw Object.assign(new Error(`全文导入文档缺少初始历史版本：${expected.id}`), { code: "FULL_TEXT_IMPORT_INITIAL_HISTORY_MISSING" });
      }
      if (!relativePath || paths.has(relativePath)) {
        throw Object.assign(new Error(`全文导入文档路径缺失或重复：${expected.id}`), { code: "FULL_TEXT_IMPORT_PATH_MISMATCH" });
      }
      paths.add(relativePath);
      const targetPath = resolve(workspaceRoot, relativePath);
      if (!inside(workspaceRoot, targetPath)) throw new Error(`全文导入落盘路径越界：${expected.id}`);
      const verifiedHash = sha256(await readFile(targetPath));
      const writtenHash = entryHash(manifestEntry);
      if (!writtenHash || verifiedHash !== writtenHash) {
        throw Object.assign(new Error(`全文导入磁盘哈希复核失败：${expected.id}`), { code: "FULL_TEXT_IMPORT_HASH_MISMATCH" });
      }
      return {
        schemaVersion: 1,
        type: "shensi_full_text_import_receipt",
        transactionId: String(transactionId || ""),
        operationId: `fulltext-${String(offset + index + 1).padStart(4, "0")}-${randomUUID()}`,
        targetDocumentId: expected.id,
        targetPath,
        relativePath,
        title: expected.title,
        sequenceNumber: expected.sequenceNumber,
        importOrder: expected.importOrder,
        writtenHash,
        verifiedHash,
        charactersWritten: formalCharacterCount(document),
        committedAt,
        verified: true,
      };
    }));
    results.push(...verified);
  }
  return {
    kind: "full_text_import_v1",
    batchId: contract.batchId,
    sourceSha256: contract.sourceSha256,
    chapterCount: results.length,
    titleVerified: true,
    orderVerified: true,
    pathVerified: true,
    historyVerified: true,
    hashVerified: true,
    verified: results.length === contract.documents.length && results.every((result) => result.verified),
    results,
  };
};

export const verifyCommittedWorkspaceDocuments = async ({
  workspaceRoot,
  transactionId,
  manifest,
  previousManifest = null,
  desiredState = {},
  dirtyDocumentIds = null,
  operationDocumentIds = null,
  operationVerification = null,
  committedAt = new Date().toISOString(),
} = {}) => {
  const root = resolve(workspaceRoot);
  const before = manifestEntries(previousManifest);
  const selected = Array.isArray(operationDocumentIds) && operationDocumentIds.length
    ? new Set(operationDocumentIds.map(String))
    : dirtyDocumentIds instanceof Set
      ? new Set([...dirtyDocumentIds].map(String))
      : null;
  const results = [];
  const candidates = Object.entries(manifest || {}).filter(([documentId, entry]) => {
    const previous = before[documentId];
    const changed = !previous || entryHash(previous) !== entryHash(entry) || entryPath(previous) !== entryPath(entry);
    return selected ? selected.has(documentId) : changed;
  });
  // Verification happens after the atomic write and is read-only. Bounded
  // parallelism removes hundreds of serial Windows disk round trips without
  // creating an unbounded number of file handles for very large workspaces.
  const verificationConcurrency = 32;
  for (let offset = 0; offset < candidates.length; offset += verificationConcurrency) {
    const batch = candidates.slice(offset, offset + verificationConcurrency);
    const verified = await Promise.all(batch.map(async ([documentId, entry], batchIndex) => {
      const previous = before[documentId];
      const targetPath = resolve(root, entryPath(entry));
      if (!inside(root, targetPath)) throw new Error(`落盘复核路径越界：${documentId}`);
      const bytes = await readFile(targetPath);
      const verifiedHash = sha256(bytes);
      const writtenHash = entryHash(entry);
      if (!writtenHash || verifiedHash !== writtenHash) {
        const error = new Error(`落盘复核失败：${documentId} 的磁盘哈希与 manifest 不一致`);
        error.code = "DOCUMENT_TRANSACTION_VERIFICATION_FAILED";
        throw error;
      }
      const previousHash = entryHash(previous);
      const operation = !previous ? "create"
        : entryPath(previous) !== entryPath(entry) ? "rename"
          : previousHash === writtenHash ? "verify" : "replace";
      return {
        schemaVersion: 1,
        type: "shensi_landing_receipt",
        transactionId: String(transactionId || ""),
        operationId: `op-${String(offset + batchIndex + 1).padStart(4, "0")}-${randomUUID()}`,
        targetDocumentId: documentId,
        targetPath,
        operation,
        ...(previousHash ? { previousHash } : {}),
        writtenHash,
        verifiedHash,
        charactersWritten: formalCharacterCount(desiredState.documents?.[documentId]),
        committedAt,
        verified: true,
      };
    }));
    results.push(...verified);
  }
  const fullTextVerification = await verifyFullTextImportCommit({
    workspaceRoot: root,
    transactionId,
    manifest,
    desiredState,
    contract: fullTextImportContract(operationVerification),
    committedAt,
  });
  const receiptResults = fullTextVerification?.results || results;
  return {
    schemaVersion: 1,
    type: "shensi_batch_landing_receipt",
    batchId: String(transactionId || `tx-${randomUUID()}`),
    status: "completed",
    succeeded: receiptResults.length,
    failed: 0,
    results: receiptResults,
    ...(fullTextVerification ? { operationVerification: fullTextVerification } : {}),
    committedAt,
    verified: receiptResults.every((receipt) => receipt.writtenHash === receipt.verifiedHash)
      && (!fullTextVerification || fullTextVerification.verified === true),
  };
};
