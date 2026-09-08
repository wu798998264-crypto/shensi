import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  whiteboardPromptReferenceReplacementIsSafe,
  whiteboardPromptReferenceSequenceAfterReplacement,
} from "../src/whiteboard-rich-prompt.js";
import {
  normalizeWhiteboardGenerationDraftCache,
  updateWhiteboardGenerationDraftCache,
  whiteboardGenerationDraftKey,
} from "../src/whiteboard-generation-draft.js";

const occurrences = [
  { id: "reference-a", start: 0, end: 6 },
  { id: "reference-b", start: 10, end: 16 },
  { id: "reference-a", start: 20, end: 26 },
  { id: "reference-d", start: 30, end: 36 },
];

assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterReplacement(occurrences, 0, 6, [{ id: "reference-x", start: 0, end: 6 }]),
  ["reference-x", "reference-b", "reference-a", "reference-d"],
  "替换第一个引用时不得改变后续引用顺序",
);
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterReplacement(occurrences, 10, 16, [{ id: "reference-x", start: 0, end: 6 }]),
  ["reference-a", "reference-x", "reference-a", "reference-d"],
  "替换中间引用时必须保留前后两侧及重复引用",
);
const duplicateReplacement = whiteboardPromptReferenceSequenceAfterReplacement(
  occurrences,
  20,
  26,
  [{ id: "reference-c", start: 0, end: 6 }],
);
assert.deepEqual(
  duplicateReplacement,
  ["reference-a", "reference-b", "reference-c", "reference-d"],
  "同一参考出现多次时只能替换右键选中的那个实例",
);
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterReplacement(occurrences, 30, 36, [{ id: "reference-x", start: 0, end: 6 }]),
  ["reference-a", "reference-b", "reference-a", "reference-x"],
  "替换最后一个引用时不得改变前面的顺序与重复次数",
);

const expected = {
  prompt: "开头@「图片1」中间@「图片1」结尾",
  targetNodeId: "target-card",
  documentId: "whiteboard-document",
  workspaceId: "workspace-project",
  occurrenceIndex: 1,
  occurrence: { id: "reference-a", start: 12, end: 20, token: "@「图片1」" },
  beforeAnchor: "开头@「图片1」中间",
  afterAnchor: "结尾",
  referenceIds: ["reference-a", "reference-a"],
};
assert.equal(
  whiteboardPromptReferenceReplacementIsSafe(expected, structuredClone(expected)),
  true,
  "文本、目标、锚点和引用身份都未变化时才允许替换",
);
assert.equal(
  whiteboardPromptReferenceReplacementIsSafe(expected, { ...structuredClone(expected), prompt: `${expected.prompt}已变化` }),
  false,
  "菜单打开后提示词变化必须停止替换",
);
assert.equal(
  whiteboardPromptReferenceReplacementIsSafe(expected, { ...structuredClone(expected), referenceIds: ["reference-a", "reference-b"] }),
  false,
  "重复引用身份发生变化时不能按显示名称猜测目标",
);
assert.equal(
  whiteboardPromptReferenceReplacementIsSafe(expected, {
    ...structuredClone(expected),
    occurrence: { ...expected.occurrence, start: expected.occurrence.start + 1 },
  }),
  false,
  "右键目标位置失效时必须保留原文并停止写入",
);

const scope = { workspaceId: "workspace-project", documentId: "whiteboard-document", nodeId: "target-card", channel: "image" };
const replacedPrompt = "@「图片1」说明@「图片3」结尾@「图片4」";
const cache = updateWhiteboardGenerationDraftCache({}, scope, {
  prompt: replacedPrompt,
  promptReferenceSequence: duplicateReplacement.join(","),
  referenceOrder: "reference-a,reference-b,reference-c,reference-d",
});
const restored = normalizeWhiteboardGenerationDraftCache(JSON.parse(JSON.stringify(cache)));
const values = restored.entries[whiteboardGenerationDraftKey(scope)].values;
assert.equal(values.prompt, replacedPrompt, "替换后的显示文本必须完整保存和回读");
assert.equal(values.promptReferenceSequence, duplicateReplacement.join(","), "回读后每次引用出现仍须绑定原来的稳定节点身份");
assert.equal(values.referenceOrder, "reference-a,reference-b,reference-c,reference-d", "替换输入框引用不得改动顶部参考顺序");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /editor\?\.addEventListener\("contextmenu",[\s\S]{0,500}openWhiteboardGenerationMentionReplacementMenu\(form, mention\)/u, "右键引用芯片必须打开同一引用选择器");
assert.match(appSource, /menu\.dataset\.referenceReplacement = "true"[\s\S]{0,260}whiteboardGenerationMentionOptionsMarkup/u, "替换模式必须复用 @ 引用候选项");
assert.match(appSource, /选择新的参考，其他引用顺序保持不变/u, "替换候选必须明确只替换当前项");
assert.match(appSource, /whiteboardPromptReferenceReplacementIsSafe\(replacement, current\)[\s\S]{0,220}原内容未修改/u, "目标失效时必须明确停止且保留原内容");
assert.match(appSource, /whiteboardPromptReferenceSequenceAfterReplacement\([\s\S]{0,420}currentRange\.start[\s\S]{0,160}node\.id/u, "替换必须按目标实例范围更新稳定身份序列");
assert.match(appSource, /form\._whiteboardMentionReplacement\) replaceWhiteboardGenerationMention\(form, nodeId\)/u, "候选点击必须区分插入与替换模式");
assert.match(appSource, /closeWhiteboardGenerationMentionMenu\(form\)[\s\S]{0,260}clearWhiteboardGenerationMentionReplacement/u, "取消或关闭选择框必须清除旧替换目标");
const replaceFunction = appSource.match(/const replaceWhiteboardGenerationMention = \(form, nodeId\) => \{[\s\S]*?\n\};/u)?.[0] || "";
assert.match(replaceFunction, /input\.setRangeText\(token, currentRange\.start, currentRange\.end, "end"\)/u, "替换只能写入右键引用的字符范围");
assert.doesNotMatch(replaceFunction, /writeWhiteboardGenerationReferenceOrder|reorderCanvasIncomingEdges|addCanvasEdge/u, "替换输入框引用不得重排顶部参考或修改连线");

console.log("白板右键替换参考、稳定身份、取消保护与草稿回读测试通过");
