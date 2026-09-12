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
const conversationToolsSource = await readFile(new URL("../src/server/conversation-agent-tools.mjs", import.meta.url), "utf8");
const conversationGatewaySource = await readFile(new URL("../src/server/conversation-agent-gateway.mjs", import.meta.url), "utf8");
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
assert.doesNotMatch(appSource, /选项已过期，请刷新当前任务/u, "选项不得因为界面超时而失效");
const answerFlow = appSource.slice(appSource.indexOf("const answerNativeConversationQuestion"), appSource.indexOf("const recoverNativeConversationRuns"));
assert.match(answerFlow, /sendMessage\(instruction[\s\S]*AGENT_CHOICE_REQUIRES_RESUME/u, "服务重启后必须从同一对话检查点续接选择");
assert.match(appSource, /pending\.execution\?\.nativeAgentRunId[\s\S]{0,350}\/cancel/u, "撤回必须终止并清除对应原生 Agent 任务");
assert.match(appSource, /addEventListener\("submit", async[\s\S]{0,280}await branchFromEditedMessage/u, "编辑后的指令必须等待发布并反馈失败");
const nativeTaskCard = appSource.slice(appSource.indexOf("const renderExecutionProcess"), appSource.indexOf("const renderAssistantWaiting"));
assert.equal((nativeTaskCard.match(/renderNativeAgentEvidence\(message\)/gu) || []).length, 1, "已读取只能在原生 Agent 任务卡中渲染一次");
assert.ok(nativeTaskCard.indexOf("renderNativeAgentEvidence(message)") > nativeTaskCard.indexOf("renderCodexAgentExecutionDetails"), "已读取必须位于任务卡全部项目的最底部");
const nativeEvidence = appSource.slice(appSource.indexOf("const renderNativeAgentEvidence"), appSource.indexOf("const renderVerifiedLandedContent"));
assert.match(nativeEvidence, /hasReadableDocumentContent[\s\S]{0,260}hasSkillIdentity/u, "空文档不得仅凭标题出现在已读取中，Skill 可按真实加载身份显示");
assert.match(nativeEvidence, /item\?\.userVisible === false/u, "任务路由与运行规范等内部资料不得显示在任务卡读取清单");
assert.match(conversationGatewaySource, /sources\.push\([\s\S]{0,260}userVisible:\s*false/u, "任务路由与运行规范必须在产生读取事件前标记为内部资料");
assert.match(conversationToolsSource, /emit\("resource_read", \{ kind: "document"[\s\S]{0,260}characters: excerpt\.length/u, "Agent 真实读取正文时必须把非空读取量交给任务卡，空文档不产生读取证据");
const nativeDispatch = appSource.slice(appSource.indexOf("const executeConversationAgentMessage"), appSource.indexOf("const sendMessage"));
assert.match(nativeDispatch, /taskMessages\.push\(pending\)[\s\S]{0,500}renderNativeConversation\(runtime, true\)[\s\S]{0,300}conversationAgentRequest/u, "任意对话指令必须先出现任务卡和运行态，再请求 Agent");
console.log("Agent UI: semantic dispatch, durable question ordering, free/multiple answers and queue settings passed");
