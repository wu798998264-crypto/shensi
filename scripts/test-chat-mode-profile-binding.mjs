import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activateGenerationProfile,
  activateTextExecutionModeProfile,
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
assert.equal(staleAgentSettings.activeTextChatConnectionId, "codex-agent",
  "选择文字配置后，历史 Chat 指针也必须同步到同一 Agent 配置");

const chatSettings = activateTextExecutionModeProfile(staleAgentSettings, "chat");
assert.equal(activeGenerationProfile(chatSettings, "text")?.id, "codex-agent");
assert.equal(chatSettings.provider, "OpenAI");
assert.equal(chatSettings.adapter, "cli");
assert.equal(chatSettings.model, "gpt-5.6-sol");
assert.equal(chatSettings.activeTextChatConnectionId, "codex-agent",
  "旧 Chat 请求也必须映射到统一 Agent 配置，不能恢复双模式选择");

const agentSettings = activateTextExecutionModeProfile(chatSettings, "agent");
assert.equal(activeGenerationProfile(agentSettings, "text")?.id, "codex-agent");
assert.equal(agentSettings.provider, "OpenAI");
assert.equal(agentSettings.adapter, "cli");

const directSettings = { provider: "免费模型", adapter: "api", baseUrl: "https://api.kilo.ai/api/openrouter", model: "tencent/hy3:free" };
assert.equal(activateTextExecutionModeProfile(directSettings, "chat"), directSettings, "仅携带直接设置的请求不得被默认配置覆盖");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(appSource, /settingsOverride \?\? activateTextExecutionModeProfile\(requestWorkspaceState\.settings, "chat"\)/u);
assert.match(appSource, /const switchConversationMode = async \(provider\) => \{\s*provider = "codex_agent"/u,
  "用户可见文字入口必须固定为统一 Agent");
assert.match(appSource, /state\.settings = activateTextExecutionModeProfile\([\s\S]{0,180}payload\.provider === "codex_agent" \? "agent" : "chat"/u);
assert.match(appSource, /generationConnectionIsConfigured\("text", activeQuickChatProfile\(\)\)/u);
assert.match(serverSource, /trustedConversationModelSettings\(body\.settings, \{ executionSurface: body\.executionSurface \}\)/u);
assert.match(serverSource, /body\.settings = trustedChatSettings/u);
assert.match(serverSource, /effectiveRuntimeContract\(\{ settings, surface \}\)/u, "服务端必须在 Codex 登录门禁前校验当前 Chat\/Agent 配置身份");

console.log("chat mode profile binding tests passed");
