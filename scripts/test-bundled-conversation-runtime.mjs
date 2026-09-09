import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { runBundledConversationAgent } from "../src/server/bundled-conversation-runtime.mjs";
const root = await mkdtemp(join(tmpdir(), "shensi-native-codex-"));
let calls = 0, executed = 0, approvalCalls = 0;
try {
  const result = await runBundledConversationAgent({ appRoot: process.cwd(), machineRoot: root, sessionId: "native-smoke", settings: { protocol: "chat_completions", baseUrl: "https://mock.invalid/v1", model: "poolside/laguna-s-2.1:free", provider: "免费模型", agentPermissionMode: "approval_required", webSearchEnabled: true },
    prompt: "调用 documents.list 后报告结果。", contextBlocks: [{ name: "Task", text: "Use documents.list to inspect the authorized workspace. Report only actual results." }], signal: AbortSignal.timeout(45_000),
    permissionContract: { mode: "approval_required" },
    nativeWebSearchEnabled: false,
    requestApproval: async () => { approvalCalls += 1; return { answer: "allow" }; },
    workspaceToolRuntime: { dynamicTools: [{ type: "namespace", name: "documents", description: "Workspace", tools: [{ type: "function", name: "list", description: "List workspace documents", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }], invoke: async ({ namespace, tool }) => { assert.equal(namespace, "documents"); assert.equal(tool, "list"); executed++; return { success: true, contentItems: [{ type: "inputText", text: "read-ok" }] }; } },
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://mock.invalid/v1/chat/completions");
      const request = JSON.parse(options.body); calls++;
      assert.equal(request.model, "poolside/laguna-s-2.1:free");
      assert.ok(request.tools.some((tool) => tool.function.name === "documents_list"));
      if (calls > 1) assert.ok(request.messages.some((item) => item.role === "tool" && item.content.includes("read-ok")));
      return Response.json({ id: `mock-${calls}`, choices: [{ message: calls === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "call-one", type: "function", function: { name: "documents_list", arguments: "{}" } }] } : { role: "assistant", content: "NATIVE_CODEX_TOOL_OK" } }] });
    },
  });
  assert.equal(result.text, "NATIVE_CODEX_TOOL_OK");
  assert.equal(result.agentRuntime.runtime, "bundled_codex");
  assert.equal(result.agentRuntime.nativeWebSearchEnabled, false, "显式拒绝状态必须跨 bundled runtime 传递");
  assert.equal(approvalCalls, 0, "已解析的联网状态不得在 bundled runtime 重复请求确认");
  assert.equal(executed, 1);
  assert.equal(calls, 2);
  console.log("Real bundled Codex 0.146.0 -> mock current limited model -> dynamic tool -> final result passed; no paid API calls");
} finally {
  const rel = relative(resolve(tmpdir()), root); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
