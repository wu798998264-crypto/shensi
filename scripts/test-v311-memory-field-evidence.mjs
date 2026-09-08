import assert from "node:assert/strict";

import {
  memoryUpdateAssertions,
  retainVerifiedMemoryUpdateFacts,
  verifyMemoryUpdateEvidence,
} from "../src/memory-evidence.js";

const sentence = "林砚握住发烫的铜兽印，确认矿洞与父亲失踪有关。";
const structuredUpdate = {
  chapterSummary: sentence,
  stateChanges: [{
    id: "state-linyan",
    name: "林砚",
    state: "已确认铜兽印指向矿洞",
    detail: sentence,
  }],
  informationRelease: [{
    id: "information-copper-seal",
    name: "铜兽印与矿洞的关联",
    state: "局部揭示",
    chapter: "第1章《兽血矿洞》",
    detail: sentence,
    allowedWriting: "下一章可以追查矿洞，但不得揭示父亲失踪的完整真相",
  }],
  evidence: [{ claim: sentence, quote: sentence }],
};

const assertions = memoryUpdateAssertions(structuredUpdate);
assert.deepEqual(assertions, [sentence, sentence, sentence], "事实校验只应检查正文事实，不应拼入管理字段");

const verification = verifyMemoryUpdateEvidence({ memoryUpdate: structuredUpdate, candidate: sentence });
assert.equal(verification.ok, true, verification.reason);

const retained = retainVerifiedMemoryUpdateFacts({ memoryUpdate: structuredUpdate, candidate: sentence });
assert.equal(retained.ok, true, retained.reason);
assert.equal(retained.memoryUpdate.stateChanges[0].state, "已确认铜兽印指向矿洞");
assert.equal(retained.memoryUpdate.informationRelease[0].chapter, "第1章《兽血矿洞》");
assert.match(retained.memoryUpdate.informationRelease[0].allowedWriting, /不得揭示/u);

const unsupported = retainVerifiedMemoryUpdateFacts({
  memoryUpdate: {
    ...structuredUpdate,
    informationRelease: [{
      ...structuredUpdate.informationRelease[0],
      id: "information-unsupported",
      detail: "矿洞下面已经确认埋着一座古兽神殿。",
    }],
  },
  candidate: sentence,
});
assert.equal(unsupported.ok, true, unsupported.reason);
assert.equal(unsupported.memoryUpdate.informationRelease.length, 0, "没有正文证据的事实记录必须被逐条删除");
assert.equal(unsupported.memoryUpdate.chapterSummary, sentence, "不支持的记录不得拖累已经验证的章节摘要");

console.log("v3.1.1 memory field evidence tests passed");
