import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(app, /id="conversationChoiceCloseButton"[^>]*title="关闭选择区"/u, "对话选项区右上角必须提供关闭按钮");
assert.match(app, /conversationChoiceCloseButton\?\.addEventListener\("click", \(\) => closeConversationChoicePanel\(\)\)/u, "关闭按钮必须隐藏当前选择区");
assert.match(css, /\.conversation-choice-header\s*\{[\s\S]{0,180}justify-content:\s*space-between/u, "关闭按钮必须固定在选择区右上角");

console.log("conversation choice close button contract passed");
