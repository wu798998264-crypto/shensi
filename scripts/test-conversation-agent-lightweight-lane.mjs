import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationAgentGateway } from "../src/server/conversation-agent-gateway.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-light-agent-"));
let mcpStarts = 0;
let captured = null;
try {
  const gateway = createConversationAgentGateway({
    appRoot: root,
    machineRoot: join(root, "machine"),
    shensiRoot: join(process.cwd(), "packaging", "bundled", "skill", "神思"),
    resolveRuntimeSettings: async (settings) => settings,
    apiRequest: async () => { throw new Error("轻量普通对话不应调用媒体接口"); },
    startMcp: async () => { mcpStarts += 1; throw new Error("轻量普通对话不应启动 MCP"); },
    externalRunners: {
      externalCli: async (options) => {
        captured = options;
        return { text: "轻量回复", executionRuntime: "workbuddy_agent" };
      },
    },
  });
  const started = await gateway.start({
    workspacePath: join(root, "workspace"),
    workspaceKind: "project",
    conversationId: "light-general",
    sourceMessageId: "light-general-1",
    messages: [{ role: "user", content: "解释一下这个词" }],
    frontendRoute: { schemaVersion: 1, kind: "general_chat", requiresPanelRoute: false, confidence: 0.98 },
    settings: { id: "workbuddy-profile", agentEngine: "workbuddy", adapter: "cli", model: "auto", timeoutMs: "120000" },
  });
  let result = null;
  for (let index = 0; index < 100; index += 1) {
    result = await gateway.status(started.id);
    if (["completed", "failed"].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result.status, "completed", result.error);
  assert.equal(mcpStarts, 0, "轻量普通对话不得启动 MCP 桥接");
  assert.equal(captured?.lightweightGeneral, true);
  assert.equal(captured?.nativeHost, null);
  assert.equal(captured?.prompt, "解释一下这个词");
  captured = null;
  const fallbackStarted = await gateway.start({
    workspacePath: join(root, "workspace"),
    workspaceKind: "notebook",
    conversationId: "light-general-server-fallback",
    sourceMessageId: "light-general-server-fallback-1",
    messages: [{ role: "user", content: "只回复：OK" }],
    // Older clients persisted only the route kind. The server must validate
    // and enrich it from the current message instead of loading full routes.
    frontendRoute: { kind: "general_chat", routeRevision: 1 },
    settings: { id: "workbuddy-profile", agentEngine: "workbuddy", adapter: "cli", model: "auto", timeoutMs: "120000" },
  });
  let fallbackResult = null;
  for (let index = 0; index < 100; index += 1) {
    fallbackResult = await gateway.status(fallbackStarted.id);
    if (["completed", "failed"].includes(fallbackResult.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fallbackResult.status, "completed", fallbackResult.error);
  assert.equal(captured?.lightweightGeneral, true, "缺少浏览器路由时仍应使用服务器轻量路由");
  assert.equal(captured?.nativeHost, null);
  console.log("Conversation Agent lightweight general lane passed");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
