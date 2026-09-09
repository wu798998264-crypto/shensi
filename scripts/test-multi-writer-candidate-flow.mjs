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
assert.match(tools, /保留多候选[\s\S]{0,120}不要提问选谁当主笔或几个主笔|不要提问选谁当主笔或几个主笔[\s\S]{0,120}保留多候选/u);
assert.match(tools, /interaction\.candidates|tool\("candidates"/u);

console.log("multi-candidate natural-language flow without writer selection passed");
