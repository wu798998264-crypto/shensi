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

assert.match(appSource, /pendingDecision:\s*clone\(payload\.pendingDecision \?\? engineExecution\?\.pendingDecision \?\? null\)/u,
  "模型返回的待决定合同必须进入前端回复元数据");
assert.match(appSource, /const pendingAgentDecision = isAgentDecision\(rawReply\?\.pendingDecision\)[\s\S]{0,420}openAgentDecisionDialog\(\{[\s\S]{0,260}if \(!pendingAgentDecision && Array\.isArray\(generalChoices\)/u,
  "Agent 决定卡必须优先于旧创作选项卡，不能被同一响应的 choiceOptions 抢占");
assert.match(appSource, /pendingConversationChoice\.kind === "agent_decision" && type === "agent_decision"[\s\S]{0,500}agentDecisionResolutionForOption\(\{ decision: pending\.decision, option \}\)[\s\S]{0,360}dispatchComposerContent\(option\.label, \{ conversationId, decisionResolution \}\)/u,
  "点击决定选项必须回传服务端签发合同，而不是发送一条无归属普通消息");

const dispatchStart = appSource.indexOf("const dispatchComposerContent =");
const dispatchEnd = appSource.indexOf("let agentProfileChoiceContext", dispatchStart);
const dispatchSource = appSource.slice(dispatchStart, dispatchEnd);
assert.match(dispatchSource, /decisionResolution = null/u);
assert.match(dispatchSource, /const normalizedDecisionResolution = normalizeAgentDecisionResolution\(decisionResolution\)/u);
assert.match(dispatchSource, /if \(normalizedDecisionResolution\)[\s\S]{0,420}sendMessage\(content,[\s\S]{0,260}decisionResolution: normalizedDecisionResolution/u,
  "决定回答必须绕过关键词型本地快捷分支，直接进入统一 Agent");
assert.match(appSource, /currentAssociationSnapshot\.taskId = String\(decisionResolution\?\.taskId \|\| submittedTaskContextSnapshot\.taskId \|\| ""\)\s*\|\|/u,
  "点击 Agent 选项后必须沿用原任务编号，不能建立第二个任务");

const submitStart = appSource.indexOf('document.querySelector("#chatForm").addEventListener("submit"');
const submitEnd = appSource.indexOf("const finalizeTemporaryCodexLogin", submitStart);
const submitSource = appSource.slice(submitStart, submitEnd);
assert.match(submitSource, /agentDecisionResolutionForAnswer\(\{ decision: pendingAgentDecision\.decision, answer: content \}\)/u);
assert.match(submitSource, /dispatchComposerContent\(content, \{[\s\S]{0,180}decisionResolution/u,
  "输入框自然语言回答必须绑定当前决定合同");

const queueStart = appSource.indexOf("const enqueueMessage =");
const queueEnd = appSource.indexOf("const updateQueuedMessage =", queueStart);
const queueSource = appSource.slice(queueStart, queueEnd);
assert.match(queueSource, /inlineEdit \|\| runtimeSupplement \|\| normalizedDecisionResolution[\s\S]{0,1800}decisionResolution: normalizedDecisionResolution/u,
  "决定回答排队时必须持久化合同，且不能被内容关键词误建为媒体任务");
assert.doesNotMatch(queueSource, /isConversationSkillInstallRequest|isSelfRepairRequest|queuedSpecialOperation/u,
  "任何排队指令都必须先进入统一 Agent，不能被安装或自修复关键词截走");
assert.match(appSource, /taskContextSnapshot: options\.taskContextSnapshot,[\s\S]{0,80}decisionResolution: options\.decisionResolution \?\? null/u,
  "并发竞争转入队列时必须保留决定合同");
assert.match(appSource, /decisionResolution: normalizeAgentDecisionResolution\(decisionResolution\)/u,
  "最终 API 请求必须携带经过规范化的决定合同");

console.log("agent decision UI integration tests passed");
