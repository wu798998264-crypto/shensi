import assert from "node:assert/strict";
import {
  emptyMemoryStore,
  ensureMemoryStore,
  memoryCandidateGate,
  mergeMemoryCandidate,
  projectMemoryStoreDocumentText,
  projectMemoryStoreMarkdown,
  memoryStoreSummary,
  markMemorySourceStale,
  buildMemoryMigrationPreview,
} from "../src/structured-memory-store.js";

const sentence = "父亲留下的铜兽印靠近矿洞时骤然发烫。";
const contract = {
  protocol: "shensi.task-contract.v1",
  taskType: "writing",
  deliverables: [{
    id: "deliverable-001",
    kind: "prose",
    targetDocumentId: "chapter-1",
    target: { documentId: "chapter-1", moduleId: "manuscript" },
  }],
};
const update = {
  chapterSummary: sentence,
  stateChanges: [{ id: "state-linyan", name: "林砚", state: "确认铜兽印发烫", detail: sentence }],
  firstAppearances: [{ id: "information-copper-seal", name: "铜兽印与矿洞有关", detail: sentence, chapter: "第1章" }],
  informationRelease: [{ id: "information-copper-seal", name: "铜兽印与矿洞有关", state: "partial_reveal", detail: sentence, allowedWriting: "可以继续追查矿洞" }],
  readerKnowledge: [{ id: "information-copper-seal", name: "铜兽印与矿洞有关", detail: sentence }],
  foreshadowing: [{ id: "foreshadow-copper-seal", name: "父亲失踪线索", detail: sentence, state: "planted" }],
  nextContext: ["铜兽印仍需追查"],
  evidence: [{ claim: sentence, quote: sentence }],
  evidenceVerified: true,
};

assert.equal(memoryCandidateGate({ documentId: "chapter-1", content: sentence, memoryUpdate: update, taskContract: contract, sourceAccepted: true }).eligible, true);
assert.equal(memoryCandidateGate({ documentId: "chapter-1", content: sentence, memoryUpdate: update, taskContract: null, sourceAccepted: true }).eligible, false, "没有正式 TaskContract 不得入库");
assert.equal(memoryCandidateGate({ documentId: "outline-chapter-1", content: sentence, memoryUpdate: update, taskContract: { ...contract, deliverables: [{ ...contract.deliverables[0], kind: "outline", targetDocumentId: "outline-chapter-1" }] }, sourceAccepted: true }).eligible, false);

const merged = mergeMemoryCandidate({ store: emptyMemoryStore(), documentId: "chapter-1", content: sentence, memoryUpdate: update, taskContract: contract, sourceAccepted: true, updatedAt: "2026-08-25T00:00:00.000Z" });
assert.equal(merged.ok, true, merged.reason);
assert.equal(merged.changed, true);
assert.equal(Object.keys(merged.store.informationEntities).length, 1, "三张信息账本必须合并为同一实体");
assert.equal(merged.store.informationEntities["information-copper-seal"].release.state, "partial_reveal");
assert.equal(Object.keys(merged.store.currentStates.novel).length, 1);
assert.equal(merged.store.currentStates.novel["state-linyan"].source.documentId, "chapter-1");
assert.equal(merged.store.currentStates.novel["state-linyan"].source.quote, sentence);
assert.equal(Object.keys(merged.store.evidenceIndex).length, 1);
assert.equal(Object.keys(merged.store.revisions).length, 1);

const idempotent = mergeMemoryCandidate({ store: merged.store, documentId: "chapter-1", content: sentence, memoryUpdate: update, taskContract: contract, sourceAccepted: true });
assert.equal(idempotent.ok, true);
assert.equal(idempotent.changed, false, "同一正文版本重试必须幂等");

const markdown = projectMemoryStoreMarkdown({ store: merged.store, documentId: "memory-release" });
assert.match(markdown, /# 信息释放表/u);
assert.match(markdown, /information-copper-seal/u);
assert.match(markdown, /父亲留下的铜兽印靠近矿洞时骤然发烫/u);
assert.match(projectMemoryStoreDocumentText({ store: merged.store, documentId: "memory-reader" }), /读者当前知识库/u);

const stale = markMemorySourceStale({ store: merged.store, documentId: "chapter-1", currentRevision: "rev-new" });
assert.equal(Object.values(stale.revisions)[0].status, "evidence_invalid");
assert.equal(stale.unitDeltas["chapter-1"].status, "evidence_invalid");

const legacy = ensureMemoryStore({
  documents: {
    "memory-release": { html: `<h1>信息释放表</h1><h2>[INFO:information-copper-seal] 铜兽印与矿洞有关</h2><p>状态：局部揭示</p><p>内容：${sentence}</p>` },
  },
});
assert.equal(legacy.schemaVersion, 1);
assert.ok(Object.keys(legacy.informationEntities).length >= 1, "旧记忆文档必须可读取为兼容事实");
assert.equal(buildMemoryMigrationPreview({ documents: {
  "memory-release": { html: `<h1>信息释放表</h1><h2>[INFO:information-copper-seal] 铜兽印与矿洞有关</h2><p>内容：${sentence}</p>` },
} }).status, "pending_confirmation");

assert.equal(memoryStoreSummary(merged.store).informationEntities, 1);
console.log("v3.1.2 structured memory store tests passed");
