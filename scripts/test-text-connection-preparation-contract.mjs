import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const functionMatch = app.match(/const autoPreparePublicTextConnection = \([\s\S]*?\n\};/u);

assert.ok(functionMatch, "必须保留文字连接后台准备函数");
assert.doesNotMatch(functionMatch[0], /return null;/u, "后台准备函数的所有出口都必须返回 Promise");
assert.match(functionMatch[0], /return Promise\.resolve\(null\);/u, "不适用和后台启动分支必须稳定返回已完成 Promise");
assert.match(app, /await autoPreparePublicTextConnection\(requestTextProfile, \{ executionSurface \}\)\.catch\(\(\) => null\);/u, "Chat 发送链必须安全等待准备契约");
assert.match(app, /await autoPreparePublicTextConnection\(activeAgentTextProfile\(state\.settings\), \{ executionSurface: "agent" \}\)\.catch\(\(\) => null\);/u, "Agent 发送链必须安全等待准备契约");

console.log("text connection preparation contract regression passed");
