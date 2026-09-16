import assert from "node:assert/strict";
import {
  buildMemorySourceIndex,
  compileMemoryExtraction,
  parseMemoryExtractionOutput,
} from "../src/memory-numbered-evidence.js";
import { extractMemoryWithNumberedEvidence } from "../src/server/memory-extraction-service.mjs";

const source = "叶昭走进主炉通道。\n\n叶昭从守卫手中拿到了铜心钥匙。随后，叶昭确认钥匙可以开启内炉。";
const index = buildMemorySourceIndex(source);
assert.equal(index.paragraphs.length, 2);
assert.equal(index.paragraphs[0].sentences[0].ref, "P001.S001");
assert.equal(index.paragraphs[1].sentences[1].ref, "P002.S002");
assert.equal(buildMemorySourceIndex(source).entries["P002.S001"].hash, index.entries["P002.S001"].hash);

const parsed = parseMemoryExtractionOutput(JSON.stringify({ items: [{
  type: "state_change",
  name: "叶昭",
  content: "叶昭拿到了铜心钥匙。",
  state: "持有铜心钥匙",
  sourceRefs: ["P002.S001"],
}] }));
const compiled = compileMemoryExtraction({ items: parsed.items, sourceIndex: index, documentId: "chapter-8", sourceRevision: "rev-8" });
assert.equal(compiled.failures.length, 0);
assert.equal(compiled.memoryUpdate.stateChanges[0].id.startsWith("state-"), true);
assert.equal(compiled.memoryUpdate.evidence[0].quote, "叶昭从守卫手中拿到了铜心钥匙。");
assert.equal(compiled.memoryUpdate.evidence[0].sourceRefs[0], "P002.S001");
assert.equal(Number.isInteger(compiled.memoryUpdate.evidence[0].sourceStart), true);

const calls = [];
const serviceResult = await extractMemoryWithNumberedEvidence({
  documentId: "chapter-8",
  content: source,
  sourceRevision: "rev-8",
  now: () => "2026-09-16T00:00:00.000Z",
  runModel: async ({ phase, prompt }) => {
    calls.push({ phase, prompt });
    if (phase === "extract") return JSON.stringify({ items: [{
      repairKey: "valid",
      type: "state_change",
      name: "叶昭",
      content: "叶昭拿到了铜心钥匙。",
      state: "持有铜心钥匙",
      sourceRefs: ["P002.S001"],
    }, {
      repairKey: "broken",
      type: "foreshadowing",
      name: "内炉开启",
      content: "钥匙已经打开了内炉。",
      sourceRefs: ["P999.S999"],
    }] });
    return JSON.stringify({ items: [{
      repairKey: "broken",
      type: "foreshadowing",
      name: "内炉开启",
      content: "叶昭确认钥匙可以开启内炉。",
      state: "已确认用途，尚未开启",
      sourceRefs: ["P002.S002"],
    }, {
      repairKey: "rogue",
      type: "state_change",
      name: "越界项目",
      content: "叶昭走进主炉通道。",
      sourceRefs: ["P001.S001"],
    }] });
  },
});
assert.equal(serviceResult.mode, "verified");
assert.equal(serviceResult.deferredItemCount, 0);
assert.equal(serviceResult.memoryUpdate.stateChanges.length, 1);
assert.equal(serviceResult.memoryUpdate.foreshadowing.length, 1);
assert.equal(serviceResult.memoryUpdate.stateChanges.length, 1, "局部修复不得接收失败列表之外的新项目");
assert.equal(calls.length, 2);
assert.equal(calls[1].prompt.includes("valid"), false, "局部修复不得重新发送已通过项目");
assert.equal(calls[1].prompt.includes("broken"), true);

const deferredResult = await extractMemoryWithNumberedEvidence({
  documentId: "chapter-8",
  content: source,
  sourceRevision: "rev-8",
  maxRepairRounds: 2,
  now: () => "2026-09-16T00:00:00.000Z",
  runModel: async ({ phase }) => phase === "extract"
    ? JSON.stringify({ items: [{ repairKey: "bad", type: "state_change", name: "叶昭", content: "叶昭已经离开主炉。", sourceRefs: ["P999.S999"] }] })
    : JSON.stringify({ items: [{ repairKey: "bad", type: "state_change", name: "叶昭", content: "叶昭已经离开主炉。", sourceRefs: ["P999.S999"] }] }),
});
assert.equal(deferredResult.mode, "deferred");
assert.equal(deferredResult.acceptedItemCount, 0);
assert.equal(deferredResult.deferredItemCount, 1);
assert.equal(deferredResult.memoryUpdate.stateChanges.length, 0);
assert.equal(deferredResult.memoryUpdate.deferredCandidates[0].status, "deferred");
assert.equal(Boolean(deferredResult.memoryUpdate.deferredCandidates[0].evidence?.quote), true, "真正降级时仍必须保留正文原文证据");
assert.equal(deferredResult.memoryUpdate.degradationEvents.at(-1).outcome, "deferred_to_unit_memory");

const protocolDeferred = await extractMemoryWithNumberedEvidence({
  documentId: "chapter-8",
  content: source,
  sourceRevision: "rev-8",
  now: () => "2026-09-16T00:00:00.000Z",
  runModel: async () => "not-json",
});
assert.equal(protocolDeferred.mode, "deferred");
assert.equal(protocolDeferred.memoryUpdate.deferredCandidates[0].type, "chapter_source_pending");
assert.equal(protocolDeferred.memoryUpdate.deferredCandidates[0].content, index.paragraphs.at(-1).text);
assert.equal(protocolDeferred.memoryUpdate.deferredCandidates[0].evidence.quote, index.paragraphs.at(-1).text);

const emptyResult = await extractMemoryWithNumberedEvidence({
  documentId: "chapter-8",
  content: source,
  sourceRevision: "rev-8",
  runModel: async () => JSON.stringify({ items: [] }),
});
assert.equal(emptyResult.mode, "empty");
assert.equal(emptyResult.memoryUpdate.analysisComplete, true);
assert.equal(emptyResult.memoryUpdate.deferredCandidates.length, 0);

console.log("numbered memory extraction and item repair passed");
