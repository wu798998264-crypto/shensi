import assert from "node:assert/strict";

import {
  MAX_DOCUMENT_TABS,
  activateDocumentTab,
  closeDocumentTab,
  normalizeDocumentTabState,
  openBlankDocumentTab,
  openDocumentInTabs,
  removeDocumentFromTabs,
  reorderDocumentTabs,
  updateDocumentViewState,
} from "../src/document-tabs.js";

const documents = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`doc-${index + 1}`, { title: `文档 ${index + 1}` }]));
let sequence = 0;
const createId = () => `tab-${++sequence}`;

let state = normalizeDocumentTabState({ documents, activeDocument: "doc-1", createId });
assert.equal(state.documentTabs.length, 1);
assert.equal(state.activeDocument, "doc-1");

state = openDocumentInTabs({ ...state, documents, createId }, "doc-2");
assert.equal(state.documentTabs.length, 1, "普通目录点击必须替换当前标签");
assert.equal(state.activeDocument, "doc-2");

state = openBlankDocumentTab({ ...state, documents, createId });
assert.equal(state.documentTabs.length, 2);
assert.equal(state.activeDocument, "", "新标签页不得继承上一文档");
state = openDocumentInTabs({ ...state, documents, createId }, "doc-3");
assert.deepEqual(state.documentTabs.map((tab) => tab.documentId), ["doc-2", "doc-3"]);

state = openDocumentInTabs({ ...state, documents, createId }, "doc-2");
assert.equal(state.documentTabs.length, 2, "已打开文档不得重复创建标签");
assert.equal(state.activeDocument, "doc-2");

state = activateDocumentTab({ ...state, documents, createId }, state.documentTabs[1].id);
assert.equal(state.activeDocument, "doc-3");
const doc3TabId = state.activeDocumentTabId;
const doc2TabId = state.documentTabs.find((tab) => tab.documentId === "doc-2").id;
state = reorderDocumentTabs({ ...state, documents, createId }, doc3TabId, doc2TabId, "before");
assert.deepEqual(state.documentTabs.map((tab) => tab.documentId), ["doc-3", "doc-2"], "标签必须能够向左拖动重排");
assert.equal(state.activeDocumentTabId, doc3TabId, "拖动标签不得改变活动标签");
assert.equal(state.activeDocument, "doc-3", "拖动标签不得改变当前文档");
const unchangedOrder = reorderDocumentTabs({ ...state, documents, createId }, doc3TabId, doc2TabId, "before");
assert.equal(unchangedOrder.changed, false, "已经位于目标位置时不得产生无意义状态变更");
state = closeDocumentTab({ ...state, documents, createId }, state.activeDocumentTabId);
assert.equal(state.activeDocument, "doc-2", "关闭当前标签后必须激活相邻标签");

state = closeDocumentTab({ ...state, documents, createId }, state.activeDocumentTabId);
assert.equal(state.documentTabs.length, 1);
assert.equal(state.activeDocument, "", "关闭最后标签后必须保留空白标签");

for (let index = 1; index <= MAX_DOCUMENT_TABS; index += 1) {
  if (state.activeDocument === "") state = openDocumentInTabs({ ...state, documents, createId }, `doc-${index}`);
  if (index < MAX_DOCUMENT_TABS) state = openBlankDocumentTab({ ...state, documents, createId });
}
assert.equal(state.documentTabs.length, MAX_DOCUMENT_TABS);
const finalTabId = state.documentTabs.at(-1).id;
const firstTabId = state.documentTabs[0].id;
const reorderedAtLimit = reorderDocumentTabs({ ...state, documents, createId }, firstTabId, finalTabId, "after");
assert.equal(reorderedAtLimit.documentTabs.at(-1).id, firstTabId, "满八个标签时仍须允许向右拖动重排");
assert.equal(reorderedAtLimit.activeDocumentTabId, state.activeDocumentTabId, "重排不得改变活动标签 ID");
const limited = openBlankDocumentTab({ ...state, documents, createId });
assert.equal(limited.limitReached, true);
assert.equal(limited.documentTabs.length, MAX_DOCUMENT_TABS);

const removed = removeDocumentFromTabs({ ...state, documents, createId }, "doc-4");
assert.equal(removed.documentTabs.some((tab) => tab.documentId === "doc-4"), false);
const deletedDocuments = { ...documents };
delete deletedDocuments["doc-3"];
const deletionBase = normalizeDocumentTabState({ documents, activeDocument: "doc-2", createId });
const deletionWithBlank = openBlankDocumentTab({ ...deletionBase, documents, createId });
const deletionWithSecond = openDocumentInTabs({ ...deletionWithBlank, documents, createId }, "doc-3");
const removedActive = removeDocumentFromTabs({
  ...deletionWithSecond,
  documents: deletedDocuments,
  activeDocument: "doc-3",
  activeDocumentTabId: deletionWithSecond.documentTabs.find((tab) => tab.documentId === "doc-3")?.id,
}, "doc-3");
assert.equal(removedActive.documentTabs.some((tab) => tab.documentId === "doc-3"), false, "删除后不得保留指向已删除文档的标签");
assert.equal(removedActive.activeDocument, "doc-2", "删除活动标签后必须激活相邻文档");

const viewStates = updateDocumentViewState({}, "doc-1", { mode: "read", scrollTop: 321 });
assert.deepEqual(viewStates["doc-1"], { mode: "read", scrollTop: 321 });
const normalized = normalizeDocumentTabState({
  documents,
  documentTabs: [{ id: "a", documentId: "doc-1" }, { id: "b", documentId: "doc-1" }, { id: "c", documentId: "missing" }],
  activeDocumentTabId: "a",
  activeDocument: "doc-1",
  documentViewStates: { "doc-1": viewStates["doc-1"], missing: { mode: "read", scrollTop: 2 } },
  createId,
});
assert.deepEqual(normalized.documentTabs.map((tab) => tab.documentId), ["doc-1"], "重复或已删除文档标签必须清理");
assert.deepEqual(Object.keys(normalized.documentViewStates), ["doc-1"]);

console.log("document tab state contracts passed");
