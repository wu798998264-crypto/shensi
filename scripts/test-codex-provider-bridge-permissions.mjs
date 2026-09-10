import assert from "node:assert/strict";

import { permissionContractFor } from "../src/agent-permission-policy.js";
import { startCodexProviderBridge } from "../src/server/codex-provider-bridge.mjs";

const workspaceTools = {
  dynamicTools: [{
    type: "namespace",
    name: "documents",
    description: "Shensi documents",
    tools: [{
      type: "function",
      name: "list",
      description: "List documents",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
  }],
};

const requestedTools = [
  {
    type: "function",
    name: "exec_command",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "apply_patch",
    description: "Apply a patch",
    format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
  },
  {
    type: "namespace",
    name: "documents",
    description: "Shensi documents",
    tools: [{
      type: "function",
      name: "list",
      description: "List documents",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    }],
  },
];

const invokeBridge = async ({ protocol, providerReply, input = null }) => {
  let upstreamBody = null;
  let upstreamUrl = "";
  let upstreamHeaders = null;
  const bridge = await startCodexProviderBridge({
    settings: {
      protocol,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-only",
      model: "test-model",
    },
    permissionContract: permissionContractFor("full_access", { runner: "codex_api", taskId: `bridge-${protocol}` }),
    tools: workspaceTools,
    fetchImpl: async (url, options) => {
      upstreamUrl = String(url);
      upstreamHeaders = options.headers;
      upstreamBody = JSON.parse(options.body);
      return Response.json(providerReply);
    },
  });
  try {
    const response = await fetch(`${bridge.url}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "ignored-by-bridge",
        instructions: "Use the available tools.",
        input: input || [{ role: "user", content: [{ type: "input_text", text: "Run the task" }] }],
        tools: requestedTools,
        stream: false,
      }),
    });
    assert.equal(response.ok, true);
    return { upstreamBody, upstreamUrl, upstreamHeaders, payload: await response.json() };
  } finally {
    await bridge.close();
  }
};

const responses = await invokeBridge({
  protocol: "responses",
  providerReply: {
    id: "provider-response",
    output: [
      { type: "function_call", id: "fc-native", call_id: "call-native", name: "exec_command", arguments: '{"cmd":"pwd"}', status: "completed" },
      { type: "custom_tool_call", id: "ctc-native", call_id: "call-patch", name: "apply_patch", input: "*** Begin Patch", status: "completed" },
      { type: "function_call", id: "fc-shensi", call_id: "call-docs", namespace: "documents", name: "list", arguments: "{}", status: "completed" },
    ],
  },
});
assert.deepEqual(
  responses.upstreamBody.tools.map((tool) => `${tool.type}:${tool.name || ""}`),
  ["function:exec_command", "custom:apply_patch", "namespace:documents"],
  "Responses 桥必须保留 Codex 原生工具，且不重复注入已存在的神思 namespace",
);
assert.equal(responses.payload.output[0].name, "exec_command", "原生函数工具返回不得被神思桥拒绝");
assert.equal(responses.payload.output[1].type, "custom_tool_call", "自定义原生工具必须原样回传 Codex");
assert.equal(responses.payload.output[2].namespace, "documents", "神思 namespace 必须保留给 Codex 工具调用器");

const chat = await invokeBridge({
  protocol: "chat_completions",
  providerReply: {
    id: "provider-chat",
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-native", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pwd"}' } },
          { id: "call-patch", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' } },
          { id: "call-docs", type: "function", function: { name: "documents_list", arguments: "{}" } },
        ],
      },
    }],
  },
});
assert.deepEqual(
  chat.upstreamBody.tools.map((tool) => tool.function.name),
  ["exec_command", "apply_patch", "documents_list"],
  "Chat Completions 桥必须将函数、自定义工具和 namespace 无损投影为唯一函数名",
);
assert.equal(chat.payload.output[0].name, "exec_command");
assert.equal(chat.payload.output[1].type, "custom_tool_call");
assert.equal(chat.payload.output[1].input, "*** Begin Patch");
assert.equal(chat.payload.output[2].namespace, "documents");
assert.equal(chat.payload.output[2].name, "list");

const anthropic = await invokeBridge({
  protocol: "anthropic_messages",
  input: [
    { role: "user", content: [{ type: "input_text", text: "Read the document" }] },
    { type: "function_call", call_id: "prior-doc-call", namespace: "documents", name: "list", arguments: "{}" },
    { type: "function_call_output", call_id: "prior-doc-call", output: '{"documents":["第一章"]}' },
  ],
  providerReply: {
    id: "provider-anthropic",
    content: [
      { type: "tool_use", id: "call-native", name: "exec_command", input: { cmd: "pwd" } },
      { type: "tool_use", id: "call-patch", name: "apply_patch", input: { input: "*** Begin Patch" } },
      { type: "tool_use", id: "call-docs", name: "documents_list", input: {} },
      { type: "text", text: "工具调用已准备" },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  },
});
assert.match(anthropic.upstreamUrl, /\/messages$/u);
assert.equal(anthropic.upstreamHeaders["x-api-key"], "test-only");
assert.equal(anthropic.upstreamHeaders["anthropic-version"], "2023-06-01");
assert.deepEqual(
  anthropic.upstreamBody.tools.map((tool) => tool.name),
  ["exec_command", "apply_patch", "documents_list"],
  "Anthropic Messages 桥必须投影原生工具、自定义工具和神思 namespace",
);
assert.equal(anthropic.upstreamBody.system, "Use the available tools.");
assert.deepEqual(anthropic.upstreamBody.messages[1].content[0], {
  type: "tool_use",
  id: "prior-doc-call",
  name: "documents_list",
  input: {},
});
assert.deepEqual(anthropic.upstreamBody.messages[2].content[0], {
  type: "tool_result",
  tool_use_id: "prior-doc-call",
  content: '{"documents":["第一章"]}',
});
assert.equal(anthropic.payload.output[0].name, "exec_command");
assert.equal(anthropic.payload.output[1].type, "custom_tool_call");
assert.equal(anthropic.payload.output[1].input, "*** Begin Patch");
assert.equal(anthropic.payload.output[2].namespace, "documents");
assert.equal(anthropic.payload.output[3].content[0].text, "工具调用已准备");
assert.deepEqual(anthropic.payload.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });

console.log("Codex provider bridge preserves native tools and Shensi namespaces across Responses, Chat Completions, and Anthropic Messages");
