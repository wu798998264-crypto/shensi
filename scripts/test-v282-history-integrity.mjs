import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createDocumentVersionSnapshot,
  normalizeHistoryEntryIntegrity,
  sha256HexSync,
  stampHistoryEntryIntegrity,
  updateHistoryEntryMetadata,
  verifyDocumentVersionSnapshot,
  verifyHistoryEntryIntegrity,
} from "../src/version-integrity.js";

assert.equal(sha256HexSync("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

const version = await createDocumentVersionSnapshot({
  documentId: "chapter-2",
  documentState: { title: "第2章", html: "<p>完整正文。</p>", customMetadata: { pov: "林夏" } },
  source: "agent",
  operation: "continuation",
});
assert.equal((await verifyDocumentVersionSnapshot(version)).ok, true);

const damaged = structuredClone(version);
damaged.document.html = "<p>被篡改。</p>";
assert.equal((await verifyDocumentVersionSnapshot(damaged)).ok, false);

const history = stampHistoryEntryIntegrity({
  id: "v1",
  title: "续写落盘",
  scopeType: "document",
  scopeId: "chapter-2",
  document: { title: "第2章", html: "<p>完整正文。</p>", metadata: { pov: "林夏" } },
}, { reason: "续写当前章节", parentVersionId: "v0" });
assert.equal(history.name, "续写落盘");
assert.equal(history.operationType, "continuation");
assert.equal((verifyHistoryEntryIntegrity(history)).ok, true);
const renamedHistory = updateHistoryEntryMetadata(history, {
  name: "第二章定稿",
  note: "作者确认过节奏",
});
assert.equal(renamedHistory.name, "第二章定稿");
assert.equal(renamedHistory.note, "作者确认过节奏");
assert.equal(renamedHistory.contentHash, history.contentHash, "重命名不得改变正文哈希");
assert.equal(renamedHistory.integrityHash, history.integrityHash, "重命名不得改变完整性清单");
assert.equal(renamedHistory.createdAt, history.createdAt, "重命名不得改变版本时间");
assert.equal(renamedHistory.parentVersionId, history.parentVersionId, "重命名不得改变版本链");
assert.equal((verifyHistoryEntryIntegrity(renamedHistory)).ok, true, "版本名称和备注不应改变正文校验");
assert.throws(() => updateHistoryEntryMetadata({ ...history, sourceHistoryReadOnly: true }, { name: "禁止修改" }), /只读/u);
const damagedHistory = structuredClone(renamedHistory);
damagedHistory.document.html = "<p>损坏正文。</p>";
assert.equal((verifyHistoryEntryIntegrity(damagedHistory)).ok, false);
const normalizedDamaged = normalizeHistoryEntryIntegrity(damagedHistory);
assert.equal(normalizedDamaged.verified, false, "已有校验值的损坏版本不得通过重新计算哈希变为正常");
assert.equal(normalizedDamaged.contentHash, damagedHistory.contentHash, "加载损坏版本时不得覆盖原校验值");

const migratedLegacy = normalizeHistoryEntryIntegrity({
  id: "legacy-v1",
  title: "旧版本",
  scopeType: "document",
  scopeId: "chapter-2",
  html: "<p>旧正文。</p>",
});
assert.equal(migratedLegacy.verified, true);
assert.equal(verifyHistoryEntryIntegrity(migratedLegacy).ok, true);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /data-history-version-name=/u, "历史列表必须提供版本命名入口");
assert.match(appSource, /data-history-version-note=/u, "历史列表必须提供版本备注入口");
assert.match(appSource, /await updateHistoryVersionMetadata\(action\.scope, action\.versionId, \{ name: value \}\)/u, "版本重命名必须等待磁盘事务完成");
assert.match(appSource, /previousVersion[\s\S]{0,900}历史版本\$\{metadataKind\}保存失败/u, "版本重命名磁盘失败时必须恢复旧元数据");
assert.match(appSource, /verifyHistoryEntryIntegrity\(version\)/u, "恢复前必须校验目标版本");
assert.doesNotMatch(appSource, /const currentHistoryEntry|preservedCurrent:\s*currentHistoryEntry/u, "恢复流程不得再创建写入前可见备份");
assert.match(appSource, /恢复结果已创建为新版本/u, "恢复结果必须作为新的最新版本保存");

console.log("Shensi v2.82 history integrity baseline tests passed");
