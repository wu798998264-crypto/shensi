import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CODEX_CHAT_MODE_LABEL,
  CODEX_AGENT_MODE_LABEL,
  SETTINGS_BOTH_MODE_LABEL,
  codexCliProfile,
  codexSettingsActionState,
  detectedCodexTemporaryOption,
  shouldOfferDetectedCodexEntry,
  materializeDetectedCodexProfile,
} from "../src/codex-local-entry-policy.js";
import { applyGenerationRuntimeBindings, normalizeGenerationProfiles, removeGenerationProfile } from "../src/generation-profiles.js";
import { buildCliEnvironment, codexLoginStateFromOutput } from "../src/server/adapters.mjs";
import { CodexAgentProvider } from "../src/server/codex-agent-provider.mjs";

const capability = {
  available: true,
  version: "codex-cli test",
  cliPath: "C:/tools/codex.exe",
  cliArgs: "exec --ephemeral -",
  defaultModel: "gpt-5.6-sol",
  models: [{ slug: "gpt-5.6-sol", defaultReasoningLevel: "medium" }],
};

assert.deepEqual(codexLoginStateFromOutput("Logged in using ChatGPT"), {
  authenticated: true,
  authState: "authenticated",
});
assert.deepEqual(codexLoginStateFromOutput("Not logged in"), {
  authenticated: false,
  authState: "login_required",
});
assert.deepEqual(codexLoginStateFromOutput("unexpected status output"), {
  authenticated: null,
  authState: "unknown",
});

const deepSeek = {
  id: "deepseek-main",
  name: "DeepSeek Chat · API",
  provider: "DeepSeek",
  adapter: "api",
  model: "deepseek-chat",
  executionMode: "chat",
  executionModes: ["chat"],
  customExtension: { preserve: true },
};

assert.equal(CODEX_CHAT_MODE_LABEL, "Chat（快速问答、讨论与单次写作）");
assert.equal(CODEX_AGENT_MODE_LABEL, "Agent（复杂任务、工具调用与多步执行）");
assert.equal(SETTINGS_BOTH_MODE_LABEL, "Chat 与 Agent（同一配置兼备两种运行模式）");

const newTextDraft = { id: "draft-text", draft: true, adapter: "", provider: "", agentEngine: "" };
assert.deepEqual(codexSettingsActionState({
  profile: newTextDraft,
  saved: false,
  executionMode: "chat",
  agentEngine: "",
  codexCapability: { available: true },
}), {
  showConnectCodex: false,
  showAddOpenCode: false,
  connectCodexDisabled: false,
  connectCodexAction: "connect",
  connectCodexLabel: "连接当前 Codex CLI",
});
for (const executionMode of ["agent", "both"]) {
  assert.deepEqual(codexSettingsActionState({
    profile: newTextDraft,
    saved: false,
    executionMode,
    agentEngine: "",
    codexCapability: { available: true },
  }), {
    showConnectCodex: true,
    showAddOpenCode: true,
    connectCodexDisabled: false,
    connectCodexAction: "connect",
    connectCodexLabel: "连接当前 Codex CLI",
  });
}
assert.deepEqual(codexSettingsActionState({
  profile: newTextDraft,
  saved: false,
  hasSavedCodexProfile: true,
  executionMode: "agent",
  agentEngine: "",
  codexCapability: { available: true },
}), {
  showConnectCodex: false,
  showAddOpenCode: true,
  connectCodexDisabled: false,
  connectCodexAction: "connect",
  connectCodexLabel: "连接当前 Codex CLI",
}, "已有 Codex 配置时，新草稿只能提供 OpenCode，不能重复连接 Codex");
assert.equal(codexSettingsActionState({
  profile: newTextDraft,
  saved: false,
  executionMode: "agent",
  agentEngine: "codex",
  codexCapability: { available: true },
}).showAddOpenCode, false);
assert.equal(codexSettingsActionState({
  profile: newTextDraft,
  saved: false,
  executionMode: "agent",
  agentEngine: "opencode",
  codexCapability: { available: true },
}).showConnectCodex, false);
const savedCodexProfile = { id: "saved-codex", adapter: "cli", provider: "OpenAI", agentEngine: "codex", cliPath: "codex" };
assert.equal(codexSettingsActionState({
  profile: savedCodexProfile,
  saved: true,
  executionMode: "both",
  agentEngine: "codex",
  codexCapability: { available: true },
}).showConnectCodex, false, "已有且已检测的 Codex 配置不得继续显示连接按钮");
assert.deepEqual(codexSettingsActionState({
  profile: savedCodexProfile,
  saved: true,
  executionMode: "both",
  agentEngine: "codex",
  codexCapability: { available: false },
}), {
  showConnectCodex: true,
  showAddOpenCode: false,
  connectCodexDisabled: false,
  connectCodexAction: "redetect",
  connectCodexLabel: "重新检测 Codex CLI",
});

assert.equal(shouldOfferDetectedCodexEntry({ capability: { available: false }, profiles: [] }), false);
assert.equal(shouldOfferDetectedCodexEntry({ capability, profiles: [deepSeek] }), true);
assert.equal(shouldOfferDetectedCodexEntry({
  capability,
  profiles: [{ id: "codex-existing", provider: "OpenAI", adapter: "cli", agentEngine: "codex", cliPath: "codex" }],
}), false);

const temporary = detectedCodexTemporaryOption(capability);
assert.equal(temporary.id, "__detected_codex_cli__");
assert.equal(temporary.label, "GPT Chat · Codex CLI（本机已检测）");
assert.equal(temporary.temporary, true);
assert.deepEqual(temporary.executionModes, ["chat", "agent"]);

const baseline = {
  textConnections: [structuredClone(deepSeek)],
  activeTextConnectionId: "deepseek-main",
  activeTextChatConnectionId: "deepseek-main",
  disabledBuiltInTextProfileIds: ["text-default"],
  unrelated: { unchanged: true },
};
const baselineSnapshot = structuredClone(baseline);
assert.equal(shouldOfferDetectedCodexEntry({ capability, profiles: baseline.textConnections }), true);
assert.deepEqual(baseline, baselineSnapshot, "只读检测和临时入口不能改写配置");

const materialized = materializeDetectedCodexProfile(baseline, capability, { activate: true });
assert.equal(materialized.created, true);
assert.equal(materialized.profile.id, "text-default");
assert.equal(materialized.profile.name, "GPT Chat · Codex CLI");
assert.equal(materialized.profile.provider, "OpenAI");
assert.equal(materialized.profile.adapter, "cli");
assert.equal(materialized.profile.executionMode, "both");
assert.deepEqual(materialized.profile.executionModes, ["chat", "agent"]);
assert.equal(materialized.profile.agentEngine, "codex");
assert.equal(materialized.profile.credentialSource, "codex_session", "本机 Codex 配置必须显式使用 Codex 登录会话");
assert.equal(materialized.profile.apiKey, "");
assert.equal(materialized.settings.activeTextConnectionId, "text-default");
assert.equal(materialized.settings.textConnections.find((item) => item.id === "deepseek-main").customExtension.preserve, true);
assert.equal(materialized.settings.unrelated.unchanged, true);
assert.equal(materialized.settings.disabledBuiltInTextProfileIds.includes("text-default"), false);

assert.equal(
  Object.hasOwn(buildCliEnvironment({
    ...materialized.profile,
    apiKey: "stale-openai-key-must-not-reach-codex",
  }), "OPENAI_API_KEY"),
  false,
  "Codex 登录模式不得把历史 OpenAI API Key 注入 CLI 并覆盖 ChatGPT 登录",
);

const reused = materializeDetectedCodexProfile(materialized.settings, { ...capability, cliPath: "C:/other/codex.exe" }, { activate: false });
assert.equal(reused.created, false);
assert.equal(reused.profile.id, "text-default");
assert.equal(reused.profile.cliPath, capability.cliPath, "已有 Codex 配置必须原样复用");
assert.equal(reused.settings.activeTextConnectionId, "text-default");
assert.equal(reused.settings.textConnections.filter(codexCliProfile).length, 1);

const collision = materializeDetectedCodexProfile({
  ...baseline,
  textConnections: [{ ...deepSeek, id: "text-default" }],
}, capability, { activate: false });
assert.notEqual(collision.profile.id, "text-default");
assert.equal(collision.settings.textConnections.find((item) => item.id === "text-default").provider, "DeepSeek");

const normalizedWithCodex = normalizeGenerationProfiles({
  textConnections: [deepSeek],
  activeTextConnectionId: "deepseek-main",
});
const builtInCodex = normalizedWithCodex.textConnections.find(codexCliProfile);
assert.ok(builtInCodex);
const removedCodex = removeGenerationProfile(normalizedWithCodex, "text", builtInCodex.id);
const normalizedAfterRemoval = normalizeGenerationProfiles(removedCodex);
assert.equal(normalizedAfterRemoval.textConnections.some(codexCliProfile), false, "用户删除 Codex 后不得被归一化自动恢复");
assert.ok(normalizedAfterRemoval.disabledBuiltInTextProfileIds.includes("text-default"));
assert.ok(normalizedAfterRemoval.disabledBuiltInTextProfileIds.includes(builtInCodex.id));
const afterStaleRuntimeBinding = applyGenerationRuntimeBindings(normalizedAfterRemoval, {
  bindings: [{
    channel: "text",
    profileId: builtInCodex.id,
    adapter: "cli",
    provider: "OpenAI",
    protocol: "responses",
    cliPath: "codex",
    cliArgs: "exec -",
  }],
});
assert.equal(afterStaleRuntimeBinding.textConnections.some(codexCliProfile), false, "旧运行时绑定不得恢复用户已删除的 Codex 配置");

const rpcCalls = [];
const disconnected = await CodexAgentProvider.prototype.disconnectAccount.call({
  account: { account: { type: "chatgpt" } },
  accountLogin: { active: false },
  accountRefreshSequence: 0,
  ensureStarted: async () => {},
  request: async (method) => {
    rpcCalls.push(method);
    if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
    return {};
  },
  refreshAccountState: CodexAgentProvider.prototype.refreshAccountState,
  emit: () => {},
  status: () => ({ codexAuthenticated: false }),
});
assert.deepEqual(rpcCalls, ["account/logout", "account/read"]);
assert.equal(disconnected.status.codexAuthenticated, false);

const pendingReads = [];
const refreshHarness = {
  account: null,
  accountRefreshSequence: 0,
  lastError: "",
  request: () => new Promise((resolve) => pendingReads.push(resolve)),
};
const oldRead = CodexAgentProvider.prototype.refreshAccountState.call(refreshHarness);
const newRead = CodexAgentProvider.prototype.refreshAccountState.call(refreshHarness);
pendingReads[1]({ account: { type: "chatgpt", marker: "new" } });
await newRead;
pendingReads[0]({ account: { type: "chatgpt", marker: "old" } });
const staleRead = await oldRead;
assert.equal(staleRead.stale, true);
assert.equal(refreshHarness.account.account.marker, "new", "旧账户读取结果不得覆盖较新的登录状态");

await assert.rejects(
  () => CodexAgentProvider.prototype.requireConnectedAccount.call({
    state: { agentPermissionMode: "shensi_only" },
    account: { account: null, requiresOpenaiAuth: true },
    ensureStarted: async () => {},
    refreshAccountState: async () => ({ stale: false }),
  }),
  /Codex 未连接/u,
  "断开或过期后不得继续提交 Agent 任务",
);

const [appSource, serverSource, providerSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/codex-agent-provider.mjs", import.meta.url), "utf8"),
]);
assert.match(appSource, /DETECTED_CODEX_CONNECTION_ID[\s\S]{0,800}temporaryCodexSelected = true/u);
assert.match(appSource, /setDraftSelectPlaceholder\(form\.textAgentEngine, "请选择运行器", draft\)/u, "新建文字配置时运行器不得显示为空白");
assert.match(appSource, /patch\.credentialSource = "codex_session";[\s\S]{0,120}patch\.apiKey = "";/u, "保存 Codex CLI 配置时必须清除隐藏的旧 API Key");
assert.match(appSource, /const startCodexLogin[\s\S]{0,500}\/api\/codex-agent\/account\/login[\s\S]{0,500}window\.open\(authUrl/u, "登录按钮必须启动 Codex 账户授权并打开返回的授权地址");
assert.match(appSource, /refreshCodexAgentStatus\(\{ refreshAccount: currentCodexConnectionSelected\(\) \}\)/u, "工作区恢复后必须探测当前 Codex 连接状态");
assert.match(appSource, /directCliAuthenticated = selected && ui\.localCodex\?\.authenticated === true/u, "Codex CLI 配置必须采用 CLI 自身登录探测结果");
assert.match(appSource, /settingsDisconnect\.hidden = !settingsSelected \|\| !actualConnected/u, "CLI 登录探测不得伪造可用的 app-server 退出操作");
assert.match(serverSource, /trustedChatSettings[\s\S]{0,700}requireConnectedAccount\(\)/u, "Codex Chat 也必须经过当前登录会话门禁");
assert.match(serverSource, /\/api\/codex-agent\/account\/logout/u);
assert.match(providerSource, /request\("account\/logout"/u);
assert.match(providerSource, /if \(shensiOnly\)[\s\S]{0,500}mkdir\(codexEnvironment\.CODEX_HOME, \{ recursive: true \}\)[\s\S]{0,500}spawnLocalCodexAppServer/u, "仅神思 Codex 登录必须先创建隔离账户目录再启动 app-server");
assert.doesNotMatch(providerSource, /forceReauth/u);

console.log("Codex detected temporary entry and login materialization contracts passed");
