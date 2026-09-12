import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activateGenerationProfile,
  activateTextAgentProfile,
  activeGenerationProfile,
  normalizeGenerationProfiles,
} from "../src/generation-profiles.js";

const settings = normalizeGenerationProfiles({
  textConnections: [
    {
      id: "codex-agent",
      name: "Codex",
      provider: "OpenAI",
      adapter: "cli",
      protocol: "responses",
      model: "gpt-5.6-sol",
      cliPath: "codex",
      executionMode: "both",
      executionModes: ["chat", "agent"],
      agentEngine: "codex",
    },
    {
      id: "text-public-kilo",
      name: "免费模型",
      provider: "免费模型",
      adapter: "api",
      protocol: "chat_completions",
      baseUrl: "https://api.kilo.ai/api/openrouter",
      model: "tencent/hy3:free",
      apiKey: "",
      maxOutputTokens: "10000",
      executionMode: "chat",
      executionModes: ["chat"],
    },
  ],
  activeTextConnectionId: "codex-agent",
  activeTextChatConnectionId: "text-public-kilo",
  activeTextAgentConnectionId: "codex-agent",
});

const staleAgentSettings = activateGenerationProfile(settings, "text", "codex-agent");
assert.equal(activeGenerationProfile(staleAgentSettings, "text")?.id, "codex-agent");
assert.equal(Object.hasOwn(staleAgentSettings, "activeTextChatConnectionId"), false);

const chatSettings = activateTextAgentProfile(staleAgentSettings);
assert.equal(activeGenerationProfile(chatSettings, "text")?.id, "codex-agent");
assert.equal(chatSettings.provider, "OpenAI");
assert.equal(chatSettings.adapter, "cli");
assert.equal(chatSettings.model, "gpt-5.6-sol");
assert.equal(chatSettings.activeTextAgentConnectionId, "codex-agent");

const agentSettings = activateTextAgentProfile(chatSettings);
assert.equal(activeGenerationProfile(agentSettings, "text")?.id, "codex-agent");
assert.equal(agentSettings.provider, "OpenAI");
assert.equal(agentSettings.adapter, "cli");

const directSettings = { provider: "免费模型", adapter: "api", baseUrl: "https://api.kilo.ai/api/openrouter", model: "tencent/hy3:free" };
assert.equal(activateTextAgentProfile(directSettings), directSettings, "仅携带直接设置的请求不得被默认配置覆盖");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(appSource, /generationSettingsForAgentEngine\(settingsOverride/u);
assert.doesNotMatch(appSource, /const switchConversationMode/u);
assert.match(appSource, /generationConnectionIsConfigured\("text", activeQuickAgentProfile\(\)\)/u);
assert.match(serverSource, /body\.settings = trustedAgentSettings/u);
assert.match(serverSource, /effectiveRuntimeContract\(\{ settings, surface \}\)/u, "服务端必须在 Codex 登录门禁前校验当前 Chat\/Agent 配置身份");

console.log("chat mode profile binding tests passed");
