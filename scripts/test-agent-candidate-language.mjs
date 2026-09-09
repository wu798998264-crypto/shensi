import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/conversation-choice-panel.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /openCandidateGenerationDialog|pendingCandidateChoiceState|startCandidateGeneration/u,
  "普通对话不得保留固定候选主笔向导入口");
assert.match(app, /pending\.kind === "candidate"[\s\S]{0,280}writer-role\/quantity wizard/u);
assert.doesNotMatch(panel, /writer_mode|writer_count|writer_counts|selectConversationChoice/u,
  "选项模块不得再按主笔或数量关键词维护旧状态机");
console.log("Candidate count and variation use natural language; writer-role wizard is removed");
