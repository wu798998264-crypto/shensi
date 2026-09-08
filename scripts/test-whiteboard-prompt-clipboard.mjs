import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enrichWhiteboardPromptClipboardSegments, whiteboardPromptClipboardText } from "../src/whiteboard-prompt-clipboard.js";

const [appSource, richPromptSource, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/whiteboard-rich-prompt.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
assert.match(appSource, /import \{ enrichWhiteboardPromptClipboardSegments, whiteboardPromptClipboardText \} from "\.\/whiteboard-prompt-clipboard\.js"/u);
assert.match(appSource, /event\.clipboardData\.setData\("text\/plain", whiteboardPromptClipboardText\(segments\)\)/u);
assert.match(appSource, /appendWhiteboardPromptClipboardReferenceHtml\(wrapper, segments\)/u);
assert.match(appSource, /insertion \+= String\(segment\.token \?\? ""\)/u, "缺失引用粘贴时必须保留原始标记");
assert.match(appSource, /const referencesByNodeId = new Map\(\)/u, "富文本复制必须按引用出现次数逐一展开");
assert.match(appSource, /block\.style\.whiteSpace = "pre-wrap"/u, "富文本复制必须保留空格和换行");
assert.match(richPromptSource, /WHITEBOARD_RICH_PROMPT_BLOCK_TAGS = new Set\(\[/u, "生成提示词必须识别浏览器粘贴产生的块级段落");
assert.match(richPromptSource, /WHITEBOARD_RICH_PROMPT_BLOCK_TAGS\.has\(node\.tagName\)/gu, "序列化和复制都必须保留块级段落换行");
assert.match(richPromptSource, /"P", "PRE", "SECTION"/u, "常见段落、预格式和区块元素必须保留换行");
assert.match(richPromptSource, /richPromptBlockBoundary[\s\S]{0,180}endsWith\("\\n"\)/u, "嵌套块级元素不得重复制造空行");
assert.match(appSource, /const serializeWhiteboardRichPromptRaw = \(editor\) => \[\.\.\.\(editor\?\.childNodes \|\| \[\]\)\][\s\S]{0,160}\.join\(""\)/u, "序列化不能删除用户有意保留的末尾换行");
assert.match(appSource, /const renderedEditorAlreadyMatches = serializeWhiteboardRichPromptRaw\(tray\) === input\.value/u, "上限修正必须比较未截断可见内容，不能把超长编辑器误判为已同步");
assert.match(appSource, /data-whiteboard-prompt-selection-count>已选 0 字/u, "生成操作栏必须显示当前选中字数");
assert.match(appSource, /data-whiteboard-prompt-total-count>共 0 字/u, "生成操作栏必须显示提示词总字数");
assert.match(appSource, /const updateWhiteboardGenerationPromptCounts = \(form\)/u, "提示词输入和选区变化必须更新字数统计");
assert.match(appSource, /document\.addEventListener\("selectionchange", \(\) => \{[\s\S]{0,180}updateWhiteboardGenerationPromptCounts/u, "选择文本时必须实时刷新选中字数");
assert.match(styles, /\.whiteboard-generation-prompt-label[\s\S]{0,240}justify-content: space-between/u, "字数统计必须位于提示词标题行右侧");
assert.match(styles, /\.whiteboard-generation-expand\s*\{[\s\S]{0,260}aspect-ratio: 1;[\s\S]{0,120}border-radius: 50%;/u, "生成操作栏展开/收起按钮必须保持圆形");
assert.match(styles, /\.whiteboard-generation-popover > \.whiteboard-generation-expand\s*\{[\s\S]{0,320}aspect-ratio: 1;[\s\S]{0,120}border-radius: 50%;/u, "生成操作栏前景按钮必须保持圆形");

const references = [
  { id: "upstream-a", text: "人物在雨夜进入旧城。" },
  { id: "upstream-b", text: "城门外有一盏未熄的灯。" },
  { id: "empty", text: "" },
];
const source = [
  { kind: "text", text: "根据 " },
  { kind: "reference", nodeId: "upstream-a", token: "@「人物卡」" },
  { kind: "text", text: "，再结合 " },
  { kind: "reference", nodeId: "upstream-b", token: "@「场景卡」" },
  { kind: "text", text: "。" },
];
const enriched = enrichWhiteboardPromptClipboardSegments(source, { references });
assert.equal(enriched[1].content, "人物在雨夜进入旧城。");
assert.equal(enriched[3].content, "城门外有一盏未熄的灯。");
assert.equal(
  whiteboardPromptClipboardText(enriched),
  "根据 @「人物卡」\n【已插入参考内容】\n人物在雨夜进入旧城。，再结合 @「场景卡」\n【已插入参考内容】\n城门外有一盏未熄的灯。。",
);

const duplicate = enrichWhiteboardPromptClipboardSegments([
  { kind: "text", text: " 前缀\n" },
  { kind: "reference", nodeId: "upstream-a", token: "@「人物卡」" },
  { kind: "text", text: " /  " },
  { kind: "reference", nodeId: "upstream-a", token: "@「人物卡」" },
  { kind: "text", text: "  后缀\n" },
], { references: [{ id: "upstream-a", text: "  人物在雨夜进入旧城。\n\n" }] });
assert.equal(duplicate[1].content, "  人物在雨夜进入旧城。\n\n", "引用正文必须保留原始空格和换行");
assert.equal(duplicate[3].content, "  人物在雨夜进入旧城。\n\n", "同一引用的每一次出现都必须展开正文");
assert.equal(
  whiteboardPromptClipboardText(duplicate),
  " 前缀\n@「人物卡」\n【已插入参考内容】\n  人物在雨夜进入旧城。\n\n /  @「人物卡」\n【已插入参考内容】\n  人物在雨夜进入旧城。\n\n  后缀\n",
  "复制文本必须保持原顺序、重复次数和排版",
);

const missing = enrichWhiteboardPromptClipboardSegments([
  { kind: "reference", nodeId: "unknown", token: "@「失效引用」" },
  { kind: "reference", nodeId: "empty", token: "@「空引用」" },
], { references });
assert.equal(whiteboardPromptClipboardText(missing), "@「失效引用」@「空引用」");

const whitespaceOnly = enrichWhiteboardPromptClipboardSegments([
  { kind: "reference", nodeId: "whitespace", token: "@「空白卡」" },
], { references: [{ id: "whitespace", text: "  \n" }] });
assert.equal(whitespaceOnly[0].content, "  \n", "只有空白的引用正文也不能被裁剪");
assert.equal(whiteboardPromptClipboardText(whitespaceOnly), "@「空白卡」\n【已插入参考内容】\n  \n");

const media = enrichWhiteboardPromptClipboardSegments([
  { kind: "reference", nodeId: "image-a", token: "@「图片1」" },
], { references: [{ id: "image-a", kind: "image", name: "参考图" }], contentForNode: () => "" });
assert.equal(media[0].content, undefined, "媒体引用没有可复制的正文时应保留引用标记");
assert.equal(whiteboardPromptClipboardText(media), "@「图片1」");

console.log("白板提示词连带参考复制契约测试通过");
