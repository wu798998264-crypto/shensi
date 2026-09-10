import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSessionCompatibility, agentSessionKey } from "../src/agent-session-state.js";
import { requestAgentCapabilityApproval, toolsWithPermissionPrompt } from "../src/server/agent-permission-prompt-tools.mjs";
import { createCodexAgentProvider } from "../src/server/codex-agent-provider.mjs";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";
import { runDeepSeekOpenCodeAgent } from "../src/server/deepseek-opencode-agent-runner.mjs";
import { openCodePermissionPrompt, replyToOpenCodePermission } from "../src/server/opencode-agent-runner.mjs";
import { createShensiCodexAgentRuntime } from "../src/server/shensi-codex-agent-runtime.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-agent-permission-runtime-"));
try {
  const capturedRuns = [];
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => [],
    readRoute: async () => "由 Agent 按语义选择工具。",
    run: async (options) => {
      capturedRuns.push(options);
      await options.workspaceToolRuntime.invoke({ namespace: 'interaction', tool: 'delivery', arguments: { mode: 'conversation', documentIds: [] } });
      if (options.permissionContract.mode !== "approval_required") return { text: options.permissionContract.mode };
      const result = await options.requestApproval({
        question: "允许读取系统配置？",
        options: [{ id: "allow", label: "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }],
        detail: { action: "read", files: ["system-config"] },
      });
      return { text: result.answer };
    },
  });
  const request = {
    workspacePath: root,
    workspaceKind: "notebook",
    conversationId: "permission-snapshot",
    sourceMessageId: "permission-snapshot-one",
    messages: [{ role: "user", content: "检查系统配置" }],
    settings: { id: "agent-profile", agentEngine: "opencode", model: "provider/model", agentPermissionMode: "approval_required" },
  };
  const started = await service.start(request);
  request.settings.agentPermissionMode = "full_access";
  let pending;
  for (let index = 0; index < 100; index += 1) {
    pending = await service.status(started.id);
    if (pending.question) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(pending.permissionContract.mode, "approval_required", "任务启动后必须固化权限快照");
  assert.equal(pending.question.kind, "agent_permission");
  assert.equal(pending.question.allowFreeText, false, "权限问题只能明确允许或拒绝");
  assert.deepEqual(pending.question.options.map((option) => option.id), ["allow", "deny"]);
  await service.answer(started.id, pending.question.id, "allow");
  for (let index = 0; index < 100; index += 1) {
    pending = await service.status(started.id);
    if (pending.status === "completed") break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(pending.text, "allow");
  assert.equal(capturedRuns[0].permissionContract.mode, "approval_required");

  const second = await service.start({ ...request, conversationId: "permission-snapshot-two", sourceMessageId: "permission-snapshot-two", settings: { ...request.settings } });
  for (let index = 0; index < 100; index += 1) {
    const status = await service.status(second.id);
    if (status.status === "completed") break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(capturedRuns[1].permissionContract.mode, "full_access");
  assert.notEqual(capturedRuns[0].sessionId, capturedRuns[1].sessionId, "不同权限档位不得复用运行器会话");

  const approvalPrompt = openCodePermissionPrompt({
    id: "per_test",
    permission: "bash",
    patterns: ["npm install"],
    metadata: { token: "do-not-show", command: "npm install" },
  });
  assert.match(approvalPrompt.question, /npm install/u);
  assert.doesNotMatch(approvalPrompt.question, /do-not-show/u);
  let openCodeReply;
  const permissionDecision = await replyToOpenCodePermission({
    baseUrl: "http://127.0.0.1:4096",
    directory: root,
    request: { id: "per_test", permission: "bash", patterns: ["npm install"] },
    requestApproval: async () => ({ answer: "allow" }),
    fetchImpl: async (url, options) => {
      openCodeReply = { url: String(url), body: JSON.parse(options.body) };
      return { ok: true, status: 200 };
    },
  });
  assert.equal(permissionDecision.reply, "once", "OpenCode 只能获得一次性允许");
  assert.deepEqual(openCodeReply.body, { reply: "once" });
  assert.match(openCodeReply.url, /\/permission\/per_test\/reply/u);

  const permissionTools = toolsWithPermissionPrompt({ dynamicTools: [] }, async () => ({ answer: "deny" }));
  const deniedTool = await permissionTools.invoke({ namespace: "permission", tool: "prompt", arguments: { tool_name: "Bash", input: { command: "whoami" } } });
  assert.deepEqual(JSON.parse(deniedTool.contentItems[0].text), { behavior: "deny", message: "用户拒绝了本次操作" });

  assert.equal(await requestAgentCapabilityApproval({ permissionMode: "shensi_only", capability: "原生联网搜索", requestApproval: async () => ({ answer: "allow" }) }), false);
  assert.equal(await requestAgentCapabilityApproval({ permissionMode: "full_access", capability: "原生联网搜索", requestApproval: async () => ({ answer: "deny" }) }), true);
  let capabilityPrompt;
  assert.equal(await requestAgentCapabilityApproval({ permissionMode: "approval_required", capability: "原生联网搜索", runner: "神思运行器", requestApproval: async (details) => { capabilityPrompt = details; return { answer: "allow" }; } }), true);
  assert.equal(capabilityPrompt.detail.operation, "network_exfiltration");
  assert.match(capabilityPrompt.question, /原生联网搜索/u);
  await assert.rejects(() => requestAgentCapabilityApproval({ permissionMode: "approval_required", capability: "原生联网搜索" }), /缺少神思审批通道/u);

  const runtime = createShensiCodexAgentRuntime({ machineRoot: root, appRoot: root });
  const responses = [];
  runtime.respond = (id, result) => responses.push({ id, result });
  await runtime.resolveRuntimeApproval({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "whoami" } }, { permissionMode: "shensi_only", deniedToolCalls: 0 });
  assert.equal(responses.at(-1).result.decision, "decline");
  await runtime.resolveRuntimeApproval({ id: 2, method: "item/commandExecution/requestApproval", params: { command: "whoami" } }, { permissionMode: "full_access", deniedToolCalls: 0 });
  assert.equal(responses.at(-1).result.decision, "accept");
  await runtime.resolveRuntimeApproval({ id: 3, method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } }, {
    permissionMode: "approval_required",
    deniedToolCalls: 0,
    requestApproval: async () => ({ answer: "allow" }),
  });
  assert.equal(responses.at(-1).result.scope, "turn");
  assert.equal(responses.at(-1).result.permissions.network.enabled, true);

  const capturedNativeSearchOptions = [];
  const nativeSearchRuntime = createShensiCodexAgentRuntime({ machineRoot: join(root, "native-search-runtime"), appRoot: root });
  nativeSearchRuntime.ensureSession = async (options) => {
    capturedNativeSearchOptions.push(options);
    return { sessionId: options.shensiRuntime.sessionId, threadId: "native-search-thread", stageCount: 0, permissionMode: "full_access", nativeWebSearchEnabled: options.nativeWebSearchEnabled };
  };
  nativeSearchRuntime.request = async (method) => {
    if (method === "turn/start") {
      queueMicrotask(() => nativeSearchRuntime.handleNotification("item/agentMessage/delta", { threadId: "native-search-thread", turnId: "native-search-turn", delta: "native-search-ok" }));
      queueMicrotask(() => nativeSearchRuntime.handleNotification("turn/completed", { threadId: "native-search-thread", turnId: "native-search-turn", turn: { id: "native-search-turn", status: "completed" } }));
      return { turn: { id: "native-search-turn" } };
    }
    return {};
  };
  const nativeSearchResult = await nativeSearchRuntime.runStage({
    settings: { provider: "OpenAI", adapter: "cli", cliPath: "codex", model: "gpt-5", webSearchEnabled: false, agentPermissionMode: "full_access" },
    nativeWebSearchEnabled: true,
    permissionContract: { mode: "full_access" },
    prompt: "需要联网状态快照",
    sessionId: "native-search-explicit",
    stage: "agent",
    shensiRuntime: { sessionId: "native-search-explicit", stage: "agent", agentDriven: true },
  });
  assert.equal(capturedNativeSearchOptions[0].nativeWebSearchEnabled, true, "显式 nativeWebSearchEnabled 必须优先于关闭的 settings.webSearchEnabled");
  assert.equal(nativeSearchResult.agentRuntime.nativeWebSearchEnabled, true);

  const baseSession = { conversationId: "conversation", branchId: "main", provider: "codex", cwd: root };
  assert.notEqual(
    agentSessionKey({ ...baseSession, permissionMode: "shensi_only" }),
    agentSessionKey({ ...baseSession, permissionMode: "full_access" }),
  );
  assert.deepEqual(
    agentSessionCompatibility({ ...baseSession, threadId: "thread", model: "model", toolVersion: "v1", permissionMode: "shensi_only" }, { ...baseSession, model: "model", toolVersion: "v1", permissionMode: "full_access" }).reasons,
    ["permission_mode_changed"],
  );

  const deepSeekFixture = [
    "const args=process.argv.slice(1);let input='';",
    "process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk)=>input+=chunk);",
    "process.stdin.on('end',()=>{const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||'{}');",
    "const value={args,input,mcp:Boolean(config.mcp?.shensi),isolated:Boolean(process.env.XDG_CONFIG_HOME),plugin:config.plugin};",
    "console.log(JSON.stringify({type:'text',text:JSON.stringify(value),sessionID:'deepseek-permission-test'}));});",
  ].join("");
  const deepSeekLaunchResolver = async () => ({ executable: process.execPath, prefixArgs: ["-e", deepSeekFixture, "--"] });
  const nativeHost = { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer test" } };
  const restrictedDeepSeek = await runDeepSeekOpenCodeAgent({
    prompt: "检查权限",
    cwd: root,
    apiKey: "test-only-secret",
    nativeHost,
    agentPermissionMode: "shensi_only",
    launchResolver: deepSeekLaunchResolver,
  });
  const restrictedDeepSeekProcess = JSON.parse(restrictedDeepSeek.text);
  assert.equal(restrictedDeepSeekProcess.mcp, true, "仅限神思仍必须获得神思 MCP 工具");
  assert.equal(restrictedDeepSeekProcess.isolated, true, "仅限神思必须隔离 OpenCode 宿主配置");
  assert.ok(restrictedDeepSeekProcess.args.includes("--pure"));
  assert.deepEqual(restrictedDeepSeekProcess.plugin, []);

  const fullDeepSeek = await runDeepSeekOpenCodeAgent({
    prompt: "检查权限",
    cwd: root,
    apiKey: "test-only-secret",
    nativeHost,
    agentPermissionMode: "full_access",
    launchResolver: deepSeekLaunchResolver,
  });
  const fullDeepSeekProcess = JSON.parse(fullDeepSeek.text);
  assert.equal(fullDeepSeekProcess.mcp, true, "完全权限也必须保留神思 MCP 工具");
  assert.equal(fullDeepSeekProcess.isolated, false, "完全权限必须保留运行器原生环境");
  assert.equal(fullDeepSeekProcess.args.includes("--pure"), false);
  assert.ok(fullDeepSeekProcess.args.includes("--auto"));
  assert.equal(fullDeepSeekProcess.plugin, undefined, "完全权限不得清空宿主插件配置");

  await assert.rejects(() => runDeepSeekOpenCodeAgent({
    prompt: "检查权限",
    cwd: root,
    apiKey: "test-only-secret",
    agentPermissionMode: "approval_required",
    launchResolver: deepSeekLaunchResolver,
  }), /缺少神思审批通道/u);

  let directRunnerOptions = null;
  let directMcpTools = null;
  let directMcpClosed = 0;
  const directProvider = createCodexAgentProvider({
    machineRoot: join(root, "direct-provider-machine"),
    appRoot: root,
    openCodeAgentRunner: async (options) => {
      directRunnerOptions = options;
      return { text: "DIRECT_EXTERNAL_OK", sessionId: "direct-session", model: "provider/model" };
    },
    startMcp: async ({ tools }) => {
      directMcpTools = tools;
      return {
        url: "http://127.0.0.1:41999/mcp",
        headers: { Authorization: "Bearer direct-test" },
        close: async () => { directMcpClosed += 1; },
      };
    },
  });
  directProvider.openCodeInstalled = true;
  directProvider.gitDirtyPaths = async () => new Set();
  directProvider.createWorkspaceToolRuntime = async () => ({
    protocolVersion: "shensi_workspace_tools_v1",
    dynamicTools: [{
      type: "namespace",
      name: "workspace",
      description: "Read Shensi workspace",
      tools: [{ type: "function", name: "structure", description: "Structure", inputSchema: { type: "object", properties: {} } }],
    }],
    invoke: async () => ({ success: true, contentItems: [{ type: "inputText", text: "{}" }] }),
  });
  const directRun = await directProvider.startDeepSeekTurnForProject("Inspect the current Shensi work", {
    cwd: root,
    ephemeral: true,
    conversationThreadSessions: {},
  }, {
    runtimeSettings: {
      agentEngine: "opencode",
      model: "provider/model",
      credentialSource: "opencode",
      agentPermissionMode: "full_access",
    },
    taskPacket: { conversationId: "direct-external", workspaceToolContext: { root } },
  });
  assert.equal(directRun.permissionMode, "full_access");
  assert.ok(directMcpTools.dynamicTools.some((entry) => entry.name === "workspace"), "外置 Agent 的直接启动入口也必须注入神思 MCP");
  assert.equal(directRunnerOptions.nativeHost.url, "http://127.0.0.1:41999/mcp");
  assert.equal(directRunnerOptions.permissionContract.mode, "full_access");
  for (let index = 0; index < 100 && directMcpClosed === 0; index += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(directMcpClosed, 1, "外置 Agent 结束后必须关闭专用 MCP Host");
  await directProvider.close();

  let capturedThreadStart = null;
  const restrictedProvider = createCodexAgentProvider({
    machineRoot: join(root, "restricted-provider-machine"),
    appRoot: root,
    launchResolver: async () => ({ executable: process.execPath, prefixArgs: ["-e", "process.stdin.resume()", "--"] }),
  });
  restrictedProvider.installed = true;
  restrictedProvider.requireConnectedAccount = async () => {};
  restrictedProvider.ensureThread = async (_project, options) => {
    capturedThreadStart = options;
    return "restricted-thread";
  };
  restrictedProvider.runtimeWorkspaceRoots = async () => [root];
  restrictedProvider.gitDirtyPaths = async () => new Set();
  restrictedProvider.captureWorkspaceBaseline = async () => null;
  restrictedProvider.createWorkspaceToolRuntime = async () => ({ protocolVersion: "test", dynamicTools: [], invoke: async () => ({ success: true }) });
  await assert.rejects(() => restrictedProvider.startTurnForProject("检查当前任务", { cwd: root, model: "gpt-5" }, {
    taskPacket: { conversationId: "restricted-codex", workspaceToolContext: { root } },
    runtimeSettings: { agentPermissionMode: "shensi_only", model: "gpt-5" },
  }), /Codex app-server|Codex 尚未登录|启动失败/u);
  assert.deepEqual(capturedThreadStart.runtimeSettings?.agentPermissionMode, "shensi_only");
  await restrictedProvider.close();

  console.log("Agent permission runtime: immutable task snapshots, one-shot approvals, runner bridges and session isolation passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
