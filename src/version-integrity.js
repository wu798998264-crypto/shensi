import { sha256Hex } from "./candidate-provenance.js";

const clean = (value = "") => String(value ?? "").trim();
const clone = (value) => value == null ? value : structuredClone(value);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

export const stableVersionJson = (value) => JSON.stringify(stableValue(value));

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

export const sha256HexSync = (value = "") => {
  const source = new TextEncoder().encode(String(value));
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = BigInt(source.length) * 8n;
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false);
  const hash = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_ROUND[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
};

// Document transactions run on the interactive landing path. Use the local
// deterministic implementation so a queued WebCrypto digest cannot stall an
// otherwise synchronous create/commit transaction.
export const documentVersionHash = async (documentState = {}) => sha256HexSync(stableVersionJson(documentState));

const snapshotPayload = (snapshot = {}) => ({
  schemaVersion: Number(snapshot.schemaVersion) || 1,
  snapshotId: clean(snapshot.snapshotId),
  documentId: clean(snapshot.documentId),
  parentVersionId: clean(snapshot.parentVersionId),
  source: clean(snapshot.source),
  operation: clean(snapshot.operation),
  transactionId: clean(snapshot.transactionId),
  createdAt: clean(snapshot.createdAt),
  documentHash: clean(snapshot.documentHash),
  document: clone(snapshot.document ?? {}),
});

export const createDocumentVersionSnapshot = async ({
  snapshotId = "",
  documentId = "",
  documentState = {},
  parentVersionId = "",
  source = "user",
  operation = "replace",
  transactionId = "",
  createdAt = new Date().toISOString(),
} = {}) => {
  const id = clean(snapshotId) || `snapshot-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;
  const document = clone(documentState ?? {});
  const snapshot = {
    schemaVersion: 1,
    snapshotId: id,
    documentId: clean(documentId),
    parentVersionId: clean(parentVersionId),
    source: clean(source) || "user",
    operation: clean(operation) || "replace",
    transactionId: clean(transactionId),
    createdAt: clean(createdAt),
    documentHash: await documentVersionHash(document),
    document,
  };
  return {
    ...snapshot,
    snapshotHash: await sha256Hex(stableVersionJson(snapshotPayload(snapshot))),
  };
};

export const verifyDocumentVersionSnapshot = async (snapshot = {}) => {
  if (!snapshot || Number(snapshot.schemaVersion) !== 1 || !clean(snapshot.snapshotId) || !clean(snapshot.documentId)) {
    return { ok: false, code: "VERSION_SNAPSHOT_INVALID", reason: "历史版本结构不完整" };
  }
  const documentHash = await documentVersionHash(snapshot.document ?? {});
  if (documentHash !== clean(snapshot.documentHash)) {
    return { ok: false, code: "VERSION_DOCUMENT_HASH_MISMATCH", reason: "历史版本正文与元数据校验失败" };
  }
  const snapshotHash = await sha256Hex(stableVersionJson(snapshotPayload(snapshot)));
  if (snapshotHash !== clean(snapshot.snapshotHash)) {
    return { ok: false, code: "VERSION_SNAPSHOT_HASH_MISMATCH", reason: "历史版本清单校验失败" };
  }
  return { ok: true, documentHash, snapshotHash };
};

const historyPayload = (entry = {}) => {
  if (entry.scopeType === "document") return entry.document
    ? { document: clone(entry.document) }
    : {
        html: String(entry.html ?? ""),
        markdown: String(entry.markdown ?? ""),
        continuityDelta: clone(entry.continuityDelta ?? null),
      };
  if (entry.state) return { state: clone(entry.state) };
  return {
    documents: clone(entry.documents ?? {}),
    moduleItems: clone(entry.moduleItems ?? {}),
    customFolders: clone(entry.customFolders ?? []),
  };
};

export const historyEntrySource = ({ reason = "", source = "" } = {}) => {
  if (clean(source)) return clean(source);
  const text = clean(reason);
  if (/恢复|切换前/u.test(text)) return "restore";
  if (/导入|迁移/u.test(text)) return "import";
  if (/神思|AI|候选|生成|落盘/u.test(text)) return "ai";
  return "user";
};

export const historyEntryOperationType = ({ reason = "", operations = [], operationType = "" } = {}) => {
  if (clean(operationType)) return clean(operationType);
  const types = (Array.isArray(operations) ? operations : []).map((operation) => clean(operation?.type));
  const text = clean(reason);
  if (types.some((type) => /restore/u.test(type)) || /恢复|切换前/u.test(text)) return "restore";
  if (types.some((type) => /append/u.test(type)) || /续写|追加/u.test(text)) return "continuation";
  if (types.some((type) => /replace_text|patch/u.test(type)) || /局部|选中/u.test(text)) return "partial-replace";
  if (types.some((type) => /create/u.test(type)) || /新建|新增/u.test(text)) return "create";
  if (types.some((type) => /history.save/u.test(type)) || /版本保存|手动保存/u.test(text)) return "snapshot";
  if (types.some((type) => /rename/u.test(type)) || /标题|命名/u.test(text)) return "rename";
  return "replace";
};

export const historySourceLabel = (source = "") => ({
  user: "人工编辑",
  ai: "AI 正式内容",
  chat: "Chat 正式内容",
  agent: "Agent 正式内容",
  restore: "版本恢复",
  import: "导入或迁移",
}[clean(source)] || "历史版本");

export const historyOperationLabel = (operationType = "") => ({
  create: "新建",
  replace: "全文替换",
  "partial-replace": "局部替换",
  continuation: "续写落盘",
  restore: "恢复",
  snapshot: "手动保存",
  rename: "标题修改",
}[clean(operationType)] || "内容修改");

export const stampHistoryEntryIntegrity = (entry = {}, {
  reason = "",
  operations = [],
  source = "",
  operationType = "",
  parentVersionId = "",
} = {}) => {
  const next = clone(entry ?? {});
  next.integritySchemaVersion = 1;
  next.name = clean(next.name || next.title || next.version || "历史版本");
  next.note = String(next.note ?? "").trim();
  next.source = historyEntrySource({ reason: reason || next.title, source: source || next.source });
  next.operationType = historyEntryOperationType({
    reason: reason || next.title,
    operations,
    operationType: operationType || next.operationType,
  });
  next.parentVersionId = clean(next.parentVersionId || parentVersionId);
  next.createdAt = clean(next.createdAt) || new Date().toISOString();
  next.contentHash = sha256HexSync(stableVersionJson(historyPayload(next)));
  next.integrityHash = sha256HexSync(stableVersionJson({
    integritySchemaVersion: next.integritySchemaVersion,
    scopeType: clean(next.scopeType),
    scopeId: clean(next.scopeId),
    contentHash: next.contentHash,
  }));
  next.verified = true;
  return next;
};

export const verifyHistoryEntryIntegrity = (entry = {}) => {
  if (Number(entry.integritySchemaVersion) !== 1 || !clean(entry.contentHash) || !clean(entry.integrityHash)) {
    return { ok: false, code: "HISTORY_INTEGRITY_MISSING", reason: "历史版本尚未建立独立校验" };
  }
  const contentHash = sha256HexSync(stableVersionJson(historyPayload(entry)));
  if (contentHash !== clean(entry.contentHash)) {
    return { ok: false, code: "HISTORY_CONTENT_HASH_MISMATCH", reason: "历史版本内容校验失败" };
  }
  const integrityHash = sha256HexSync(stableVersionJson({
    integritySchemaVersion: 1,
    scopeType: clean(entry.scopeType),
    scopeId: clean(entry.scopeId),
    contentHash,
  }));
  if (integrityHash !== clean(entry.integrityHash)) {
    return { ok: false, code: "HISTORY_MANIFEST_HASH_MISMATCH", reason: "历史版本清单校验失败" };
  }
  return { ok: true, contentHash, integrityHash };
};

// Migrate legacy entries once, but never recompute a hash for an entry that
// already claims to be integrity-protected. A damaged stored entry must stay
// visibly invalid until the user replaces it with a new snapshot.
export const normalizeHistoryEntryIntegrity = (entry = {}) => {
  if (Number(entry?.integritySchemaVersion) !== 1 || !clean(entry?.contentHash) || !clean(entry?.integrityHash)) {
    return stampHistoryEntryIntegrity(entry);
  }
  return { ...clone(entry), verified: verifyHistoryEntryIntegrity(entry).ok };
};

// Workspace hydration is not a trust boundary. Persisted history entries are
// verified again immediately before restore or metadata mutation, so
// synchronously cloning and hashing every historical payload during startup
// only blocks the renderer without making those later operations safer.
// Legacy entries still receive their first integrity manifest here.
export const hydrateHistoryEntryIntegrity = (entry = {}) => {
  if (Number(entry?.integritySchemaVersion) !== 1 || !clean(entry?.contentHash) || !clean(entry?.integrityHash)) {
    return stampHistoryEntryIntegrity(entry);
  }
  return { ...entry };
};

export const updateHistoryEntryMetadata = (entry = null, patch = {}) => {
  if (!entry || typeof entry !== "object") throw new Error("历史版本不存在");
  if (entry.sourceHistoryReadOnly) throw new Error("只读历史版本不能重命名或修改备注");
  const before = verifyHistoryEntryIntegrity(entry);
  if (!before.ok || entry.verified === false) throw new Error(before.reason || "历史版本完整性校验失败");
  const next = clone(entry);
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    const name = clean(patch.name).slice(0, 100);
    if (!name) throw new Error("历史版本名称不能为空");
    next.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "note")) next.note = String(patch.note ?? "").trim().slice(0, 1000);
  const after = verifyHistoryEntryIntegrity(next);
  if (!after.ok || after.contentHash !== before.contentHash || after.integrityHash !== before.integrityHash) {
    throw new Error(after.reason || "修改版本名称时历史正文校验发生变化");
  }
  return next;
};
