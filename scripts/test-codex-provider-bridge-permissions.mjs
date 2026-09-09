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

const invokeBridge = async ({ protocol, providerReply }) => {
  let upstreamBody = null;
  const bridge = await startCodexProviderBridge({
    settings: {
      protocol,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-only",
      model: "test-model",
    },
    permissionContract: permissionContractFor("full_access", { runner: "codex_api", taskId: `bridge-${protocol}` }),
    tools: workspaceTools,
    fetchImpl: async (_url, options) => {
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
        input: [{ role: "user", content: [{ type: "input_text", text: "Run the task" }] }],
        tools: requestedTools,
        stream: false,
      }),
    });
    assert.equal(response.ok, true);
    return { upstreamBody, payload: await response.json() };
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

console.log("Codex provider bridge preserves native tools and Shensi namespaces for Responses and Chat Completions");
