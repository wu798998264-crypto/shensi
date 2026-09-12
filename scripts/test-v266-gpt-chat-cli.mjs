import assert from "node:assert/strict";
import { applyGenerationRuntimeBindings, normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { CODEX_AGENT_MODE_LABEL } from "../src/codex-local-entry-policy.js";
import { resolveTrustedGenerationSettings } from "../src/server/generation-runtime-store.mjs";

assert.equal(CODEX_AGENT_MODE_LABEL, "Agent（复杂任务、工具调用与多步执行）");

const migrated = normalizeGenerationProfiles({
  activeTextConnectionId: "text-default",
  textConnections: [{
    id: "text-default",
    name: "OpenAI 文字",
    adapter: "cli",
    provider: "OpenAI",
    protocol: "responses",
    model: "gpt-5.6-sol",
    remarkName: "麻雀",
  }],
});

const gptChat = migrated.textConnections.find((profile) => profile.id === "text-default");
assert.equal(migrated.textConnections.filter((profile) => profile.id === "text-default").length, 1);
assert.equal(gptChat.name, "GPT Agent · Codex CLI");
assert.equal(gptChat.cliPath, "codex");
assert.match(gptChat.cliArgs, /exec/);
assert.equal(gptChat.remarkName, "麻雀");
assert.equal(gptChat.executionMode, "agent");
assert.deepEqual(gptChat.executionModes, ["agent"]);
assert.equal(gptChat.agentEngine, "codex");

const apiDefaultCollision = normalizeGenerationProfiles({
  activeTextConnectionId: "text-default",
  activeTextChatConnectionId: "text-default",
  textConnections: [{
    id: "text-default",
    name: "OpenAI API",
    adapter: "api",
    provider: "OpenAI",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    apiKey: "configured-locally",
    unknownExtension: { preserved: true },
  }],
});
const preservedApi = apiDefaultCollision.textConnections.find((profile) => profile.id === "text-default");
const separateCodex = apiDefaultCollision.textConnections.find((profile) => profile.id === "text-openai-codex-cli");
assert.equal(preservedApi.adapter, "api", "固定 ID 被 API 占用时不得把旧配置改造成 Codex CLI");
assert.deepEqual(preservedApi.unknownExtension, { preserved: true });
assert.equal(separateCodex.adapter, "cli");
assert.equal(separateCodex.agentEngine, "codex");
assert.equal(apiDefaultCollision.activeTextConnectionId, "text-default");

const collapsedCodex = normalizeGenerationProfiles({
  activeTextConnectionId: "text-openai-codex-cli",
  activeTextChatConnectionId: "text-default",
  activeTextAgentConnectionId: "text-openai-codex-cli",
  textConnections: [
    {
      id: "text-default",
      name: "GPT Chat · Codex CLI",
      adapter: "cli",
      provider: "OpenAI",
      protocol: "responses",
      model: "gpt-5.6-sol",
      cliPath: "codex",
      cliArgs: "exec --json",
      agentEngine: "codex",
      executionModes: ["chat", "agent"],
    },
    {
      id: "text-openai-codex-cli",
      name: "OpenAI CLI",
      adapter: "cli",
      provider: "OpenAI",
      protocol: "responses",
      model: "gpt-5.6-sol",
      cliPath: "codex",
      cliArgs: "exec --json",
      agentEngine: "codex",
      executionModes: ["chat", "agent"],
    },
  ],
});
assert.equal(collapsedCodex.textConnections.filter((profile) => profile.adapter === "cli" && profile.agentEngine === "codex").length, 1);
assert.equal(collapsedCodex.activeTextConnectionId, "text-default");
assert.equal(collapsedCodex.activeTextAgentConnectionId, "text-default");

const reboundCodex = applyGenerationRuntimeBindings(collapsedCodex, {
  bindings: [{
    channel: "text",
    profileId: "text-openai-codex-cli",
    adapter: "cli",
    provider: "OpenAI",
    protocol: "responses",
    cliPath: "codex",
    cliArgs: "exec --json",
  }],
});
assert.equal(reboundCodex.textConnections.filter((profile) => profile.adapter === "cli" && profile.agentEngine === "codex").length, 1);
assert.equal(reboundCodex.textConnections.some((profile) => profile.id === "text-openai-codex-cli"), false);

const nonOpenAiActive = normalizeGenerationProfiles({
  activeTextConnectionId: "deepseek-main",
  textConnections: [
    {
      id: "deepseek-main",
      name: "DeepSeek API",
      adapter: "api",
      provider: "DeepSeek",
      protocol: "chat_completions",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "configured-locally",
    },
    {
      id: "deepseek-agent",
      name: "DeepSeek CLI",
      adapter: "cli",
      provider: "DeepSeek",
      protocol: "chat_completions",
      model: "deepseek-v4-pro",
      apiKey: "configured-locally",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "deepseek_opencode",
      cliPath: "shensi-deepseek-opencode",
      cliArgs: "--model {model}",
    },
  ],
});
assert.equal(nonOpenAiActive.activeTextConnectionId, "deepseek-main");
const deepSeekChat = nonOpenAiActive.textConnections.find((profile) => profile.id === "deepseek-main");
const deepSeekAgent = nonOpenAiActive.textConnections.find((profile) => profile.id === "deepseek-agent");
assert.equal(deepSeekChat.name, "DeepSeek API");
assert.equal(deepSeekChat.executionMode, "agent");
assert.equal(deepSeekAgent.name, "DeepSeek Agent");
assert.equal(deepSeekAgent.executionMode, "agent");
assert.deepEqual(deepSeekAgent.executionModes, ["agent"]);
assert.equal(deepSeekAgent.agentEngine, "opencode");
assert.equal(deepSeekAgent.model, "deepseek/deepseek-v4-pro");
assert.equal(deepSeekAgent.cliPath, "opencode");
assert.equal(deepSeekAgent.cliArgs, "");
assert.ok(nonOpenAiActive.textConnections.some((profile) => profile.provider === "OpenAI"
  && profile.adapter === "cli"
  && profile.cliPath === "codex"));

const persisted = [];
const trusted = await resolveTrustedGenerationSettings({
  channel: "text",
  settings: migrated,
  resolveCodexLaunch: async () => ({ executable: "codex.exe", prefixArgs: [] }),
  persistBindings: async ({ bindings }) => {
    persisted.push(...bindings);
    return { schemaVersion: 1, revision: 1, bindings };
  },
});
assert.equal(trusted.provider, "OpenAI");
assert.equal(trusted.adapter, "cli");
assert.equal(trusted.cliPath, "codex.exe");
assert.match(trusted.cliArgs, /exec/);
assert.equal(trusted.connectionId, "text-default");
assert.equal(persisted.length, 1);
assert.equal(persisted[0].channel, "text");
assert.equal(persisted[0].profileId, "text-default");

await assert.rejects(
  resolveTrustedGenerationSettings({
    channel: "text",
    settings: {
      id: `untrusted-${Date.now()}`,
      adapter: "cli",
      provider: "OpenAI",
      protocol: "responses",
      model: "gpt-5.6-sol",
      cliPath: "untrusted-openai-wrapper.exe",
      cliArgs: "run",
    },
  }),
  (error) => error?.code === "LOCAL_RUNTIME_BINDING_REQUIRED",
);

console.log("v2.6.7 unified GPT and DeepSeek Agent profile tests passed");
