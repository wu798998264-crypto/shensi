import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversationAgentGateway, projectTrustedConversationRuntimeProfile, resolveConversationCodexLaunch } from "../src/server/conversation-agent-gateway.mjs";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";
import { createConversationAgentTools } from "../src/server/conversation-agent-tools.mjs";
import { createShensiCodexAgentRuntime, disabledAmbientSkillConfig } from "../src/server/shensi-codex-agent-runtime.mjs";
import { resolveTrustedGenerationSettings } from "../src/server/generation-runtime-store.mjs";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeSources = await Promise.all([
  "conversation-agent-service.mjs",
  "conversation-agent-gateway.mjs",
  "conversation-agent-tools.mjs",
  "bundled-conversation-runtime.mjs",
].map((name) => readFile(join(sourceRoot, "src", "server", name), "utf8")));
const serverSource = await readFile(join(sourceRoot, "server.mjs"), "utf8");
assert.match(serverSource, /resolveRuntimeSettings:\s*async \(settings\)[\s\S]{0,900}projectTrustedConversationRuntimeProfile\([\s\S]{0,300}resolveTrustedGenerationSettings\(\{ channel: "text", settings, route: "agent" \}\)[\s\S]{0,400}trustedConversationModelSettings\(trustedSettings\)/u,
  "对话 Agent 每次运行前必须刷新可信文字运行绑定，不能继续使用失效 CLI 路径或缺失公开端点");
const publicRuntime = await resolveTrustedGenerationSettings({
  channel: "text",
  route: "agent",
  settings: {
    activeTextConnectionId: "text-public-kilo",
    activeTextAgentConnectionId: "text-public-kilo",
    textConnections: [{ id: "text-public-kilo", name: "免费模型", provider: "免费模型", adapter: "api", model: "poolside/laguna-xs-2.1:free" }],
  },
});
assert.equal(publicRuntime.agentEngine, "codex_api");
assert.equal(publicRuntime.credentialSource, "public");
assert.equal(publicRuntime.textConnections[0]?.agentEngine, "codex_api", "公共 Agent 的可信运行器必须同步投影到当前列表配置");
assert.ok(publicRuntime.textConnections[0]?.baseUrl, "公共 Agent 的系统端点必须同步投影到运行合同读取的列表配置");
const launchEnvironment = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" };
let receivedLaunchEnvironment = null;
const npmCodexLaunch = await resolveConversationCodexLaunch({
  environment: launchEnvironment,
  resolveLaunch: async ({ environment }) => {
    receivedLaunchEnvironment = environment;
    return { executable: "C:\\Program Files\\nodejs\\node.exe", prefixArgs: ["C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"] };
  },
});
assert.equal(receivedLaunchEnvironment, launchEnvironment, "对话网关必须把隔离环境原样交给本机 Codex 启动解析器");
assert.deepEqual(npmCodexLaunch.prefixArgs, ["C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"],
  "npm Codex 启动必须保留 codex.js 前置参数，不能只启动 node.exe");
assert.equal(Object.hasOwn(launchEnvironment, "SHENSI_CODEX_EXECUTABLE"), false,
  "可信绑定中的派生 node.exe 不能反向覆盖完整的本机 Codex 启动解析");
const portableProfile = { id: "aggregate-agent", adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: "", model: "gpt-test", apiKey: "", agentEngine: "codex_api" };
const projectedTrustedProfile = projectTrustedConversationRuntimeProfile({
  ...portableProfile,
  connectionId: portableProfile.id,
  activeTextConnectionId: portableProfile.id,
  activeTextAgentConnectionId: portableProfile.id,
  baseUrl: "http://127.0.0.1:5317/v1",
  apiKey: "runtime-only-secret",
  textConnections: [portableProfile],
});
assert.equal(projectedTrustedProfile.textConnections[0].apiKey, "runtime-only-secret",
  "DPAPI 运行时凭据必须投影到当前 Agent 列表配置，不能在重新激活配置时丢失");
assert.equal(projectedTrustedProfile.textConnections[0].baseUrl, "http://127.0.0.1:5317/v1",
  "本机可信端点必须投影到当前 Agent 列表配置");
assert.equal(portableProfile.apiKey, "", "运行时投影不得修改便携工作区中的原配置对象");
assert.match(runtimeSources[1], /createShensiCodexAgentRuntime\(\{[\s\S]{0,500}isolateConfig:\s*true/u,
  "对话 Agent 的操作权限不得顺带放开环境 Skill；所有档位都必须只从神思 Skill 面板路由创作能力");
assert.deepEqual(disabledAmbientSkillConfig({ data: [
  { cwd: "one", skills: [{ path: "C:/Users/test/.agents/skills/blog/SKILL.md", enabled: true }, { path: "C:/Users/test/.codex/skills/image/SKILL.md", enabled: true }] },
  { cwd: "two", skills: [{ path: "C:/Users/test/.agents/skills/blog/SKILL.md", enabled: true }, { path: "", enabled: true }] },
] }), [
  { path: "C:/Users/test/.agents/skills/blog/SKILL.md", enabled: false },
  { path: "C:/Users/test/.codex/skills/image/SKILL.md", enabled: false },
], "对话线程必须生成不落盘的环境 Skill 禁用覆盖，并按路径去重");
const codexRuntimeSource = await readFile(join(sourceRoot, "src", "server", "shensi-codex-agent-runtime.mjs"), "utf8");
assert.match(codexRuntimeSource, /this\.request\("skills\/list", \{ cwds: \[cwd\], forceReload: true \}[\s\S]{0,900}"skills\.config": ambientSkillOverrides/u,
  "高权限对话必须通过当前 app-server 支持的线程 skills.config 隔离环境 Skill");
for (const source of runtimeSources) {
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:request-routing|agent-task-policy|conversation-media-routing)\.js/u,
    "统一对话 Agent 主链不得导入旧关键词任务路由");
}

const root = await mkdtemp(join(tmpdir(), "shensi-agent-boundary-"));
try {
  const protocolCalls = [];
  const protocolRuntime = createShensiCodexAgentRuntime({
    appRoot: sourceRoot,
    machineRoot: join(root, "protocol-machine"),
  });
  protocolRuntime.ensureStarted = async () => {};
  protocolRuntime.request = async (method, params) => {
    protocolCalls.push({ method, params });
    if (method === "skills/list") return { data: [{ cwd: root, skills: [
      { path: "C:/Users/test/.agents/skills/blog/SKILL.md", enabled: true },
      { path: "C:/Users/test/.codex/skills/image/SKILL.md", enabled: true },
    ] }] };
    if (method === "thread/start") return { thread: { id: "isolated-skill-thread" } };
    throw new Error(`unexpected protocol call: ${method}`);
  };
  await protocolRuntime.ensureSession({
    settings: { model: "gpt-test", agentPermissionMode: "full_access" },
    permissionContract: { mode: "full_access" },
    shensiRuntime: { sessionId: "isolated-skill-session", stage: "conversation_agent", agentDriven: true },
    system: "只使用神思面板能力。",
    workspaceToolRuntime: { dynamicTools: [{ type: "namespace", name: "skills", tools: [] }] },
  });
  assert.deepEqual(protocolCalls.map((call) => call.method), ["skills/list", "thread/start"],
    "会话启动必须先读取环境 Skill，再用同一线程配置启动 Agent");
  const threadStart = protocolCalls[1].params;
  assert.deepEqual(threadStart.config["skills.config"], [
    { path: "C:/Users/test/.agents/skills/blog/SKILL.md", enabled: false },
    { path: "C:/Users/test/.codex/skills/image/SKILL.md", enabled: false },
  ], "thread/start 必须逐项禁用环境 Skill，创作能力只来自神思面板");
  assert.equal(threadStart.config["features.shell_tool"], true, "完全权限仍应保留原生操作能力");
  assert.ok(threadStart.dynamicTools.some((entry) => entry.name === "skills"), "神思 Skill 工具必须随线程启动提供");

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
  assert.ok(capturedRun.contextBlocks.some((block) => block.name === "神思任务路由"));
  assert.ok(capturedRun.contextBlocks.some((block) => block.name === "神思运行规范"));

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
      settings: { id: `${agentEngine}-profile`, agentEngine, model: agentEngine === "opencode" ? "provider/model" : "claude-model", timeoutMs: 120_000 },
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
    assert.equal(handoff.options.timeoutMs, 600_000, "旧配置的 120 秒必须提升为至少 10 分钟无进展超时");
    assert.ok(handoff.options.contextBlocks.some((block) => block.name === "神思任务路由"));
    assert.ok(handoff.options.contextBlocks.some((block) => block.name === "神思运行规范"));
  }
  assert.equal(openedHosts, 4);
  assert.equal(closedHosts, 4, "外置 Agent 每次处理和复核后都必须关闭隔离 MCP 服务");
  console.log("Conversation Agent boundary: no keyword imports/preloads and complete OpenCode/Claude MCP handoff passed");
} finally {
  const rel = relative(resolve(tmpdir()), root);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}
