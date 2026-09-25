import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const service = await readFile(new URL("../src/server/conversation-agent-service.mjs", import.meta.url), "utf8");

assert.match(
  app,
  /const answerLiveNativeConversationQuestion = async \(question, answer\)[\s\S]{0,3600}registerAgentTaskRuntime\(\{/u,
  "权限选择必须能从已持久化的任务卡恢复运行上下文",
);
assert.match(app, /正在提交选择，Agent 将继续处理/u, "确认选择后必须显示提交中状态");
assert.match(app, /选择提交失败：/u, "确认失败必须显示中文原因");
assert.match(app, /nativeConversationQuestionRequiresLiveRun\(question\)[\s\S]{0,180}answerLiveNativeConversationQuestion/u, "权限和网页登录确认必须继续当前受控运行");
assert.match(app, /const answerNativeConversationQuestion = async \(question, answer\)[\s\S]{0,4200}conversationAgentRequest\(`\/api\/conversation-agent\/\$\{runId\}\/cancel`[\s\S]{0,500}dispatchComposerContent\(normalizedAnswer/u, "普通选择必须结束旧运行并作为新的持久化用户指令继续");
assert.match(app, /conversationChoiceInstruction:\s*true/u, "选择生成的新指令必须在对话记录中标记来源");
assert.match(app, /if \(!selectedValues\.length\)[\s\S]{0,120}请先选择一个选项/u, "未选择选项时必须明确提示");
assert.match(app, /pendingConversationChoice\.submitting === true\) return/u, "提交期间重复点击不得重复回答任务");
assert.match(app, /disabled: submitting \|\| !pending\.selectedValues\?\.length/u, "提交期间确认按钮必须暂时禁用");
assert.match(service, /kind:\s*"conversation_choice"[\s\S]{0,80}durable:\s*true/u, "普通 Agent 选择必须声明为可持久恢复的对话选择");

console.log("native choice confirmation resilience checks passed");
