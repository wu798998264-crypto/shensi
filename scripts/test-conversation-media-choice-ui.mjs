import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [app, styles, tools, service] = await Promise.all([
  read("src/app.js"),
  read("src/styles.css"),
  read("src/server/conversation-agent-tools.mjs"),
  read("src/server/conversation-agent-service.mjs"),
]);

const sendStart = app.indexOf("const sendMessage = async");
const sendEnd = app.indexOf("const selectedChatMessageText", sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, "统一对话发送入口必须存在");
const sendSource = app.slice(sendStart, sendEnd);
assert.match(sendSource, /executeConversationAgentMessage\(content/u,
  "图片和视频要求必须先原样交给统一 Agent");
assert.doesNotMatch(sendSource, /decideConversationMediaRoute|generateMediaFromComposer|generateImageFromComposer/u,
  "普通对话入口不得按媒体关键词切换到固定前端向导");

assert.match(tools, /图片\/视频通过 media\.generate 调用当前生成能力/u);
assert.match(tools, /缺配置时使用对应列表第一项，图片2K\/高清、视频720p/u,
  "未指定配置和清晰度时必须采用约定默认值");
assert.match(tools, /视频没有明确时长时只确认时长/u,
  "视频参数缺失时只能补问时长，不能强制固定配置向导");
assert.match(tools, /tool\("generate", "使用既有后台媒体生成服务/u,
  "Agent 必须通过持久化媒体任务工具执行生成");

assert.match(service, /choiceInteractionInstructions[\s\S]{0,700}不要用正文关键词、编号或固定模板推断选择框/u,
  "动态选择框必须来自 Agent 的真实选择问题");
assert.match(app, /messages\.some\(\(message\) => message\.id === id\)[\s\S]{0,240}conversationChoiceQuestion:\s*true/u,
  "问题文字必须先进入对话记录");
assert.match(app, /await persistNativeConversation\(runtime\);[\s\S]{0,650}renderConversationChoicePanel\(\)/u,
  "选择框只能在问题消息持久化并渲染后显示");
assert.match(app, /也可以直接在下方对话输入区说明你的想法；发送后选项会自动隐藏/u,
  "选择框必须保留自由输入提示");
const answerStart = app.indexOf("const answerNativeConversationQuestion = async");
const answerEnd = app.indexOf("const recoverNativeConversationRuns", answerStart);
assert.ok(answerStart >= 0 && answerEnd > answerStart, "Agent 选择回答处理器必须存在");
assert.match(app.slice(answerStart, answerEnd), /Agent 正在继续处理/u,
  "确认选项后必须恢复运行状态并继续同一 Agent 任务");
assert.match(styles, /\.conversation-choice-actions\s*\{[\s\S]{0,180}justify-content:\s*flex-end/u,
  "选择确认操作必须位于选项区右侧");

console.log("Conversation media uses unified Agent routing and dynamic missing-parameter choices");
