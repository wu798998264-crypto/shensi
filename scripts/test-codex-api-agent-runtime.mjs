import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexApiAgentRuntime } from "../src/server/codex-api-agent-runtime.mjs";
import { createAgentWorkspaceReadBroker } from "../src/server/agent-workspace-read-broker.mjs";
import { createAgentWorkspaceToolRuntime } from "../src/server/agent-workspace-tools.mjs";
import { createHistoryReadAuthorization } from "../src/history-read-policy.js";
import { AGENT_ENGINE_IDS, agentEngineDescriptor, agentProfileBelongsToEngine } from "../src/agent-engine-registry.js";
import { generationProfileLabel } from "../src/generation-profiles.js";
import { executionModeCapabilities } from "../src/model-execution-capabilities.js";
import { runtimeContractForProfile } from "../src/effective-runtime-contract.js";
import { agentCapabilitySummary, agentRuntimeProfile } from "../src/agent-runtime-profile.js";

assert.ok(AGENT_ENGINE_IDS.includes("codex_api"));
assert.equal(agentEngineDescriptor("codex_api").label, "神思运行器", "只修改用户可见名称，内部 codex_api 标识必须保持不变");
const profile = {
  id: "codex-api-test",
  provider: "OpenAI",
  adapter: "api",
  protocol: "responses",
  agentEngine: "codex_api",
  model: "gpt-5-codex",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  agentReasoningEffort: "high",
  agentSpeedMode: "fast",
  executionModes: ["chat", "agent"],
};
const profileBeforeLabel = JSON.stringify(profile);
assert.equal(generationProfileLabel(profile, "text"), "神思运行器");
assert.equal(JSON.stringify(profile), profileBeforeLabel, "显示名称计算不得修改或复制现有配置");
assert.equal(agentProfileBelongsToEngine(profile, "codex_api"), true);
assert.deepEqual(executionModeCapabilities(profile).modes, ["agent"]);
assert.equal(runtimeContractForProfile({ profile, surface: "agent" }).runner, "codex_api_agent");
const shensiRuntimeProfile = agentRuntimeProfile({
  engine: "codex_api",
  model: "gpt-5.6-sol",
  capabilities: { workspaceToolsAvailable: true },
});
assert.equal(shensiRuntimeProfile.capabilities.openCodeToolsEnabled, false, "神思运行器不得继承 OpenCode 工具能力");
assert.match(agentCapabilitySummary(shensiRuntimeProfile), /神思工作区工具/u);
assert.doesNotMatch(agentCapabilitySummary(shensiRuntimeProfile), /OpenCode/u, "神思任务详情不得串入 OpenCode 能力标签");
assert.doesNotMatch(agentCapabilitySummary(agentRuntimeProfile({ engine: "opencode" })), /OpenCode 原生工具/u, "仅限神思时不得暴露 OpenCode 宿主工具");
assert.match(agentCapabilitySummary(agentRuntimeProfile({ engine: "opencode", capabilities: { permissionMode: "approval_required" } })), /OpenCode 原生工具/u);
assert.match(agentCapabilitySummary(agentRuntimeProfile({ engine: "claude_code", capabilities: { permissionMode: "full_access" } })), /Claude Code 原生工具/u);
assert.doesNotMatch(agentCapabilitySummary(agentRuntimeProfile({ engine: "claude_code", capabilities: { permissionMode: "full_access" } })), /OpenCode/u, "Claude Code 任务也不得串入 OpenCode 能力标签");

const compatibleProfile = {
  ...profile,
  id: "codex-api-compatible-test",
  provider: "自定义兼容接口",
  model: "gpt-5.6-sol",
  agentModelId: "gpt-5.6-sol",
  baseUrl: "http://127.0.0.1:5317/v1",
};
assert.equal(agentProfileBelongsToEngine(compatibleProfile, "codex_api"), true);
assert.deepEqual(executionModeCapabilities(compatibleProfile).modes, ["agent"]);
assert.equal(runtimeContractForProfile({ profile: compatibleProfile, surface: "agent" }).runner, "codex_api_agent");
assert.equal(runtimeContractForProfile({ profile: { ...compatibleProfile, provider: "DeepSeek" }, surface: "agent" }).code, "CODEX_PROVIDER_MISMATCH");

const historyAuthorization = createHistoryReadAuthorization({
  instruction: "比较第三章修改前后的历史版本",
  requestedBy: "user",
  documentIds: ["chapter-3"],
});
assert.equal(historyAuthorization.allowed, true);
assert.deepEqual(historyAuthorization.allowedDocumentIds, ["chapter-3"]);
assert.ok(historyAuthorization.allowedVersionSelectors.includes("previous"));

let requested;
const runtime = createCodexApiAgentRuntime({
  fetchImpl: async (url, options) => {
    requested = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "resp_test", output_text: "API Agent OK", usage: { input_tokens: 2, output_tokens: 3 } }),
    };
  },
});
const result = await runtime.runStage({
  settings: profile,
  prompt: "测试任务",
  contextBlocks: [{ type: "resource", name: "设定", text: "主角是剑修" }],
  sessionId: "session-test",
  stage: "creative",
});
assert.equal(result.text, "API Agent OK");
assert.equal(result.protocol, "responses");
assert.equal(result.providerResponseId, "resp_test");
assert.equal(result.permissionMode, "shensi_only");
assert.equal(result.permissionContract.mode, "shensi_only");
assert.equal(result.permissionContract.runner, "codex_api");
assert.equal(result.permissionContract.taskId, "session-test");
assert.equal(result.agentRuntime.permissionMode, "shensi_only");
assert.equal(requested.url, "https://api.openai.com/v1/responses");
assert.match(requested.options.headers.authorization, /^Bearer test-key$/u);
const body = JSON.parse(requested.options.body);
assert.equal(body.model, "gpt-5-codex");
assert.equal(body.reasoning.effort, "high");
assert.equal(body.service_tier, "fast");
assert.match(body.instructions, /主角是剑修/u);
assert.match(body.instructions, /神思运行器/u);
assert.match(body.instructions, /仅限神思/u);
assert.equal(body.tools, undefined, "联网关闭时不得向 Responses API 暴露网页工具");

const webRequests = [];
const webRuntime = createCodexApiAgentRuntime({
  fetchImpl: async (url, options) => {
    const requestBody = JSON.parse(options.body);
    webRequests.push({ url: String(url), options, body: requestBody });
    const webSearchAvailable = requestBody.tools?.some((tool) => tool?.type === "web_search") === true;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(webSearchAvailable ? {
        id: "resp_web",
        output: [{
          type: "web_search_call",
          id: "web_1",
          status: "completed",
          action: { sources: [{ type: "url", url: "https://example.com/source", title: "来源页" }] },
        }, {
          type: "message",
          content: [{ type: "output_text", text: "联网结果" }],
        }],
      } : { id: "resp_offline", output_text: "未联网结果" }),
    };
  },
});
let fullAccessApprovalCalls = 0;
const webResult = await webRuntime.runStage({
  settings: { ...profile, agentPermissionMode: "full_access", webSearchEnabled: true },
  prompt: "查询最新资料",
  sessionId: "web-session-test",
  stage: "agent",
  requestApproval: async () => {
    fullAccessApprovalCalls += 1;
    return { answer: "deny" };
  },
});
const webBody = webRequests.at(-1).body;
assert.deepEqual(webBody.tools, [{ type: "web_search" }]);
assert.equal(webResult.webSearchUsed, true);
assert.deepEqual(webResult.sources, [{ url: "https://example.com/source", title: "来源页" }]);
assert.equal(webResult.permissionMode, "full_access");
assert.equal(webResult.permissionContract.capabilities.network, true);
assert.equal(fullAccessApprovalCalls, 0, "完全权限不得请求神思逐项确认");

let restrictedApprovalCalls = 0;
const restrictedWebResult = await webRuntime.runStage({
  settings: { ...profile, agentPermissionMode: "full_access", webSearchEnabled: true },
  permissionContract: { mode: "shensi_only" },
  prompt: "不要联网查询",
  sessionId: "restricted-web-session-test",
  stage: "agent",
  requestApproval: async () => {
    restrictedApprovalCalls += 1;
    return { answer: "allow" };
  },
});
assert.equal(webRequests.at(-1).body.tools, undefined, "仅限神思不得暴露原生联网工具");
assert.equal(restrictedWebResult.webSearchUsed, false);
assert.equal(restrictedWebResult.permissionMode, "shensi_only", "权限合同快照必须优先于可变设置");
assert.equal(restrictedWebResult.permissionContract.taskId, "restricted-web-session-test");
assert.equal(restrictedApprovalCalls, 0, "仅限神思应直接拒绝原生能力，不得弹出可放行的确认");

const approvalPrompts = [];
const approvedWebResult = await webRuntime.runStage({
  settings: { ...profile, agentPermissionMode: "approval_required", webSearchEnabled: true },
  prompt: "确认后查询最新资料",
  sessionId: "approved-web-session-test",
  stage: "agent",
  requestApproval: async (details) => {
    approvalPrompts.push(details);
    return { answer: "allow" };
  },
});
assert.deepEqual(webRequests.at(-1).body.tools, [{ type: "web_search" }]);
assert.equal(approvedWebResult.permissionMode, "approval_required");
assert.equal(approvedWebResult.permissionContract.confirmation.scope, "per_operation");
assert.deepEqual(approvalPrompts[0].options.map((option) => option.id), ["allow", "deny"]);
assert.equal(approvalPrompts[0].detail.operation, "network_exfiltration");
assert.equal(approvalPrompts[0].detail.action, "web_search");

const deniedWebResult = await webRuntime.runStage({
  settings: { ...profile, agentPermissionMode: "approval_required", webSearchEnabled: true },
  prompt: "被拒绝的联网请求",
  sessionId: "denied-web-session-test",
  stage: "agent",
  requestApproval: async (details) => {
    approvalPrompts.push(details);
    return { answer: "deny" };
  },
});
assert.equal(webRequests.at(-1).body.tools, undefined, "用户拒绝后不得向模型暴露联网工具");
assert.equal(deniedWebResult.webSearchUsed, false);
assert.equal(approvalPrompts.length, 2, "每次受保护联网操作都必须单独确认");

const requestsBeforeMissingApproval = webRequests.length;
await assert.rejects(
  webRuntime.runStage({
    settings: { ...profile, agentPermissionMode: "approval_required", webSearchEnabled: true },
    prompt: "缺少审批通道",
    sessionId: "missing-approval-session-test",
    stage: "agent",
  }),
  (error) => error?.code === "CODEX_API_APPROVAL_CHANNEL_REQUIRED",
);
assert.equal(webRequests.length, requestsBeforeMissingApproval, "缺少审批通道时不得先发出联网工具请求");
webRuntime.close();

const workspaceInvocations = [];
const toolRequests = [];
const toolRuntime = createCodexApiAgentRuntime({
  fetchImpl: async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    toolRequests.push(requestBody);
    if (toolRequests.length === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: "resp_tool_1",
          output: [{ type: "function_call", call_id: "call_1", name: "workspace_read", arguments: JSON.stringify({ path: "正文/第1章.md" }) }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: "resp_tool_2",
        output_text: "已读取当前作品文档",
      }),
    };
  },
});
const workspaceToolRuntime = {
  dynamicTools: [{
    type: "namespace",
    name: "workspace",
    description: "只读工作区",
    tools: [{
      type: "function",
      name: "read",
      description: "读取当前作品文档",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    }],
  }],
  invoke: async (request) => {
    workspaceInvocations.push(request);
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, result: { text: "第一章内容" } }) }] };
  },
};
const toolResult = await toolRuntime.runStage({
  settings: profile,
  prompt: "读取第一章",
  sessionId: "tool-session-test",
  stage: "agent",
  workspaceToolRuntime,
});
assert.equal(toolResult.text, "已读取当前作品文档");
assert.equal(toolRequests.length, 2);
assert.deepEqual(toolRequests[0].tools, [{
  type: "function",
  name: "workspace_read",
  description: "读取当前作品文档",
  parameters: workspaceToolRuntime.dynamicTools[0].tools[0].inputSchema,
  strict: false,
}]);
assert.equal(toolRequests[0].max_tool_calls, undefined, "Responses 兼容接口不得收到 max_tool_calls；神思运行器应在本地限制工具调用次数");
assert.deepEqual(workspaceInvocations, [{ namespace: "workspace", tool: "read", arguments: { path: "正文/第1章.md" } }]);
assert.equal(toolRequests[1].previous_response_id, "resp_tool_1");
assert.deepEqual(toolRequests[1].input, [{ type: "function_call_output", call_id: "call_1", output: JSON.stringify({ ok: true, result: { text: "第一章内容" } }) }]);
assert.equal(toolResult.workspaceToolsUsed, true);
assert.deepEqual(toolResult.workspaceToolCalls, [{ name: "workspace.read", success: true, target: "正文/第1章.md" }]);
toolRuntime.close();

const relayFallbackRequests = [];
let relayFallbackInvocations = 0;
const relayFallbackRuntime = createCodexApiAgentRuntime({
  fetchImpl: async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    relayFallbackRequests.push(requestBody);
    if (relayFallbackRequests.length === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: "relay_resp_1",
          output: [{ type: "function_call", call_id: "relay_call_1", name: "workspace_read", arguments: JSON.stringify({ path: "正文/第1章.md" }) }],
        }),
      };
    }
    if (relayFallbackRequests.length === 2) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "No tool call found for function call output with call_id relay_call_1", type: "invalid_request_error" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "relay_resp_2", output_text: "兼容中转站工具续接成功" }),
    };
  },
});
const relayFallbackResult = await relayFallbackRuntime.runStage({
  settings: compatibleProfile,
  prompt: "读取第一章",
  sessionId: "relay-fallback-test",
  stage: "agent",
  workspaceToolRuntime: {
    ...workspaceToolRuntime,
    invoke: async (request) => {
      relayFallbackInvocations += 1;
      return workspaceToolRuntime.invoke(request);
    },
  },
});
assert.equal(relayFallbackResult.text, "兼容中转站工具续接成功");
assert.equal(relayFallbackInvocations, 1, "有状态续接失败后的兼容重试不得重复执行工具");
assert.equal(relayFallbackRequests.length, 3);
assert.equal(relayFallbackRequests[1].previous_response_id, "relay_resp_1");
assert.equal(relayFallbackRequests[2].previous_response_id, undefined);
assert.deepEqual(relayFallbackRequests[2].input, [
  { role: "user", content: [{ type: "input_text", text: "读取第一章" }] },
  { type: "function_call", call_id: "relay_call_1", name: "workspace_read", arguments: JSON.stringify({ path: "正文/第1章.md" }) },
  { type: "function_call_output", call_id: "relay_call_1", output: JSON.stringify({ ok: true, result: { text: "第一章内容" } }) },
]);
relayFallbackRuntime.close();

const brokerRoot = await mkdtemp(join(tmpdir(), "shensi-codex-api-tools-"));
const otherRoot = await mkdtemp(join(tmpdir(), "shensi-codex-api-other-"));
try {
  await mkdir(join(brokerRoot, "正文"), { recursive: true });
  await mkdir(join(brokerRoot, ".shensi", "history-isolated", "documents"), { recursive: true });
  await writeFile(join(brokerRoot, "正文", "第1章.md"), "当前正文", "utf8");
  await writeFile(join(brokerRoot, ".shensi", "history-isolated", "index.json"), JSON.stringify({
    schemaVersion: 3,
    documents: { "chapter-1": "documents/chapter-1.json" },
  }), "utf8");
  await writeFile(join(brokerRoot, ".shensi", "history-isolated", "documents", "chapter-1.json"), JSON.stringify({
    schemaVersion: 2,
    scopeType: "document",
    scopeId: "chapter-1",
    entries: [{ id: "version-v1", version: "v1", title: "修改前", document: { title: "第一章", html: "历史正文" } }],
  }), "utf8");
  await writeFile(join(otherRoot, "其他作品.md"), "不得读取", "utf8");
  const documentIndex = { "chapter-1": { path: "正文/第1章.md", moduleId: "manuscript" } };
  const lockedBroker = await createAgentWorkspaceReadBroker({ root: brokerRoot, documentIndex });
  await assert.rejects(
    lockedBroker.read_history_version({ documentId: "chapter-1", versionSelector: "previous" }),
    (error) => error?.code === "HISTORY_READ_NOT_AUTHORIZED",
  );
  await assert.rejects(
    lockedBroker.read({ path: ".shensi/history-isolated/index.json", historyReason: "模型自行要求", historyGapId: "gap-1" }),
    (error) => error?.code === "HISTORY_READ_SEMANTIC_TOOL_REQUIRED",
  );
  await assert.rejects(
    lockedBroker.read({ path: join(otherRoot, "其他作品.md"), explicit: true }),
    (error) => error?.code === "WORKSPACE_READ_SCOPE_DENIED",
  );
  const authorizedBroker = await createAgentWorkspaceReadBroker({
    root: brokerRoot,
    documentIndex,
    historyAuthorization: {
      allowed: true,
      requestedBy: "user",
      reason: "user_explicit_history_request",
      gapId: "",
      canonLevel: "historical_non_canon",
      readOnly: true,
      commitBaselineEligible: false,
      allowedDocumentIds: ["chapter-1"],
      allowedVersionSelectors: ["previous"],
    },
  });
  const historical = await authorizedBroker.read_history_version({ documentId: "chapter-1", versionSelector: "previous" });
  assert.equal(historical.document.html, "历史正文");
  assert.equal(historical.canonLevel, "historical_non_canon");
  assert.equal(historical.commitBaselineEligible, false);
  assert.equal(historical.historyReadReason, "user_explicit_history_request");
  await assert.rejects(
    authorizedBroker.read_history_version({ documentId: "chapter-1", versionSelector: "oldest" }),
    (error) => error?.code === "HISTORY_VERSION_NOT_AUTHORIZED",
  );
  const redactedRuntime = createAgentWorkspaceToolRuntime({ broker: authorizedBroker, exposeAbsolutePaths: false });
  const structureResult = await redactedRuntime.invoke({ namespace: "workspace", tool: "structure", arguments: {} });
  const structurePayload = JSON.parse(structureResult.contentItems[0].text);
  assert.equal(structurePayload.result.root, ".");
  assert.deepEqual(structurePayload.result.readableRoots, ["."]);
} finally {
  await rm(brokerRoot, { recursive: true, force: true });
  await rm(otherRoot, { recursive: true, force: true });
}

const compatibleResult = await runtime.runStage({
  settings: compatibleProfile,
  prompt: "兼容接口测试",
  sessionId: "compatible-session-test",
  stage: "agent",
});
assert.equal(compatibleResult.text, "API Agent OK");
assert.equal(requested.url, "http://127.0.0.1:5317/v1/responses");

const invalid = runtime.supports({ settings: { ...profile, apiKey: "" }, stage: "agent", sessionId: "x" });
assert.equal(invalid, false);
assert.equal(runtime.supports({ settings: compatibleProfile, stage: "agent", sessionId: "compatible" }), true);
runtime.close();

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /<option value="codex_api">神思运行器<\/option>/u, "模型设置必须保留神思运行器选项");
assert.match(appSource, /<label>文字配置<select id="quickAgentEngine">/u, "对话区必须显示统一文字配置入口");
assert.match(appSource, /<select id="chatProviderSelect" hidden aria-hidden="true"><option value="codex_agent" selected>/u, "对话执行入口必须固定为统一 Agent");
assert.match(appSource, /<select name="textExecutionMode" hidden aria-hidden="true"><option value="agent" selected>/u, "文字配置设置必须默认 Agent-only");
assert.doesNotMatch(appSource, /<option value="codex_api">Codex API<\/option>/u, "UI 不得残留旧运行器名称");
assert.match(appSource, /patch\.provider = isCodexApiCompatibleProvider\(patch\.provider\) \? patch\.provider : "OpenAI";/u);
assert.match(appSource, /agentModelsForProfile\(configuredAgentProfile\)/u);
assert.doesNotMatch(appSource, /if \(isCodexApi\) \{\s+patch\.adapter = "api";\s+patch\.provider = "OpenAI";/u);
assert.doesNotMatch(appSource, /Chat\/Agent 模式选择/u, "对话区不得再暴露 Chat/Agent 模式选择");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /!isShensiAgentCompatibleProfile\(profile\)/u);
assert.match(serverSource, /provider,\s+adapter: "api",\s+protocol: String\(profile\.protocol \|\| "responses"\),\s+agentEngine: "codex_api"/u);
assert.match(serverSource, /runtimeSettings\.webSearchEnabled = requestedWebSearch && Boolean\(supportedWebSearchMode\)/u);
assert.match(serverSource, /const workspaceToolContext = options\.shensiRuntime\?\.workspaceToolContext;/u, "通用神思运行器路径必须读取当前工作区工具上下文");
assert.match(serverSource, /const workspaceToolRuntime = workspaceToolContext\?\.root[\s\S]{0,300}codexAgentProvider\.createWorkspaceToolRuntime\(/u, "通用神思运行器路径必须创建当前工作区只读工具");
assert.match(serverSource, /signal: options\.signal,\s+workspaceToolRuntime,/u, "通用神思运行器路径必须把只读工具交给 API Agent runtime");
assert.match(serverSource, /const generalWorkspaceToolContext = workspaceToolContextForModelRequest\(/u, "白板与通用 Agent 路径必须解析可信工作区上下文");
assert.match(serverSource, /generalAgentSessionId[\s\S]{0,900}workspaceToolContext: generalWorkspaceToolContext/u, "白板与通用 Agent 路径必须携带可信工作区上下文");
assert.match(serverSource, /const effectiveOptions = \{[\s\S]{0,700}workspaceToolContextForModelRequest\(/u, "完整创作链中的神思运行器也必须复用同一只读工作区工具边界");
assert.match(appSource, /webSearch: conversation\.webSearchEnabled === true/u);
assert.match(appSource, /const currentWebSearchMode = \(\) => \{\s+return webSearchMode\(generationSettingsForAgentEngine\(state\.settings,/u);
assert.match(appSource, /button\.disabled = !available;/u);
assert.match(appSource, /if \(Array\.isArray\(payload\.sources\)\) pending\.sources = clone\(payload\.sources\);/u);

const providerSource = await readFile(new URL("../src/server/codex-agent-provider.mjs", import.meta.url), "utf8");
assert.match(providerSource, /workspaceToolRuntime = await this\.createWorkspaceToolRuntime\(project, taskPacket\?\.workspaceToolContext \|\| \{\}, \{ exposeAbsolutePaths: false \}\)/u);
assert.match(providerSource, /workspaceToolRuntime,\s+onToolEvent:/u);
assert.doesNotMatch(providerSource, /codex_api_agent_is_context_only/u);

const cancellationRuntime = createCodexApiAgentRuntime({
  fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }),
});
const cancellation = new AbortController();
const pending = cancellationRuntime.runStage({ settings: profile, prompt: "可取消任务", sessionId: "cancel-test", stage: "agent", signal: cancellation.signal });
await new Promise((resolve) => setImmediate(resolve));
cancellation.abort();
await assert.rejects(pending, (error) => error?.code === "TASK_CANCELLED");
cancellationRuntime.close();
console.log("神思运行器 runtime tests passed");
