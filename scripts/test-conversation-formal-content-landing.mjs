import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { hasFormalAssetWriteIntent } from "../src/artifact-ontology.js";
import {
  explicitConversationWriteOperation,
  resolveConversationFormalContentReference,
} from "../src/conversation-formal-content.js";
import { FORMAL_CONTENT_MODULE_IDS, formalDocumentContentPolicy } from "../src/formal-content-policy.js";
import { authorizeFormalMutation } from "../src/formal-mutation-permission.js";
import { MODULE_ITEMS } from "../src/data.js";

const assistantContent = [
  "第一段说明背景。",
  "第二段是需要写入的正式文字，包含唯一锚点。",
  "第三段给出后续安排。",
].join("\n\n");
const messages = [
  { id: "assistant-source", role: "assistant", content: assistantContent },
  { id: "assistant-choice", role: "assistant", content: "请选择具体段落", conversationChoiceQuestion: true },
];

const second = resolveConversationFormalContentReference({ instruction: "把上面第2段写入当前文档", messages });
assert.equal(second.status, "resolved");
assert.equal(second.content, "第二段是需要写入的正式文字，包含唯一锚点。");
assert.equal(second.sourceMessageId, "assistant-source", "选择框问题不得抢走上文正式内容来源");

const last = resolveConversationFormalContentReference({ instruction: "将上面最后一段追加到当前文档末尾", messages });
assert.equal(last.content, "第三段给出后续安排。");
assert.equal(last.operation, "append");

const anchored = resolveConversationFormalContentReference({ instruction: "把上面包含“唯一锚点”的那段覆盖到当前文档", messages });
assert.equal(anchored.status, "resolved");
assert.equal(anchored.blockIndex, 1);
assert.equal(anchored.operation, "replace");

const ambiguous = resolveConversationFormalContentReference({ instruction: "把上面某段写入当前文档", messages });
assert.equal(ambiguous.status, "ambiguous");
assert.deepEqual(ambiguous.options.map((option) => option.content), [assistantContent, ...assistantContent.split("\n\n")]);

const screenshotInstruction = resolveConversationFormalContentReference({ instruction: "将以上内容落盘到对应文档末尾", messages });
assert.equal(screenshotInstruction.status, "ambiguous", "仅用以上内容指代时必须要求用户确认具体范围");
assert.equal(screenshotInstruction.operation, "append", "落盘到文档末尾必须识别为追加");
assert.equal(screenshotInstruction.options[0].label, "上一条完整回复");
assert.equal(screenshotInstruction.options[0].content, assistantContent);

const whole = resolveConversationFormalContentReference({ instruction: "把你上面的完整回复写入当前文档", messages });
assert.equal(whole.status, "resolved");
assert.equal(whole.content, assistantContent);

const historicalMessages = [
  { id: "assistant-1", role: "assistant", time: "10:01", content: "早期第一段。\n\n早期第二段含有跨轮唯一原句。" },
  { id: "user-between", role: "user", content: "继续" },
  { id: "assistant-2", role: "assistant", time: "10:02", content: "中间第一段。\n\n中间第二段。" },
  { id: "assistant-3", role: "assistant", time: "10:03", content: assistantContent },
];
const firstReplySecondParagraph = resolveConversationFormalContentReference({
  instruction: "把第1条 AI 回复第2段追加到当前文档末尾",
  messages: historicalMessages,
});
assert.equal(firstReplySecondParagraph.status, "resolved");
assert.equal(firstReplySecondParagraph.sourceMessageId, "assistant-1");
assert.equal(firstReplySecondParagraph.content, "早期第二段含有跨轮唯一原句。");
const reverseReply = resolveConversationFormalContentReference({
  instruction: "把倒数第2条 AI 回复的完整回复写入当前文档",
  messages: historicalMessages,
});
assert.equal(reverseReply.sourceMessageId, "assistant-2");
assert.equal(reverseReply.content, "中间第一段。\n\n中间第二段。");
const crossReplyAnchor = resolveConversationFormalContentReference({
  instruction: "把上面包含“跨轮唯一原句”的内容写入当前文档",
  messages: historicalMessages,
});
assert.equal(crossReplyAnchor.sourceMessageId, "assistant-1");
assert.equal(crossReplyAnchor.content, "早期第二段含有跨轮唯一原句。");
assert.equal(resolveConversationFormalContentReference({ instruction: "分析一下这些内容", messages }).status, "not_requested");
assert.equal(explicitConversationWriteOperation("把上面内容写入当前文档"), "", "未明确追加或覆盖时必须交给用户确认");
assert.equal(explicitConversationWriteOperation("把上面内容追加到当前文档"), "append");

assert.equal(hasFormalAssetWriteIntent("把上面第二段写入当前文档"), true, "当前文档必须属于正式内容目标");
assert.equal(hasFormalAssetWriteIntent("把上面内容写入索引中的指定文档"), true, "索引文档必须属于正式内容目标");
assert.equal(hasFormalAssetWriteIntent("我想写一个故事，但还没决定题材；请只问我一个问题，不生成正文，也不要创建或修改任何文档。"), false, "多处分句明确禁止写入时不得取得正式写入授权");
assert.equal(hasFormalAssetWriteIntent("只讨论当前设定，不生成正文。"), false, "单独否定生成正文不得取得正式写入授权");

for (const moduleId of FORMAL_CONTENT_MODULE_IDS) {
  const policy = formalDocumentContentPolicy({ documentId: `${moduleId}-custom-document`, moduleId });
  assert.equal(policy.formal, true, `${moduleId} 板块中的实际文档必须定义对应正式内容`);
}
const canonicalModules = new Map();
for (const [moduleId, items] of Object.entries(MODULE_ITEMS)) {
  for (const [documentId] of items) if (!canonicalModules.has(documentId)) canonicalModules.set(documentId, moduleId);
}
for (const [documentId, moduleId] of canonicalModules) {
  assert.equal(formalDocumentContentPolicy({ documentId, moduleId }).formal, true, `${documentId} 必须具备正式内容定义`);
}
assert.equal(formalDocumentContentPolicy({ documentId: "library-reference", moduleId: "library" }).directWrite, true);
assert.equal(formalDocumentContentPolicy({ documentId: "index-custom-note", moduleId: "index" }).directWrite, true);
assert.equal(formalDocumentContentPolicy({ documentId: "memory-snapshot", moduleId: "memory" }).mode, "memory_projection");
assert.equal(formalDocumentContentPolicy({ documentId: "report-compile", moduleId: "reports" }).mode, "runtime_projection");
assert.equal(formalDocumentContentPolicy({ documentId: "report-novel", moduleId: "reports" }).mode, "review_report");

const explicitPlan = (documentId, moduleId) => ({ primaryTargets: [{ documentId, moduleId }] });
assert.equal(authorizeFormalMutation({
  instruction: "把上面的完整内容写入当前文档",
  plan: explicitPlan("library-reference", "library"),
  targets: [{ documentId: "library-reference", moduleId: "library" }],
}).ok, true, "资料库普通文档必须允许明确正式内容写入");
assert.equal(authorizeFormalMutation({
  instruction: "把上面的完整内容写入当前文档",
  plan: explicitPlan("index-custom-note", "index"),
  targets: [{ documentId: "index-custom-note", moduleId: "index" }],
}).ok, true, "索引中的普通自建文档必须允许明确正式内容写入");
assert.equal(authorizeFormalMutation({
  instruction: "把上面的完整内容写入当前文档",
  plan: explicitPlan("memory-snapshot", "memory"),
  targets: [{ documentId: "memory-snapshot", moduleId: "memory" }],
}).ok, false, "记忆投影必须继续使用专用写入规则");
assert.equal(authorizeFormalMutation({
  instruction: "把上面的完整内容写入当前文档",
  plan: explicitPlan("report-compile", "reports"),
  targets: [{ documentId: "report-compile", moduleId: "reports" }],
}).ok, false, "只读项目总览不得被普通对话覆盖");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /resolveConversationFormalContentReference\(\{ instruction: command, messages \}\)/u, "纯落盘必须先解析明确指向的上文内容");
assert.match(app, /kind: "formal_content_reference"/u, "模糊上文引用必须进入对话选择框");
assert.match(app, /当前没有唯一识别到有效的正式内容。你要写入哪一部分/u, "未唯一识别时必须主动询问用户指定内容");
assert.match(app, /将上面第 2 段追加到对应文档末尾/u, "澄清选择框必须给出精确表达示例");
assert.match(app, /conversationFormalContentInstruction/u, "确认后的上文内容必须绑定本次写入指令");
assert.match(app, /if \(!pending\.conversationFormalContentReference\) delete target\.creativeMutationPlan/u, "上文正式内容选择确认后必须保留精确目标计划");
assert.match(app, /当前没有识别到可直接写入的正式内容。请说明要写入哪条回复或哪一段/u, "无正式内容时必须主动询问用户指定写入内容");
assert.doesNotMatch(app, /本轮候选只包含对话说明/u);
assert.doesNotMatch(app, /当前候选缺少可校验的来源授权/u);
assert.doesNotMatch(app, /Agent 已按要求保留候选稿，本轮不落盘/u, "Agent 单稿暂不落盘不得混用候选稿术语");
assert.doesNotMatch(app, /Agent 候选(?:已经|已)/u, "Agent 单稿恢复与失败提示不得混用候选术语");

console.log("Conversation formal-content reference landing tests passed");
