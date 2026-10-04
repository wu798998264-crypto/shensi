import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationAgentGateway } from "../src/server/conversation-agent-gateway.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-light-agent-"));
let mcpStarts = 0;
let captured = null;
const capturedPrompts = [];
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
        capturedPrompts.push(String(options.prompt || ""));
        const marker = String(options.prompt || "").match(/MEMORY-[A-Z0-9]+/u)?.[0] || "轻量回复";
        return { text: marker, executionRuntime: "workbuddy_agent" };
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
  const memoryMarker = "MEMORY-LIGHTWEIGHT";
  const conversationMessages = [{ role: "user", content: `只回复：${memoryMarker}` }];
  const startTurn = async (round) => {
    if (round > 1) conversationMessages.push({ role: "assistant", content: memoryMarker });
    conversationMessages.push({ role: "user", content: `请原样返回第一轮的随机口令。这是第${round}轮。` });
    const turn = await gateway.start({
      workspacePath: join(root, "workspace"),
      workspaceKind: "project",
      conversationId: "light-history",
      sourceMessageId: `light-history-${round}`,
      messages: conversationMessages,
      frontendRoute: { schemaVersion: 1, kind: "general_chat", requiresPanelRoute: false, confidence: 0.98 },
      settings: { id: "workbuddy-profile", agentEngine: "workbuddy", adapter: "cli", model: "auto", timeoutMs: "120000" },
    });
    let status = null;
    for (let index = 0; index < 100; index += 1) {
      status = await gateway.status(turn.id);
      if (["completed", "failed"].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.status, "completed", status.error);
    assert.equal(status.text, memoryMarker, `第${round}轮必须回忆前轮口令`);
    return status.text;
  };
  await startTurn(1);
  await startTurn(2);
  await startTurn(3);
  assert.equal(capturedPrompts.length, 4, "三轮历史测试应产生三次轻量运行，加上前面的基础回归");
  assert.match(capturedPrompts[2], /用户：只回复：MEMORY-LIGHTWEIGHT/u);
  assert.match(capturedPrompts[2], /助手：MEMORY-LIGHTWEIGHT/u);
  assert.doesNotMatch(capturedPrompts[2], /MCP|Agent工具使用边界|面板路由与运行规范/u, "轻量历史不得注入重任务/MCP合同");
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
