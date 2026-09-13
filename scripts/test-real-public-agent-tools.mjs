import assert from "node:assert/strict";
import { createCodexApiAgentRuntime } from "../src/server/codex-api-agent-runtime.mjs";

const model = String(process.env.SHENSI_PUBLIC_AGENT_TOOL_MODEL || "poolside/laguna-s-2.1:free");
const marker = `PUBLIC-TOOL-${Date.now()}`;
const calls = [];
const runtime = createCodexApiAgentRuntime();

try {
  const result = await runtime.runStage({
    settings: {
      id: "text-public-agent",
      connectionId: "text-public-agent",
      systemManaged: true,
      adapter: "api",
      provider: "免费模型",
      protocol: "chat_completions",
      baseUrl: "https://api.kilo.ai/api/openrouter",
      model,
      agentModelId: model,
      agentEngine: "codex_api",
      credentialSource: "public",
      maxOutputTokens: "1200",
      agentPermissionMode: "shensi_only",
    },
    stage: "conversation_agent",
    sessionId: `real-public-tool-${Date.now()}`,
    contextBlocks: [{ name: "测试", text: "必须使用工具读取指定文档，然后根据工具返回值回答。" }],
    prompt: "请调用 documents.read，documentId 使用 acceptance-note；然后只回答工具返回的校验标记。",
    workspaceToolRuntime: {
      dynamicTools: [{
        name: "documents",
        tools: [{ type: "function", name: "read", description: "读取指定测试文档", inputSchema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"], additionalProperties: false } }],
      }],
      invoke: async ({ namespace, tool, arguments: args }) => {
        calls.push({ namespace, tool, args });
        return { success: true, contentItems: [{ type: "inputText", text: marker }] };
      },
    },
  });
  assert.equal(calls.length, 1, "免费模型必须真实调用一次文档工具");
  assert.deepEqual(calls[0], { namespace: "documents", tool: "read", args: { documentId: "acceptance-note" } });
  assert.match(result.text, new RegExp(marker, "u"), "免费模型必须消费真实工具回执继续回答");
  console.log(JSON.stringify({ ok: true, model, marker, protocol: result.protocol, toolCalls: calls.length }));
} finally {
  runtime.close();
}
