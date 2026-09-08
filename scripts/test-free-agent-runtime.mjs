import assert from "node:assert/strict";
import { createCodexApiAgentRuntime } from "../src/server/codex-api-agent-runtime.mjs";

const requests = [];
const fetchImpl = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  if (requests.length === 1) {
    return new Response(JSON.stringify({
      id: "chat-agent-1",
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "docs_read", arguments: '{"documentId":"chapter-1"}' } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    id: "chat-agent-2",
    choices: [{ message: { role: "assistant", content: "FREE_AGENT_OK" } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const runtime = createCodexApiAgentRuntime({ fetchImpl });
const settings = {
  id: "text-public-agent",
  connectionId: "text-public-agent",
  systemManaged: true,
  adapter: "api",
  provider: "免费模型",
  protocol: "chat_completions",
  baseUrl: "https://api.kilo.ai/api/openrouter",
  model: "poolside/laguna-s-2.1:free",
  agentEngine: "codex_api",
  credentialSource: "public",
};
const result = await runtime.runStage({
  settings,
  prompt: "读取第一章",
  stage: "agent",
  sessionId: "free-agent-test",
  workspaceToolRuntime: {
    dynamicTools: [{ name: "docs", tools: [{ type: "function", name: "read", description: "Read a document", inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] } }] }],
    invoke: async ({ arguments: args }) => ({ success: true, contentItems: [{ type: "inputText", text: `CONTENT:${args.documentId}` }] }),
  },
});

assert.equal(result.text, "FREE_AGENT_OK");
assert.equal(result.protocol, "chat_completions");
assert.equal(result.workspaceToolsUsed, true);
assert.equal(requests.length, 2);
assert.equal(requests[0].model, settings.model);
assert.equal(requests[0].tools[0].function.name, "docs_read");
assert.equal(requests[1].messages.at(-1).role, "tool");
assert.equal(requests[1].messages.at(-1).content, "CONTENT:chapter-1");

runtime.close();
console.log("Free Agent Chat Completions runtime tests passed");
