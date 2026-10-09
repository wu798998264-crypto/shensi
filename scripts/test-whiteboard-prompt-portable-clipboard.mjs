import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enrichWhiteboardPromptClipboardSegments, parseWhiteboardPromptClipboardPayload, hasWhiteboardPromptClipboardHtml } from "../src/whiteboard-prompt-clipboard.js";

const references = [{ id: "image", kind: "image", width: 320, height: 180,
  file: { relativePath: "media/sample.png", name: "sample.png", mimeType: "image/png", size: 30 },
  generation: { apiKey: "do-not-copy", status: "running" } }];
const segments = enrichWhiteboardPromptClipboardSegments([
  { kind: "text", text: "  前文\n" }, { kind: "reference", nodeId: "image", token: "@「图片1」" },
  { kind: "text", text: "后文" }, { kind: "reference", nodeId: "image", token: "@「图片1」" },
], { references, source: { workspacePath: "test-workspace", documentId: "board-a" } });
assert.equal(segments[1].reference.file.relativePath, "media/sample.png");
assert.equal(segments[1].reference.documentId, "board-a");
const canvasSegments = enrichWhiteboardPromptClipboardSegments([{ kind: "reference", nodeId: "image", token: "@「图片1」" }], {
  references: [{ id: "image", kind: "image", file: "media/real-canvas.png", name: "real-canvas.png", mimeType: "image/png" }],
});
assert.equal(canvasSegments[0].reference.file.relativePath, "media/real-canvas.png", "真实白板的字符串文件路径也必须保留");
assert.ok(!JSON.stringify(segments).includes("do-not-copy"), "只复制引用的文件身份，不复制配置、凭证或生成状态");
assert.deepEqual(parseWhiteboardPromptClipboardPayload(JSON.stringify({ version: 1, segments })), segments);
assert.equal(parseWhiteboardPromptClipboardPayload("{broken"), null);
assert.equal(parseWhiteboardPromptClipboardPayload({ version: 2, segments }), null);
assert.equal(parseWhiteboardPromptClipboardPayload({ version: 1, segments: [{ kind: "script" }] }), null);
assert.equal(hasWhiteboardPromptClipboardHtml('<div data-shensi-generation-prompt="json"></div>'), true);
assert.equal(hasWhiteboardPromptClipboardHtml('<span data-rich-mention-token="token"></span>'), true);
assert.equal(hasWhiteboardPromptClipboardHtml('<p>ordinary text</p>'), false);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /wrapper\.setAttribute\("data-shensi-generation-prompt"/u);
assert.match(app, /setData\("text\/html", wrapper\.outerHTML\)/u, "HTML 剪贴板必须保留承载引用身份的外层标记");
assert.match(app, /const hasReferenceHtml = hasWhiteboardPromptClipboardHtml/u);
assert.match(app, /if \(!hasImage && !hasOrderedPrompt && !hasReferenceHtml\) return/u);
assert.match(app, /action === "copy" && target\?\.matches\?\.\("\.whiteboard-generation-inline-mentions"\)/u);
assert.match(app, /document\.execCommand\("copy"\)/u);
assert.match(app, /orderedWhiteboardPromptPasteSegments\(\{ getData:/u, "右键粘贴必须经过同一个引用解析器");
assert.match(app, /const restoredReferences = new Map\(\)/u, "重复引用不能重复创建媒体卡片");
assert.match(app, /if \(node\.id === target\.id\)/u, "不得创建自身上游循环");
console.log("Portable prompt reference metadata, HTML fallback and context-menu clipboard tests passed");
