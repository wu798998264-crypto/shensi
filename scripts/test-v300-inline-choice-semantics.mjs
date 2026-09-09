import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assistantChoicePrompt,
  conversationChoiceUserInstruction,
} from "../src/conversation-choice-panel.js";

const instruction = conversationChoiceUserInstruction({ label: "科幻", value: "science-fiction" });
assert.equal(instruction, "科幻");
assert.equal(typeof instruction, "string", "选项只能产生普通文字指令");

const inferred = assistantChoicePrompt("你希望从哪里开始？\n- 从零开始\n- 先补充资料");
assert.equal(inferred, null, "前端不得再根据回复文本自动推断选择题");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /conversation-choice-hint[^>]*>也可以直接在下方对话输入区/u, "选项下方必须提示可直接输入自定义意见");
assert.doesNotMatch(app, /conversationChoiceInstruction[^\n]{0,200}(?:writeAuthorization|landingAuthorization|commit)/u, "点选不得携带特殊写入权限");
assert.match(app, /if \(pendingConversationChoice\)[\s\S]{0,180}closeConversationChoicePanel/u, "用户自定义输入后必须自动隐藏当前选项框");
assert.doesNotMatch(app, /writer_count|writer_counts|确认主笔|单主笔生成多稿|多主笔生成候选/u,
  "选项面板不得再含固定主笔或数量状态机");

console.log("Shensi v3.0 inline choice semantics tests passed");
