import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  agentDecisionResolutionForAnswer,
  agentDecisionResolutionForOption,
  isAgentDecision,
  normalizeAgentDecisionResolution,
} from "../src/agent-decision-ui.js";

const decision = {
  id: "agent-decision-12345678",
  taskId: "task-12345678",
  conversationId: "conversation-1",
  contractRevision: 4,
  question: "这次写入哪里？",
  allowFreeText: true,
  options: [
    { id: "current", label: "当前文档", effect: "写入发送时打开的文档" },
    { id: "new", label: "新建文档", effect: "创建新的目标文档" },
  ],
};

assert.equal(isAgentDecision(decision), true);
assert.deepEqual(agentDecisionResolutionForOption({ decision, option: decision.options[0] }), {
  decisionId: decision.id,
  taskId: decision.taskId,
  contractRevision: 4,
  optionId: "current",
  answer: "当前文档",
});
assert.deepEqual(agentDecisionResolutionForAnswer({ decision, answer: "写入世界观设定" }), {
  decisionId: decision.id,
  taskId: decision.taskId,
  contractRevision: 4,
  answer: "写入世界观设定",
});
assert.equal(normalizeAgentDecisionResolution({ decisionId: decision.id, taskId: decision.taskId }), null);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const dispatch = appSource.slice(appSource.indexOf("const dispatchComposerContent ="), appSource.indexOf("let agentProfileChoiceContext"));
const submit = appSource.slice(appSource.indexOf('document.querySelector("#chatForm").addEventListener("submit"'), appSource.indexOf("const finalizeTemporaryCodexLogin"));
assert.doesNotMatch(dispatch + submit, /rankingScanIntent|continuationDestinationIntent|requestsMultipleCandidates|lockedComposerMediaDispatch|isLandingRequest|resolveTaskContractRetryContext/u, "发送路径不再按关键词裁决任务");
assert.match(dispatch, /showImmediateConversationInstruction[\s\S]*dispatchAfterImmediateInstructionPaint[\s\S]*sendMessage/u);
assert.match(submit, /answerNativeConversationQuestion\(question, content\)/u, "自由输入回答绑定原 Agent");
assert.match(appSource, /conversationAgentRequest\(`\/api\/conversation-agent\/\$\{question.runId\}\/answer`/u);
assert.match(appSource, /kind === "native_agent"[\s\S]{0,700}native_agent_confirm/u, "动态选择支持多选");
assert.match(appSource, /event.type === "question"[\s\S]{0,1200}await persistNativeConversation\(runtime\)[\s\S]{0,250}yieldAfterImmediateInstructionRender/u, "问题先保存与显示");
assert.match(appSource, /snapshotAgentConfiguration\(generationSettingsForAgentEngine/u, "队列冻结运行器配置");
assert.match(appSource, /nativeAgentRunId\}\/supplement/u, "补充发给当前 Agent");
console.log("Agent UI: semantic dispatch, durable question ordering, free/multiple answers and queue settings passed");
