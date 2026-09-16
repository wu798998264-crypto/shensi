import assert from "node:assert/strict";

import {
  emptyMemoryStore,
  mergeFormalMemoryDelivery,
  normalizeFormalMemoryDelivery,
  memoryStoreProjectionBaselineDecision,
  memoryStoreProjectionFingerprint,
  trustedMemoryProjection,
} from "../src/structured-memory-store.js";
import { validateManagedDocumentFormat } from "../src/managed-document-format.js";

const contract = {
  protocol: "shensi_task_contract_v1",
  semanticSource: "agent",
  taskType: "writing",
  operation: "batch",
  persistence: "commit",
  targetResolution: "exact",
  deliverables: [
    {
      id: "deliverable-foreshadowing",
      kind: "memory",
      title: "伏笔管理",
      targetDocumentId: "memory-foreshadowing",
      target: { documentId: "memory-foreshadowing", moduleId: "memory" },
    },
    {
      id: "deliverable-release",
      kind: "memory",
      title: "信息释放表",
      targetDocumentId: "memory-release",
      target: { documentId: "memory-release", moduleId: "memory" },
    },
  ],
};

const foreshadowingText = "倒走七格的钟承担路线误导功能，必须在第十二章以前留下可回查证据。";
const normalizedPlain = normalizeFormalMemoryDelivery({
  documentId: "memory-foreshadowing",
  content: foreshadowingText,
  taskContract: contract,
});
assert.equal(normalizedPlain.ok, true, normalizedPlain.reason);
assert.equal(normalizedPlain.field, "foreshadowing");
assert.equal(normalizedPlain.memoryUpdate.foreshadowing.length, 1);
assert.equal(normalizedPlain.memoryUpdate.informationRelease.length, 0);

const foreshadowing = mergeFormalMemoryDelivery({
  store: emptyMemoryStore(),
  documentId: "memory-foreshadowing",
  content: foreshadowingText,
  taskContract: contract,
  updatedAt: "2026-09-08T00:00:00.000Z",
});
assert.equal(foreshadowing.ok, true, foreshadowing.reason);
assert.equal(foreshadowing.changed, true);
assert.equal(Object.keys(foreshadowing.store.foreshadowing).length, 1);
assert.equal(Object.keys(foreshadowing.store.unitDeltas).length, 0, "规划型记忆交付不得伪造正文连续性增量");

const releaseText = "气税损耗寿数先公开，叶昭失忆随后公开，阿满真实目的延迟到第十八章。";
const releaseUpdate = {
  informationRelease: [{
    id: "gas-tax-release-order",
    name: "气税真相的信息释放顺序",
    detail: releaseText,
    state: "scheduled",
    chapter: "第1章至第18章",
  }],
  evidence: [{ claim: releaseText, quote: releaseText }],
};
const release = mergeFormalMemoryDelivery({
  store: foreshadowing.store,
  documentId: "memory-release",
  content: releaseText,
  memoryUpdate: releaseUpdate,
  taskContract: contract,
  updatedAt: "2026-09-08T00:01:00.000Z",
});
assert.equal(release.ok, true, release.reason);
assert.equal(release.changed, true);
assert.equal(Object.keys(release.store.informationEntities).length, 1);
assert.equal(release.store.informationEntities["information-gas-tax-release-order"].release.state, "scheduled");

const foreshadowingProjection = trustedMemoryProjection({ store: release.store, documentId: "memory-foreshadowing" });
const releaseProjection = trustedMemoryProjection({ store: release.store, documentId: "memory-release" });
assert.match(foreshadowingProjection.markdown, /倒走七格的钟承担路线误导功能/u);
assert.match(releaseProjection.markdown, /气税损耗寿数先公开/u);
assert.equal(validateManagedDocumentFormat({
  documentId: "memory-release",
  moduleId: "memory",
  content: releaseProjection.markdown,
  systemProjection: true,
}).valid, true);

// The editor/workspace transport may remove the projection schema comment and
// convert Markdown emphasis/list markers to HTML. That round-trip is trusted
// and must not be reported as an author edit, while a real text change must be.
const projectionBaseline = memoryStoreProjectionFingerprint({
  documentId: "memory-release",
  html: releaseProjection.html,
});
const roundTrip = memoryStoreProjectionBaselineDecision({
  documentId: "memory-release",
  markdown: releaseProjection.markdown,
  baselineHash: projectionBaseline,
  baselineVersion: 2,
  expectedProjection: releaseProjection,
});
assert.equal(roundTrip.matches, true, "受信任的 HTML/Markdown 往返不得误报人工修改");
const editedMarkdown = releaseProjection.markdown.replace("阿满真实目的延迟到第十八章", "阿满真实目的延迟到第十章");
const edited = memoryStoreProjectionBaselineDecision({
  documentId: "memory-release",
  markdown: editedMarkdown,
  baselineHash: projectionBaseline,
  baselineVersion: 2,
  expectedProjection: releaseProjection,
});
assert.equal(edited.matches, false, "实际修改投影正文必须保留冲突保护");

const idempotent = mergeFormalMemoryDelivery({
  store: release.store,
  documentId: "memory-release",
  content: releaseText,
  memoryUpdate: releaseUpdate,
  taskContract: contract,
});
assert.equal(idempotent.ok, true);
assert.equal(idempotent.changed, false, "同一正式记忆交付重试必须幂等");

assert.equal(normalizeFormalMemoryDelivery({
  documentId: "memory-release",
  content: releaseText,
  memoryUpdate: { ...releaseUpdate, foreshadowing: [{ name: "越权伏笔", detail: releaseText }] },
  taskContract: contract,
}).reason, "memory_delivery_cross_target_update", "单个投影交付不得夹带其他记忆目标的变更");

assert.equal(normalizeFormalMemoryDelivery({
  documentId: "memory-release",
  content: releaseText,
  memoryUpdate: releaseUpdate,
  taskContract: { ...contract, persistence: "candidate_only" },
}).reason, "memory_delivery_requires_commit_contract", "候选态合同不得修改结构化记忆仓");

console.log("formal memory delivery projection tests passed");
