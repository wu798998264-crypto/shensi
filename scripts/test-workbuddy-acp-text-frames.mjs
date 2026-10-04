import assert from "node:assert/strict";
import { terminalAcpText, updateText } from "../src/server/workbuddy-desktop-bridge.mjs";

assert.equal(updateText({ update: { sessionUpdate: "agent_message_chunk", content: { text: "第一段" } } }), "第一段");
assert.equal(updateText({ update: { sessionUpdate: "agent_message", content: [{ type: "text", text: "完整正文" }] } }), "完整正文");
assert.equal(updateText({ update: { type: "assistant_message", message: { content: [{ type: "text", text: "终态正文" }] } } }), "终态正文");
assert.equal(updateText({ update: { sessionUpdate: "tool_call", content: { text: "内部工具内容" } } }), "", "工具帧不得泄露为用户正文");
assert.equal(terminalAcpText({ result: { status: "completed" }, params: { message: { content: [{ type: "text", text: "响应正文" }] } } }), "响应正文");
assert.equal(terminalAcpText({ result: { status: "completed" } }), "", "只有状态的 JSON-RPC result 不能伪造正文");

console.log("WorkBuddy ACP text frame contract passed");
