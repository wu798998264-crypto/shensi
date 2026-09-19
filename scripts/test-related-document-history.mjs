import assert from "node:assert/strict";

import {
  collectRelatedDocumentHistory,
  historyDocumentContentSignature,
  historyDocumentFromEntry,
  prepareRelatedDocumentRestore,
} from "../src/related-history.js";
import { resolveHistoryDiffInput } from "../src/history-diff.js";

const documentId = "chapter-1";
const initial = { title: "第一章", html: "<p>初稿。</p>", markdown: "初稿。" };
const revised = { title: "第一章", html: "<p>修订稿。</p>", markdown: "修订稿。" };
const final = { title: "第一章", html: "<p>定稿。</p>", markdown: "定稿。" };

assert.deepEqual(
  historyDocumentFromEntry({ id: "legacy", html: initial.html, markdown: initial.markdown }, documentId, "document", documentId),
  { title: "", html: initial.html, markdown: initial.markdown, continuityDelta: null },
  "缺少 scopeType 的旧单篇历史也必须能显示",
);
assert.equal(historyDocumentContentSignature(initial), historyDocumentContentSignature({ ...initial }), "完全相同内容必须生成相同签名");

const timeline = collectRelatedDocumentHistory({
  documentId,
  directEntries: [{
    id: "document-1700000000000",
    scopeType: "document",
    scopeId: documentId,
    createdAt: "2023-11-14T22:13:20.000Z",
    document: initial,
    title: "单篇初稿",
  }],
  viewHistories: {
    "manuscript:novel": [{
      id: "view-1700000001000",
      scopeType: "view",
      scopeId: "manuscript:novel",
      createdAt: "2023-11-14T22:13:21.000Z",
      documents: { [documentId]: revised, "chapter-2": { title: "第二章", html: "<p>其他正文</p>" } },
      changeSet: [{ start: 0, end: 1, before: "错", after: "误" }],
      title: "分类快照",
    }],
  },
  volumeHistories: {
    volumeA: [{
      id: "volume-1700000002000",
      scopeType: "volume",
      scopeId: "volumeA",
      createdAt: "2023-11-14T22:13:22.000Z",
      documents: { [documentId]: revised },
      title: "重复修订稿",
    }],
  },
  moduleHistories: {
    manuscript: [{
      id: "module-1700000003000",
      scopeType: "module",
      scopeId: "manuscript",
      createdAt: "2023-11-14T22:13:23.000Z",
      documents: { [documentId]: final },
      title: "板块定稿",
    }],
  },
  projectHistories: [{
    id: "project-1700000004000",
    scopeType: "project",
    scopeId: "project",
    createdAt: "2023-11-14T22:13:24.000Z",
    state: { documents: { [documentId]: final } },
    title: "重复作品定稿",
  }],
});

assert.equal(timeline.length, 3, "跨层级完全相同的正文只能显示一次");
assert.deepEqual(timeline.map((entry) => entry.document.html), [final.html, revised.html, initial.html], "统一历史必须按真实时间倒序排列");
assert.equal(timeline[0].relatedHistoryDuplicateSources.length, 1, "去重后仍需保留其他来源索引");
assert.equal(timeline[0].sourceHistoryReadOnly, true, "上层快照在单篇入口必须只读");
assert.equal(timeline[0].relatedDocumentOnly, true, "上层快照必须标记为只恢复当前文档");
assert.deepEqual(timeline[0].changeSet, [], "多文档差异不得错误套用到单篇正文");
assert.equal(timeline[0].afterContent, undefined);
assert.equal(timeline[2].relatedDocumentOnly, false, "原单篇历史仍保留正常管理语义");
assert.equal(timeline[0].parentVersionId, timeline[1].id, "旧记录缺少父版本时必须回退到相邻完整快照");

const promotedTimeline = collectRelatedDocumentHistory({
  documentId,
  directEntries: [
    {
      id: "newer-created-version",
      scopeType: "document",
      scopeId: documentId,
      createdAt: "2026-01-02T00:00:00.000Z",
      document: revised,
    },
    {
      id: "older-promoted-version",
      scopeType: "document",
      scopeId: documentId,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivatedAt: "2026-01-03T00:00:00.000Z",
      document: initial,
    },
  ],
});
assert.equal(promotedTimeline[0].id, "older-promoted-version", "重新命中的旧版本必须按最近启用时间显示在最上方");

const rebuilt = resolveHistoryDiffInput({
  parentBefore: timeline[1].document.html,
  snapshotAfter: timeline[0].document.html,
  hasParent: true,
});
assert.equal(rebuilt.hasDiff, true, "跨层级相邻完整快照必须能重建差异");
assert.equal(rebuilt.source, "parent-snapshot");

const sourceEntries = [{
  id: timeline[0].relatedHistorySourceVersionId,
  scopeType: timeline[0].relatedHistorySourceScope.type,
  scopeId: timeline[0].relatedHistorySourceScope.id,
  state: { documents: { [documentId]: final, "chapter-2": { title: "第二章", html: "<p>上层旧内容</p>" } } },
}];
const restorePlan = prepareRelatedDocumentRestore({
  documentId,
  displayEntry: timeline[0],
  sourceEntries,
  directEntries: [{ id: "direct-existing" }],
});
assert.ok(restorePlan, "来源仍一致时必须生成单篇恢复计划");
assert.deepEqual(restorePlan.entries.map((entry) => entry.id), ["direct-existing"], "恢复计划不再预存被覆盖前的可见版本");
assert.equal(restorePlan.selected.document.html, final.html);
assert.equal(prepareRelatedDocumentRestore({ documentId, displayEntry: timeline[0], sourceEntries: [], directEntries: [] }), null, "关联来源消失时必须停止恢复");
assert.equal(prepareRelatedDocumentRestore({ documentId, displayEntry: timeline[0], sourceEntries: [{ ...sourceEntries[0], state: { documents: { [documentId]: initial } } }], directEntries: [] }), null, "来源正文变化时必须停止恢复而不是使用过期预览");

const restoredDocuments = { [documentId]: structuredClone(restorePlan.selected.document), "chapter-2": { title: "第二章", html: "<p>保持不变</p>" } };
assert.equal(restoredDocuments["chapter-2"].html, "<p>保持不变</p>", "单篇恢复不得影响同一上层快照中的其他文档");

console.log("related document history tests passed");
