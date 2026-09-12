import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-opencode-dual-"));
process.env.SHENSI_MACHINE_DATA_ROOT = root;

try {
  const runtime = await import(`../src/server/generation-runtime-store.mjs?dual=${Date.now()}`);
  const binding = {
    channel: "text",
    profileId: "text-deepseek-opencode",
    adapter: "cli",
    provider: "DeepSeek",
    protocol: "chat_completions",
    baseUrl: "https://api.deepseek.com/v1",
    cliPath: "opencode",
    cliArgs: "",
    chatAdapter: "api",
    chatProtocol: "chat_completions",
    chatBaseUrl: "https://api.deepseek.com/v1",
  };
  await runtime.saveGenerationRuntimeBindings({ bindings: [binding] });
  const profile = {
    id: binding.profileId,
    connectionId: binding.profileId,
    adapter: "cli",
    provider: "DeepSeek",
    protocol: "chat_completions",
    baseUrl: binding.baseUrl,
    cliPath: "opencode",
    cliArgs: "",
    model: "deepseek/deepseek-chat",
    chatModelId: "deepseek-chat",
    agentModelId: "deepseek/deepseek-chat",
    agentEngine: "opencode",
    credentialSource: "shensi",
    executionMode: "both",
    executionModes: ["chat", "agent"],
    apiKey: "test-only-secret",
  };
  const chat = await runtime.resolveTrustedGenerationSettings({ channel: "text", settings: profile, route: "chat" });
  assert.equal(chat.adapter, "cli");
  assert.equal(chat.model, "deepseek/deepseek-chat");
  assert.equal(chat.baseUrl, binding.chatBaseUrl);
  assert.equal(chat.cliPath, "opencode");
  assert.equal(chat.apiKey, "test-only-secret");
  assert.equal(chat.agentEngine, "opencode", "历史 route 参数不得恢复 API 双模式投影");
  assert.equal(chat.agentModelId, "deepseek/deepseek-chat");

  const agent = await runtime.resolveTrustedGenerationSettings({ channel: "text", settings: profile });
  assert.equal(agent.adapter, "cli");
  assert.equal(agent.model, "deepseek/deepseek-chat");
  assert.equal(agent.cliPath, "opencode");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("OpenCode + provider API dual runtime routing tests passed");
