import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createBlankProjectState } from "../src/data.js";
import { memoryStoreFromLegacyDocuments } from "../src/structured-memory-store.js";
import {
  ensureRuntimeMemoryDocuments,
  memoryProjectionDocumentIds,
} from "../src/runtime-memory-documents.js";
import { STRUCTURE_WORKSPACE_VERSION } from "../src/structure-schema.js";

const fresh = createBlankProjectState({ name: "记忆合并测试", workspacePath: "C:/memory-consolidation-test" });
assert.ok(fresh.documents["memory-information-ledger"], "新小说作品必须自带信息账本");
assert.ok(fresh.documents["script-memory-information-ledger"], "新剧本视图必须自带信息账本");
for (const legacyId of ["memory-first-appearance", "memory-release", "memory-reader"]) {
  const item = fresh.moduleItems.memory.find(([documentId]) => documentId === legacyId);
  assert.equal(item?.[2]?.hiddenFromDirectory, true, `${legacyId} 应保留兼容 ID 但从目录隐藏`);
  assert.ok(fresh.documents[legacyId], `${legacyId} 兼容数据不得删除`);
}

const legacyState = {
  workspaceKind: "project",
  structureLanguage: "zh-CN",
  documents: {
    "memory-first-appearance": { title: "重要信息登场账本", html: "<h1>重要信息登场账本</h1><h2>[INFO:old-port] 旧港</h2><p>内容：旧港位于北岸。</p>" },
    "memory-release": { title: "信息释放表", html: "<h1>信息释放表</h1><h2>[INFO:old-port] 旧港</h2><p>章节：第一章</p><p>内容：读者已知旧港位于北岸。</p>" },
    "memory-reader": { title: "读者当前知识库", html: "<h1>读者当前知识库</h1><h2>[INFO:old-port] 旧港</h2><p>当前状态：已公开</p>" },
  },
  moduleItems: { memory: [
    ["memory-first-appearance", "重要信息登场账本"],
    ["memory-release", "信息释放表"],
    ["memory-reader", "读者当前知识库"],
  ] },
  histories: {},
};
const created = ensureRuntimeMemoryDocuments({
  state: legacyState,
  documentIds: memoryProjectionDocumentIds({ script: false }),
});
assert.ok(created.includes("memory-information-ledger"), "旧作品加载时必须补建信息账本");
for (const legacyId of ["memory-first-appearance", "memory-release", "memory-reader"]) {
  const item = legacyState.moduleItems.memory.find(([documentId]) => documentId === legacyId);
  assert.equal(item?.[2]?.hiddenFromDirectory, true, "补建信息账本后旧投影应从目录隐藏");
}

const migrated = memoryStoreFromLegacyDocuments({ documents: legacyState.documents });
const migratedInfo = Object.values(migrated.informationEntities);
assert.ok(migratedInfo.some((entry) => entry.name === "旧港"), "旧 HTML 标题必须被迁移解析器保留");
assert.ok(migratedInfo.some((entry) => String(entry.detail || "").includes("旧港位于北岸")), "旧信息正文不得在合并迁移时消失");
assert.ok(STRUCTURE_WORKSPACE_VERSION >= 8, "结构版本必须触发旧作品补齐合并后的记忆结构");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const updateStart = appSource.indexOf("const applyCandidateMemoryUpdate =");
const updateEnd = appSource.indexOf("const applyCandidateMemoryUpdates", updateStart);
const updateSource = appSource.slice(updateStart, updateEnd);
assert.match(updateSource, /memoryProjectionDocumentIds\(\{ script: scriptDomain \}\)/u,
  "普通记忆更新必须使用包含信息账本的新投影清单");
assert.match(updateSource, /for \(const documentId of ids\)/u,
  "普通记忆更新必须实际逐一刷新所有新旧兼容投影");

console.log("Memory consolidation, legacy visibility and HTML migration contracts passed");
