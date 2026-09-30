import assert from "node:assert/strict";
import { parseOpenCodeJsonEvents } from "../src/cli/deepseek-opencode-cli.mjs";
import { createCodexApiAgentRuntime } from "../src/server/codex-api-agent-runtime.mjs";

// OpenCode can finish with a nested assistant message or a terminal tool
// error. Both must be classified deterministically instead of becoming a
// generic empty-response error.
assert.equal(parseOpenCodeJsonEvents(JSON.stringify({ type: "message", message: { content: [{ type: "text", text: "自检通过" }] } })), "自检通过");
assert.throws(
  () => parseOpenCodeJsonEvents(JSON.stringify({ type: "tool", part: { state: { status: "error", error: "权限被拒绝" } } })),
  /OpenCode 未返回最终文本：.*权限被拒绝/u,
);

let requestBody = null;
const runtime = createCodexApiAgentRuntime({
  fetchImpl: async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({ id: "self-check", output: [{ type: "message", content: [{ type: "output_text", text: "聚合 API 自检通过" }] }] });
  },
});
const result = await runtime.runStage({
  settings: { baseUrl: "https://provider.invalid/v1", apiKey: "test", model: "test-model", protocol: "responses", adapter: "api", agentEngine: "codex_api", provider: "自定义兼容接口" },
  prompt: "只回复自检通过",
  messages: [{ role: "user", content: "只回复自检通过" }],
  sessionId: "transport-self-check",
  stage: "conversation_agent",
});
assert.equal(result.text, "聚合 API 自检通过");
assert.equal(requestBody.stream, false);
console.log("agent transport compatibility tests passed");
