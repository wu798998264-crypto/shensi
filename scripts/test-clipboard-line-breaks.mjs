import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatClipboardPlainText } from "../src/prose-format.js";
import { copyableMessageText } from "../src/conversation-branch.js";

assert.equal(formatClipboardPlainText("第一行\r\n第二行\r\r第三行"), "第一行\n第二行\n\n第三行");
assert.equal(formatClipboardPlainText("第一段\\n\\n第二段"), "第一段\n\n第二段");
assert.equal(formatClipboardPlainText("<p>第一段</p><p>第二段<br>续行</p>"), "第一段\n第二段\n续行");
assert.equal(formatClipboardPlainText("第一行  \n\n\n第二行"), "第一行\n\n第二行");
assert.equal(copyableMessageText({ candidate: "标题\\n\\n正文" }), "标题\n\n正文");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /formatClipboardPlainText\(node\.kind === "web"/u);
assert.match(appSource, /copyTextToClipboard\(formatClipboardPlainText\(selectedText\)\)/u);
assert.match(appSource, /formatClipboardPlainText\(asset\.text\)/u);

console.log("Clipboard line-break formatting tests passed");
