import assert from "node:assert/strict";

import { candidateBasisLandingDecision } from "../src/candidate-provenance.js";

assert.equal(candidateBasisLandingDecision({ ok: true }).allow, true);
assert.equal(candidateBasisLandingDecision({
  ok: false,
  code: "CANDIDATE_TARGET_CHANGED",
  reason: "第三章已被用户修改",
}).allow, false);
assert.equal(candidateBasisLandingDecision({
  ok: false,
  code: "CANDIDATE_BASIS_MISSING",
  reason: "缺少生成基线",
}).allow, false);
assert.equal(candidateBasisLandingDecision({
  ok: false,
  code: "CANDIDATE_CONTEXT_CHANGED",
  reason: "生成依据已变化",
}).allow, false);
assert.equal(candidateBasisLandingDecision({ ok: false }).snapshotBeforeReplace, false);

console.log("Shensi v2.19 stale candidate protection tests passed");
