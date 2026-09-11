import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversationAgentGateway } from "../src/server/conversation-agent-gateway.mjs";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";
import { createConversationAgentTools } from "../src/server/conversation-agent-tools.mjs";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeSources = await Promise.all([
  "conversation-agent-service.mjs",
  "conversation-agent-gateway.mjs",
  "conversation-agent-tools.mjs",
  "bundled-conversation-runtime.mjs",
].map((name) => readFile(join(sourceRoot, "src", "server", name), "utf8")));
for (const source of runtimeSources) {
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:request-routing|agent-task-policy|conversation-media-routing)\.js/u,
    "统一对话 Agent 主链不得导入旧关键词任务路由");
}

const root = await mkdtemp(join(tmpdir(), "shensi-agent-boundary-"));
try {
  let workspaceReads = 0;
  let capturedRun = null;
  const noPreloadService = createConversationAgentService({
    appRoot: sourceRoot,
    storageRoot: join(root, "no-preload-runs"),
    skillCatalog: async () => [{ id: "builtin:creative-guide", name: "创作指导", description: "按需使用" }],
    readRoute: async () => "由 Agent 依据语义判断阶段和 Skill，不使用关键词绑定。",
    readSkill: async () => "未被调用",
    toolsFactory: (options) => createConversationAgentTools({
      ...options,
      load: async () => { workspaceReads += 1; throw new Error("不应预读工作区"); },
    }),
    run: async (options) => {
      capturedRun = options;
      const delivery = await options.workspaceToolRuntime.invoke({
        namespace: "interaction",
        tool: "delivery",
        arguments: { mode: "conversation", documentIds: [] },
      });
      assert.equal(delivery.success, true);
      return { text: "只讨论，不读取空文档。" };
    },
  });
  const semanticInstruction = "不要生成视频；这里的‘覆盖、续写’只是讨论词语，不修改任何文档。";
  const started = await noPreloadService.start({
    workspacePath: join(root, "empty-workspace"),
    workspaceKind: "project",
    conversationId: "semantic-boundary",
    sourceMessageId: "semantic-boundary-message",
    messages: [{ role: "user", content: semanticInstruction }],
    settings: { id: "limited", agentEngine: "codex_api", model: "mock" },
  });
  for (let index = 0; index < 100; index += 1) {
    const status = await noPreloadService.status(started.id);
    if (["completed", "failed"].includes(status.status)) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  const semanticStatus = await noPreloadService.status(started.id);
  assert.equal(semanticStatus.status, "completed");
  assert.equal(workspaceReads, 0, "不调用文档工具时不得读取记忆、大纲、设定或其他空文档");
  assert.match(capturedRun.prompt, /不要生成视频/u, "原始语义必须完整交给 Agent，不得先按媒体关键词改写任务");
  assert.ok(capturedRun.contextBlocks.some((block) => block.name === "任务路由文档"));

  const handoffs = [];
  const mcpToolsByUrl = new Map();
  let openedHosts = 0;
  let closedHosts = 0;
  const gateway = createConversationAgentGateway({
    appRoot: sourceRoot,
    machineRoot: join(root, "machine"),
    shensiRoot: join(sourceRoot, "packaging", "bundled", "skill", "神思"),
    resolveRuntimeSettings: async (settings) => settings,
    apiRequest: async () => { throw new Error("外置文字 Agent 不应调用媒体接口"); },
    startMcp: async ({ tools }) => {
      openedHosts += 1;
      assert.ok(tools.dynamicTools.some((entry) => entry.name === "documents"));
      const url = `http://127.0.0.1:${41000 + openedHosts}/mcp`;
      mcpToolsByUrl.set(url, tools);
      return { url, headers: { Authorization: "Bearer test" }, close: async () => { closedHosts += 1; mcpToolsByUrl.delete(url); } };
    },
    externalRunners: {
      openCode: async (options) => {
        handoffs.push({ engine: "opencode", options });
        const delivery = await mcpToolsByUrl.get(options.nativeHost.url).invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "conversation", documentIds: [] } });
        assert.equal(delivery.success, true);
        return { text: "OpenCode 完整接管完成", executionRuntime: "opencode_agent" };
      },
      claudeCode: async (options) => {
        handoffs.push({ engine: "claude_code", options });
        const delivery = await mcpToolsByUrl.get(options.nativeHost.url).invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "conversation", documentIds: [] } });
        assert.equal(delivery.success, true);
        return { text: "Claude Code 完整接管完成", executionRuntime: "claude_code_agent" };
      },
    },
  });
  const runExternal = async (agentEngine, conversationId) => {
    const task = `由 ${agentEngine} 完整执行这项任务`;
    const run = await gateway.start({
      workspacePath: join(root, "external-workspace"), workspaceKind: "notebook", conversationId,
      sourceMessageId: `${conversationId}-message`, messages: [{ role: "user", content: task }],
      settings: { id: `${agentEngine}-profile`, agentEngine, model: agentEngine === "opencode" ? "provider/model" : "claude-model" },
      mediaProfiles: {},
    });
    for (let index = 0; index < 100; index += 1) {
      const status = await gateway.status(run.id);
      if (["completed", "failed"].includes(status.status)) return { task, status };
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error(`${agentEngine} handoff timeout`);
  };
  const [openCode, claude] = await Promise.all([
    runExternal("opencode", "external-opencode"),
    runExternal("claude_code", "external-claude"),
  ]);
  assert.equal(openCode.status.status, "completed", openCode.status.error);
  assert.equal(claude.status.status, "completed", claude.status.error);
  assert.equal(handoffs.length, 4, "两个外置 Agent 都必须执行首次处理和独立交付复核");
  const handoffCounts = handoffs.reduce((counts, handoff) => {
    counts.set(handoff.engine, (counts.get(handoff.engine) || 0) + 1);
    return counts;
  }, new Map());
  assert.equal(handoffCounts.get("opencode"), 2);
  assert.equal(handoffCounts.get("claude_code"), 2);
  for (const handoff of handoffs) {
    assert.match(handoff.options.prompt, /完整执行这项任务/u);
    assert.ok(handoff.options.nativeHost?.url, "外置 Agent 必须获得完整神思 MCP 工具入口");
    assert.equal(handoff.options.allowEdits, false, "不得绕开神思文档事务直接写作品文件");
    assert.ok(handoff.options.contextBlocks.some((block) => block.name === "任务路由文档"));
  }
  assert.equal(openedHosts, 4);
  assert.equal(closedHosts, 4, "外置 Agent 每次处理和复核后都必须关闭隔离 MCP 服务");
  console.log("Conversation Agent boundary: no keyword imports/preloads and complete OpenCode/Claude MCP handoff passed");
} finally {
  const rel = relative(resolve(tmpdir()), root);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}
