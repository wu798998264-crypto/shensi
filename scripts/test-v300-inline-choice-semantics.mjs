import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assistantChoicePrompt,
  conversationChoiceOverrideFromInstruction,
  conversationChoiceUserInstruction,
  supersedeConversationChoiceInstructions,
} from "../src/conversation-choice-panel.js";

assert.deepEqual(conversationChoiceOverrideFromInstruction("不用单主笔了，改为多主笔"), { writerMode: "multiple" });
assert.deepEqual(conversationChoiceOverrideFromInstruction("改为单主笔生成三份"), { writerMode: "single", candidateCount: 3 });
assert.deepEqual(conversationChoiceOverrideFromInstruction("还是续写下一章"), { continuationDestination: "next" });

const messages = [
  { id: "old-mode", role: "user", content: "单主笔生成多稿", conversationChoiceInstruction: true, contextEligible: true },
  { id: "old-count", role: "user", content: "生成 2 份候选稿", conversationChoiceInstruction: true, contextEligible: true },
  { id: "question", role: "assistant", content: "要怎样继续？", conversationChoiceQuestion: true, contextEligible: true },
];
const superseded = supersedeConversationChoiceInstructions(messages, "改为多主笔，每位生成3份");
assert.equal(superseded[0].choiceSuperseded, true, "最新主笔模式必须使旧模式失效");
assert.equal(superseded[1].choiceSuperseded, true, "最新数量必须使旧数量失效");
assert.equal(superseded[2].choiceSuperseded, undefined, "问题本身仍保留在对话中");

const instruction = conversationChoiceUserInstruction({ label: "科幻", value: "science-fiction" });
assert.equal(instruction, "科幻");
assert.equal(typeof instruction, "string", "选项只能产生普通文字指令");

const inferred = assistantChoicePrompt("你希望从哪里开始？\n- 从零开始\n- 先补充资料");
assert.equal(inferred, null, "前端不得再根据回复文本自动推断选择题");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /conversation-choice-hint[^>]*>也可以直接在下方对话输入区/u, "选项下方必须提示可直接输入自定义意见");
assert.doesNotMatch(app, /conversationChoiceInstruction[^\n]{0,200}(?:writeAuthorization|landingAuthorization|commit)/u, "点选不得携带特殊写入权限");
assert.match(app, /if \(pendingConversationChoice\)[\s\S]{0,180}closeConversationChoicePanel/u, "用户自定义输入后必须自动隐藏当前选项框");

console.log("Shensi v3.0 inline choice semantics tests passed");
