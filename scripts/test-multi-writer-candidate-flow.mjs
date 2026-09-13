import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { multiCandidateGenerationInstruction } from "../src/multi-candidate-plan.js";

const instruction = multiCandidateGenerationInstruction({ prompt: "生成三份候选，重点比较节奏与视角", count: 3, direction: "pacing" });
assert.match(instruction, /独立生成 3 份候选版本/u);
assert.match(instruction, /节奏差异/u);
assert.match(instruction, /不得询问由谁主笔或几个主笔/u);
assert.doesNotMatch(instruction, /参与主笔|每位主笔|主笔来源/u);
assert.match(instruction, /candidate_only/u);
assert.doesNotMatch(instruction, /allowBodyMutation|state:\s*["']?commit/u);

const [app, tools] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/conversation-agent-tools.mjs", import.meta.url), "utf8"),
]);
assert.doesNotMatch(app, /writer_count|writer_counts|确认主笔|单主笔生成多稿|多主笔生成候选/u);
assert.match(tools, /tool\("candidates",\s*"交付多个候选稿，不要求选择主笔，也不自动写入文档。"/u);
assert.match(tools, /variants:\s*\{\s*type:\s*"array"[\s\S]{0,260}title:[\s\S]{0,120}content:[\s\S]{0,120}required:\s*\["title",\s*"content"\]/u);
assert.match(tools, /多候选必须包含至少两份完整内容/u);

console.log("multi-candidate natural-language flow without writer selection passed");
