import assert from "node:assert/strict";
import {
  captureMaterialUpdateMemoryRollback,
  restoreMaterialUpdateMemoryRollback,
} from "../src/material-update-memory-transaction.js";

const state = {
  memoryStore: { entities: [{ id: "before" }] },
  documents: {
    "chapter-8": {
      title: "第八章",
      html: "<p>落盘正文</p>",
      continuityDelta: { summary: "旧摘要" },
      memorySyncStatus: "pending",
    },
    "memory-snapshot": { title: "状态快照", html: "<p>旧状态</p>" },
    "report-compile": { title: "项目总览", html: "<p>旧总览</p>" },
    "index-update-log": { title: "更新记录", html: "<p>旧记录</p>" },
  },
  histories: {
    "chapter-8": [{ id: "chapter-history-before" }],
    "memory-snapshot": [{ id: "memory-history-before" }],
    "report-compile": [{ id: "report-history-before" }],
  },
  moduleItems: {
    memory: [["memory-snapshot", "状态快照", {}]],
    reports: [["report-compile", "项目总览", {}]],
    index: [["index-update-log", "更新记录", {}]],
  },
  viewHistories: { "memory:novel": [{ id: "view-history-before" }] },
  currentVersionMeta: {
    documents: { "memory-snapshot": { id: "document-meta-before" } },
    views: { "memory:novel": { id: "view-meta-before" } },
  },
  activities: [{ id: "activity-before", documentId: "chapter-8", label: "已有活动" }],
};

const snapshot = captureMaterialUpdateMemoryRollback({
  state,
  sourceDocumentIds: ["chapter-8"],
  managedDocumentIds: ["memory-snapshot", "memory-reader", "report-compile", "index-update-log", "index-pending"],
  viewKeys: ["memory:novel"],
});

state.memoryStore = { entities: [{ id: "after" }] };
state.documents["chapter-8"].html = "<p>并发产生的正文修改必须保留</p>";
state.documents["chapter-8"].continuityDelta = { summary: "新摘要" };
state.documents["chapter-8"].memorySyncStatus = "synced";
state.documents["chapter-8"].memorySyncPhase = "complete";
state.documents["memory-snapshot"] = { title: "状态快照", html: "<p>新状态</p>" };
state.documents["memory-reader"] = { title: "读者当前知识库", html: "<p>新知识</p>" };
state.documents["report-compile"].html = "<p>新总览</p>";
state.documents["index-update-log"].html = "<p>新记录</p>";
state.documents["index-pending"] = { title: "待确认事项", html: "<p>记忆冲突</p>" };
state.histories["memory-snapshot"] = [{ id: "memory-history-after" }];
state.histories["memory-reader"] = [{ id: "reader-history-after" }];
state.histories["chapter-8"] = [{ id: "chapter-history-from-another-task" }];
state.moduleItems.memory.push(["memory-reader", "读者当前知识库", {}]);
state.viewHistories["memory:novel"] = [{ id: "view-history-after" }];
state.currentVersionMeta.documents["memory-snapshot"] = { id: "document-meta-after" };
state.currentVersionMeta.views["memory:novel"] = { id: "view-meta-after" };
state.activities.unshift({ id: "memory-activity-after", documentId: "chapter-8", label: "同步第八章的结构化记忆投影" });
state.activities.unshift({ id: "unrelated-activity-after", documentId: "canon-world", label: "其他对话修改世界观" });

const restored = restoreMaterialUpdateMemoryRollback({ state, snapshot });

assert.equal(restored.restored, true);
assert.deepEqual(state.memoryStore, { entities: [{ id: "before" }] });
assert.equal(state.documents["chapter-8"].html, "<p>并发产生的正文修改必须保留</p>");
assert.deepEqual(state.documents["chapter-8"].continuityDelta, { summary: "旧摘要" });
assert.equal(state.documents["chapter-8"].memorySyncStatus, "pending");
assert.equal(Object.hasOwn(state.documents["chapter-8"], "memorySyncPhase"), false);
assert.equal(state.documents["memory-snapshot"].html, "<p>旧状态</p>");
assert.equal(state.documents["report-compile"].html, "<p>旧总览</p>");
assert.equal(state.documents["index-update-log"].html, "<p>旧记录</p>");
assert.equal(Object.hasOwn(state.documents, "memory-reader"), false);
assert.equal(Object.hasOwn(state.documents, "index-pending"), false);
assert.deepEqual(state.histories["memory-snapshot"], [{ id: "memory-history-before" }]);
assert.equal(Object.hasOwn(state.histories, "memory-reader"), false);
assert.deepEqual(state.histories["chapter-8"], [{ id: "chapter-history-from-another-task" }]);
assert.deepEqual(state.moduleItems.memory, [["memory-snapshot", "状态快照", {}]]);
assert.deepEqual(state.viewHistories["memory:novel"], [{ id: "view-history-before" }]);
assert.deepEqual(state.currentVersionMeta.documents["memory-snapshot"], { id: "document-meta-before" });
assert.deepEqual(state.currentVersionMeta.views["memory:novel"], { id: "view-meta-before" });
assert.equal(state.activities.some((item) => item.id === "memory-activity-after"), false);
assert.equal(state.activities.some((item) => item.id === "unrelated-activity-after"), true);

console.log("material update memory compensating rollback passed");
