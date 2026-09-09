import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveRuntimeContract,
  runtimeContractForProfile,
  shouldShowCodexAccountControls,
} from "../src/effective-runtime-contract.js";
import { resolveTrustedGenerationSettings } from "../src/server/generation-runtime-store.mjs";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const settings = normalizeGenerationProfiles({
  activeTextChatConnectionId: "openai-both",
  activeTextAgentConnectionId: "opencode-deepseek",
  textConnections: [
    {
      id: "openai-both",
      provider: "OpenAI",
      adapter: "cli",
      model: "gpt-5.6-sol",
      executionMode: "both",
      executionModes: ["chat", "agent"],
      agentEngine: "codex",
      credentialSource: "codex",
    },
    {
      id: "deepseek-chat",
      provider: "DeepSeek",
      adapter: "api",
      protocol: "chat_completions",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      executionMode: "chat",
      executionModes: ["chat"],
      credentialSource: "shensi",
    },
    {
      id: "opencode-deepseek",
      provider: "DeepSeek",
      adapter: "cli",
      protocol: "chat_completions",
      baseUrl: "https://api.openai.com/v1",
      cliPath: process.execPath,
      cliArgs: "",
      model: "deepseek/deepseek-v4-pro",
      agentModelId: "deepseek/deepseek-v4-pro",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "opencode",
      credentialSource: "shensi",
    },
    {
      id: "claude-deepseek",
      provider: "DeepSeek",
      adapter: "cli",
      model: "deepseek-v4-pro[1m]",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "claude_code",
      credentialSource: "shensi",
    },
  ],
}, { text: { "deepseek-chat": "test-only" } });
const profileById = (id) => settings.textConnections.find((profile) => profile.id === id);
const legacyClaudeProfile = {
  id: "claude-deepseek",
  provider: "DeepSeek",
  adapter: "cli",
  protocol: "responses",
  model: "deepseek-v4-pro",
  agentModelId: "deepseek-v4-pro",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "claude_code",
  credentialSource: "shensi",
};
assert.equal(profileById("claude-deepseek"), undefined, "重复 DeepSeek Agent 配置必须在归一化后清除");

const chat = effectiveRuntimeContract({ settings, surface: "chat" });
assert.equal(chat.ok, true);
assert.equal(chat.profileId, "opencode-deepseek");
assert.equal(chat.surface, "agent");
assert.equal(chat.legacyRequestedSurface, "chat");
assert.equal(chat.runner, "opencode");
assert.equal(chat.provider, "DeepSeek");
assert.equal(chat.model, "deepseek/deepseek-v4-pro");

const agent = effectiveRuntimeContract({ settings, surface: "agent" });
assert.equal(agent.ok, true);
assert.equal(agent.profileId, "opencode-deepseek");
assert.equal(agent.runner, "opencode");
assert.equal(agent.provider, "DeepSeek");
assert.equal(agent.model, "deepseek/deepseek-v4-pro");
assert.equal(agent.credentialSource, "shensi");

const explicitChat = effectiveRuntimeContract({ settings, surface: "chat", profileId: "deepseek-chat" });
assert.equal(explicitChat.ok, false, "DeepSeek API 配置不能冒充神思运行器的兼容接口");
assert.equal(explicitChat.code, "CODEX_PROVIDER_MISMATCH");

const explicitCustomApi = runtimeContractForProfile({
  profile: { ...profileById("deepseek-chat"), provider: "自定义兼容接口" },
  surface: "agent",
});
assert.equal(explicitCustomApi.ok, true);
assert.equal(explicitCustomApi.surface, "agent");
assert.equal(explicitCustomApi.runner, "codex_api_agent");
assert.equal(explicitCustomApi.model, "deepseek-chat");

const legacySurface = effectiveRuntimeContract({ settings, surface: "chat", profileId: "opencode-deepseek" });
assert.equal(legacySurface.ok, true);
assert.equal(legacySurface.surface, "agent");
assert.equal(legacySurface.profileId, "opencode-deepseek", "旧 Chat surface 不能偷偷回退到其他配置");

const invalidOpenCode = runtimeContractForProfile({
  profile: { ...profileById("opencode-deepseek"), model: "deepseek-v4-pro", agentModelId: "" },
  surface: "agent",
});
assert.equal(invalidOpenCode.ok, false);
assert.equal(invalidOpenCode.code, "OPENCODE_MODEL_ID_INVALID");

const invalidCodex = runtimeContractForProfile({
  profile: { ...profileById("openai-both"), model: "openai/gpt-5.6-sol", agentModelId: "openai/gpt-5.6-sol" },
  surface: "agent",
});
assert.equal(invalidCodex.ok, false);
assert.equal(invalidCodex.code, "CODEX_MODEL_ID_INVALID");

const claude = runtimeContractForProfile({ profile: legacyClaudeProfile, surface: "agent" });
assert.equal(claude.ok, true);
assert.equal(claude.runner, "claude_code");
assert.equal(claude.provider, "DeepSeek");
assert.equal(claude.model, "deepseek-v4-pro", "配置归一化会去掉旧 Claude 模型的上下文后缀");

assert.equal(shouldShowCodexAccountControls(profileById("openai-both")), true);
assert.equal(shouldShowCodexAccountControls(profileById("opencode-deepseek")), false);
assert.equal(shouldShowCodexAccountControls(legacyClaudeProfile), false);

const bindingRoot = await mkdtemp(join(tmpdir(), "shensi-v300-runtime-contract-"));
try {
  process.env.SHENSI_MACHINE_DATA_ROOT = bindingRoot;
  await mkdir(join(bindingRoot, "config"), { recursive: true });
  await writeFile(join(bindingRoot, "config", "generation-runtime-v1.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-09-06T00:00:00.000Z",
    bindings: [{
      channel: "text",
      profileId: "opencode-deepseek",
      adapter: "cli",
      provider: "DeepSeek",
      protocol: "chat_completions",
      baseUrl: "https://api.openai.com/v1",
      cliPath: process.execPath,
      cliArgs: "",
    }],
  }, null, 2), "utf8");

  const routedChat = await resolveTrustedGenerationSettings({
    channel: "text",
    route: "chat",
    settings,
    resolveCodexLaunch: async () => ({ executable: process.execPath, prefixArgs: [] }),
    persistBindings: async ({ bindings }) => {
      await writeFile(join(bindingRoot, "config", "generation-runtime-v1.json"), JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        updatedAt: "2026-09-06T00:00:00.000Z",
        bindings,
      }, null, 2), "utf8");
      return { ok: true, schemaVersion: 1, revision: 2, bindings };
    },
  });
  assert.equal(routedChat.connectionId, "opencode-deepseek", "旧 Chat route 必须映射到统一活动 Agent 配置");
  assert.equal(routedChat.provider, "DeepSeek");
  assert.equal(routedChat.adapter, "cli");

  const routedChatWithBinding = await resolveTrustedGenerationSettings({
    channel: "text",
    route: "chat",
    settings,
    resolveCodexLaunch: async () => ({ executable: process.execPath, prefixArgs: [] }),
    persistBindings: async ({ bindings }) => {
      await writeFile(join(bindingRoot, "config", "generation-runtime-v1.json"), JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        updatedAt: "2026-09-06T00:00:00.000Z",
        bindings,
      }, null, 2), "utf8");
      return { schemaVersion: 1, revision: 3, bindings };
    },
  });
  assert.equal(routedChatWithBinding.connectionId, "opencode-deepseek");
  assert.equal(routedChatWithBinding.cliPath, process.execPath);
  assert.equal(routedChatWithBinding.cliArgs, "");
  const persistedStore = JSON.parse(await readFile(join(bindingRoot, "config", "generation-runtime-v1.json"), "utf8"));
  assert.equal(persistedStore.schemaVersion, 1);
  assert.equal(persistedStore.revision, 1, "已有一致的本机绑定无需重复写入");
  assert.equal(persistedStore.bindings[0].profileId, "opencode-deepseek");
} finally {
  delete process.env.SHENSI_MACHINE_DATA_ROOT;
  await rm(bindingRoot, { recursive: true, force: true });
}

console.log("v3.0 effective runtime contract tests passed");
