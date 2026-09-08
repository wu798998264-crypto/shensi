import assert from "node:assert/strict";
import { ensureRuntimeMemoryDocuments } from "../src/runtime-memory-documents.js";

const state = { workspaceKind: "project", structureLanguage: "zh-CN", documents: {}, moduleItems: { memory: [] }, histories: {} };
const created = ensureRuntimeMemoryDocuments({
  state,
  documentIds: ["memory-reader", "memory-snapshot", "outline-series"],
  updatedAt: "现在",
});
assert.deepEqual(created, ["memory-reader", "memory-snapshot"]);
assert.equal(state.documents["memory-reader"].moduleId, "memory");
assert.equal(state.documents["memory-snapshot"].treeGroup, "state-snapshot");
assert.equal(state.documents["outline-series"], undefined, "正式大纲不得由记忆同步创建");

assert.deepEqual(ensureRuntimeMemoryDocuments({ state, documentIds: ["memory-reader"] }), [], "重复同步不得重复创建");
assert.equal(state.moduleItems.memory.filter(([id]) => id === "memory-reader").length, 1);

console.log("v219 runtime memory document tests passed");

