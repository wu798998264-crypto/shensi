import assert from "node:assert/strict";
import { multiCandidateGenerationInstruction, normalizeMultiCandidateCount } from "../src/multi-candidate-plan.js";

assert.equal(normalizeMultiCandidateCount(4), 4);
assert.equal(normalizeMultiCandidateCount(8), 2);
const instruction = multiCandidateGenerationInstruction({ prompt: "续写当前章", count: 4, direction: "emotion", note: "不要改变既定结局" });
assert.match(instruction, /独立生成 4 份候选版本/u);
assert.match(instruction, /情绪差异/u);
assert.match(instruction, /candidate_only/u);
assert.doesNotMatch(instruction, /allowBodyMutation|state:\s*["']?commit/u, "候选配置不得携带隐式正文写入授权");
assert.match(instruction, /不要改变既定结局/u);
assert.equal(multiCandidateGenerationInstruction({ prompt: "" }), "");

console.log("multi-candidate generation plan regressions passed");
