import assert from "node:assert/strict";
import {
  WHITEBOARD_RICH_PROMPT_MAX_CHARACTERS,
  serializeWhiteboardRichPromptBeforePoint,
  serializeWhiteboardRichPromptNode,
  whiteboardPromptAtomicDropOffset,
  whiteboardPromptReferenceIdentityMatches,
  whiteboardPromptReferenceSequenceAfterInsertion,
  whiteboardPromptReferenceSequenceAfterReplacement,
} from "../src/whiteboard-rich-prompt.js";
import { normalizeWhiteboardGenerationDraftCache, updateWhiteboardGenerationDraftCache, whiteboardGenerationDraftKey } from "../src/whiteboard-generation-draft.js";

const text = (data) => ({ nodeType: 3, data, childNodes: [], parentNode: null });
const element = (tagName, children = [], dataset = {}) => {
  const node = {
    nodeType: 1,
    tagName,
    childNodes: children,
    dataset,
    parentNode: null,
    matches(selector) {
      return selector === "[data-rich-mention-token]" && Boolean(this.dataset.richMentionToken);
    },
    contains(target) {
      return this === target || this.childNodes.some((child) => child === target || child.contains?.(target));
    },
  };
  children.forEach((child) => { child.parentNode = node; });
  return node;
};

const previousText = text("上一段");
const currentText = text("带格式内容@");
const previousParagraph = element("P", [previousText]);
const currentParagraph = element("P", [currentText]);
const editor = element("DIV", [previousParagraph, currentParagraph]);

assert.equal(serializeWhiteboardRichPromptNode(editor), "上一段\n带格式内容@\n", "完整序列化必须保留粘贴段落边界");
const beforeCaret = serializeWhiteboardRichPromptBeforePoint(editor, currentText, currentText.data.length);
assert.equal(beforeCaret, "上一段\n带格式内容@", "光标前文本不能附加当前富文本段落的虚拟换行");
assert.match(beforeCaret, /@([^@\s]*)$/u, "带格式粘贴后输入 @ 必须仍能触发引用候选");

const br = element("BR");
const afterBreak = text("@");
const lineParagraph = element("P", [text("同段上一行"), br, afterBreak]);
const lineEditor = element("DIV", [lineParagraph]);
assert.equal(
  serializeWhiteboardRichPromptBeforePoint(lineEditor, afterBreak, 1),
  "同段上一行\n@",
  "真实换行必须保留，同时不能混入当前段落的虚拟结尾",
);

assert.equal(
  serializeWhiteboardRichPromptBeforePoint(editor, editor, 1),
  "上一段\n",
  "光标位于两个富文本段落之间时必须保留上一完整段落的边界",
);

const mention = element("SPAN", [text("不应序列化的显示名")], { richMentionToken: "@「人物设定」" });
const mentionTail = text("继续@");
const mentionParagraph = element("P", [mention, mentionTail]);
const mentionEditor = element("DIV", [mentionParagraph]);
assert.equal(
  serializeWhiteboardRichPromptBeforePoint(mentionEditor, mentionTail, mentionTail.data.length),
  "@「人物设定」继续@",
  "已有引用必须保持原子 token，后续 @ 仍可继续触发",
);

const occurrences = [
  { id: "reference-a", start: 4, end: 10 },
  { id: "reference-b", start: 14, end: 20 },
];
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterInsertion(occurrences, 0, 1, "reference-c"),
  ["reference-c", "reference-a", "reference-b"],
  "在第一个引用前插入时，新引用身份必须同步插到序列首位",
);
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterInsertion(occurrences, 12, 12, "reference-c"),
  ["reference-a", "reference-c", "reference-b"],
  "在两个引用之间插入时，选择内容与引用身份必须保持同一位置",
);
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterInsertion(occurrences, 2, 16, "reference-c"),
  ["reference-c"],
  "替换跨引用选区时，被覆盖的旧引用身份不得残留或挤占新引用",
);

let stressPrompt = "前置描述".repeat(700);
let stressOccurrences = [];
let stressSequence = [];
for (let index = 1; index <= 50; index += 1) {
  const nodeId = `reference-${index}`;
  stressSequence = whiteboardPromptReferenceSequenceAfterInsertion(
    stressOccurrences,
    stressPrompt.length,
    stressPrompt.length,
    nodeId,
  );
  const token = `@「图片${index}」 `;
  const start = stressPrompt.length;
  stressPrompt += token;
  stressOccurrences = [
    ...stressOccurrences,
    { id: nodeId, start, end: start + token.trimEnd().length },
  ];
}
assert.ok(stressPrompt.length > 3000 && stressPrompt.length < WHITEBOARD_RICH_PROMPT_MAX_CHARACTERS, "大量插入测试必须跨过旧 3000 字符截断点");
assert.deepEqual(stressSequence, Array.from({ length: 50 }, (_, index) => `reference-${index + 1}`), "大量连续插入后每个显示序号仍须绑定原节点 ID");
assert.equal(whiteboardPromptReferenceIdentityMatches(stressSequence, [...stressSequence]), true, "完全一致的节点身份序列应通过重建复用检查");
assert.equal(whiteboardPromptReferenceIdentityMatches(stressSequence, [...stressSequence.slice(0, 20), "reference-50", ...stressSequence.slice(21)]), false, "显示 token 相同但节点 ID 错位时必须强制重建");
assert.equal(whiteboardPromptAtomicDropOffset({ start: 120, end: 128, clientX: 210, left: 200, width: 40 }), 120, "拖到原子引用左半侧必须落在整个引用之前");
assert.equal(whiteboardPromptAtomicDropOffset({ start: 120, end: 128, clientX: 231, left: 200, width: 40 }), 128, "拖到原子引用右半侧必须落在整个引用之后");
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterReplacement(occurrences, 12, 12, [
    { id: "reference-c", start: 5, end: 10 },
    { id: "reference-d", start: 1, end: 4 },
  ]),
  ["reference-a", "reference-d", "reference-c", "reference-b"],
  "一次粘贴多个引用时必须按粘贴内容中的真实出现顺序插入稳定节点 ID",
);

const longDraftScope = { workspaceId: "workspace", documentId: "whiteboard", nodeId: "target", channel: "image" };
const longDraftPrompt = `${"长提示词".repeat(900)}${Array.from({ length: 50 }, (_, index) => `@「图片${index + 1}」`).join("")}`;
const longDraftSequence = Array.from({ length: 50 }, (_, index) => `reference-${index + 1}`).join(",");
const longDraft = updateWhiteboardGenerationDraftCache({}, longDraftScope, {
  prompt: longDraftPrompt,
  promptReferenceSequence: longDraftSequence,
});
const restoredLongDraft = normalizeWhiteboardGenerationDraftCache(JSON.parse(JSON.stringify(longDraft)));
const longDraftValues = restoredLongDraft.entries[whiteboardGenerationDraftKey(longDraftScope)].values;
assert.equal(longDraftValues.prompt, longDraftPrompt, "超过旧 3000 字符边界的提示词必须完整保存并恢复");
assert.equal(longDraftValues.promptReferenceSequence, longDraftSequence, "长提示词恢复时必须保留每个引用的稳定节点 ID");

console.log("白板富文本粘贴后的 @ 引用触发与插入偏移测试通过");
