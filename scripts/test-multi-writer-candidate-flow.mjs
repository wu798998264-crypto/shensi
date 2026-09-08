import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createConversationChoiceState,
  selectConversationChoice,
  candidateGenerationRequest,
} from "../src/conversation-choice-panel.js";
import { multiCandidateGenerationInstruction } from "../src/multi-candidate-plan.js";

const writers = [
  { id: "builtin:novel-writer", name: "小说正文主笔", role: "primary", sourceLabel: "神思内置", version: "current" },
  { id: "builtin:chinese-novelist-skill", name: "小说原型设计", role: "secondary", sourceLabel: "神思内置 · chinese-novelist-skill", version: "current" },
];
let state = createConversationChoiceState({ prompt: "比较两位主笔的候选稿", writers });
state = selectConversationChoice(state, { type: "writer_mode", value: "multiple" });
state = selectConversationChoice(state, { type: "writers", value: writers.map((writer) => writer.id) });
state = selectConversationChoice(state, {
  type: "writer_counts",
  value: { "builtin:novel-writer": 2, "builtin:chinese-novelist-skill": 3 },
});
const request = candidateGenerationRequest(state);
assert.deepEqual(request.writerIds, writers.map((writer) => writer.id));
assert.equal(request.countsByWriter["builtin:novel-writer"], 2);
assert.equal(request.countsByWriter["builtin:chinese-novelist-skill"], 3);
assert.equal(state.writers[1].role, "secondary");
assert.match(state.writers[1].sourceLabel, /chinese-novelist-skill/u);

const instruction = multiCandidateGenerationInstruction({ ...request, count: 2 });
assert.match(instruction, /独立生成 5 份候选版本/u);
assert.match(instruction, /必须分别标记每份候选的主笔来源/u);
assert.match(instruction, /candidate_only/u);
assert.doesNotMatch(instruction, /allowBodyMutation|state:\s*["']?commit/u);

const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const orchestrator = await readFile(new URL("../src/server/shensi-orchestrator.mjs", import.meta.url), "utf8");
const attemptStore = await readFile(new URL("../src/server/generation-attempt-store.mjs", import.meta.url), "utf8");
assert.match(server, /candidateWriterPlan\.writerIds\.map\(async \(writerId\)[\s\S]{0,1200}loadSelectedSkills/u, "每位主笔必须通过同一受信 Skill 加载器建立运行时");
assert.match(server, /const candidateWriterRuntimes[\s\S]{0,1800}resolveSkillRuntime/u, "服务端必须解析并传递每位主笔的真实运行时");
assert.match(orchestrator, /skillRuntimeOverride:\s*writer\?\.runtime/u, "创作调用必须使用对应主笔的完整 Skill 运行时");
assert.match(orchestrator, /writerId:\s*record\.writerId/u, "候选结果必须保留主笔 ID");
assert.match(attemptStore, /writerName/u, "候选任务记录必须保留主笔名称");

console.log("multi-writer candidate flow regressions passed");
