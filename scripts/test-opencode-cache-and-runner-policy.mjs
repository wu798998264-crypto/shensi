import assert from "node:assert/strict";

import {
  openCodeCatalogCacheKey,
  openCodeCatalogGroupsForProvider,
  openCodeProviderFallbackGroup,
  openCodeModelMatchesProvider,
  openCodeRunnerDefaults,
} from "../src/opencode-profile-ui-policy.js";
import { codexSettingsProfile } from "../src/codex-local-entry-policy.js";
import { generationRuntimeBindings } from "../src/generation-profiles.js";

assert.notEqual(
  openCodeCatalogCacheKey({ credentialSource: "shensi", provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/" }),
  openCodeCatalogCacheKey({ credentialSource: "shensi", provider: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
  "不同服务商不得共享 OpenCode 模型缓存",
);
assert.notEqual(
  openCodeCatalogCacheKey({ credentialSource: "opencode", provider: "DeepSeek", baseUrl: "" }),
  openCodeCatalogCacheKey({ credentialSource: "shensi", provider: "DeepSeek", baseUrl: "" }),
  "不同凭据来源不得共享 OpenCode 模型缓存",
);
assert.notEqual(
  openCodeCatalogCacheKey({ runner: "opencode", credentialSource: "shensi", provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" }),
  openCodeCatalogCacheKey({ runner: "codex", credentialSource: "shensi", provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" }),
  "不同运行器不得共享模型目录缓存",
);
assert.equal(
  openCodeCatalogCacheKey({ credentialSource: "shensi", provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/" }),
  openCodeCatalogCacheKey({ credentialSource: "shensi", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
  "缓存键应规范化服务商、URL 尾斜杠和大小写",
);

const groups = [
  { provider: "deepseek", models: [{ slug: "deepseek/deepseek-chat" }] },
  { provider: "openai", models: [{ slug: "openai/gpt-5.6-sol" }] },
];
assert.deepEqual(openCodeCatalogGroupsForProvider(groups, "DeepSeek"), [groups[0]]);
assert.deepEqual(openCodeCatalogGroupsForProvider(groups, "OpenAI"), [groups[1]]);
assert.equal(openCodeModelMatchesProvider("deepseek/deepseek-chat", "DeepSeek"), true);
assert.equal(openCodeModelMatchesProvider("openai/gpt-5.6-sol", "DeepSeek"), false);
assert.deepEqual(
  openCodeProviderFallbackGroup("DeepSeek", [
    { slug: "deepseek-v4-pro", label: "DeepSeek V4 Pro", available: true },
    { slug: "deepseek-v4-flash", label: "DeepSeek V4 Flash", available: true },
  ]),
  {
    provider: "deepseek",
    source: "provider_preset_unverified",
    models: [
      { slug: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", available: false },
      { slug: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", available: false },
    ],
  },
  "尚未完成动态扫描时也只能显示当前服务商自己的候选模型",
);
assert.equal(
  openCodeProviderFallbackGroup("DeepSeek", [{ slug: "openai/gpt-5.6-sol", label: "GPT" }]).models.length,
  0,
  "DeepSeek 服务商下不得残留 OpenAI 模型",
);

assert.deepEqual(openCodeRunnerDefaults("opencode"), {
  adapter: "cli",
  cliPath: "opencode",
  cliArgs: "",
  requiresQualifiedModel: true,
});
assert.equal(openCodeRunnerDefaults("codex").requiresQualifiedModel, false);
assert.match(openCodeRunnerDefaults("codex").cliPath, /^codex/iu);
assert.equal(codexSettingsProfile({ adapter: "cli", provider: "OpenAI", agentEngine: "codex", cliPath: "codex" }), true);
assert.equal(codexSettingsProfile({ adapter: "cli", provider: "DeepSeek", agentEngine: "codex", cliPath: "codex" }), false);
assert.equal(codexSettingsProfile({ adapter: "cli", provider: "OpenAI", agentEngine: "opencode", cliPath: "opencode" }), false);

const dualBindings = generationRuntimeBindings({
  textConnections: [{
    id: "text-deepseek-opencode",
    adapter: "cli",
    provider: "DeepSeek",
    protocol: "chat_completions",
    baseUrl: "https://api.deepseek.com/v1",
    cliPath: "opencode",
    cliArgs: "",
    model: "deepseek/deepseek-chat",
    agentEngine: "opencode",
    credentialSource: "shensi",
    executionModes: ["chat", "agent"],
  }],
}).bindings;
assert.equal(Object.hasOwn(dualBindings[0], "chatAdapter"), false);
assert.equal(Object.hasOwn(dualBindings[0], "chatProtocol"), false);
assert.equal(Object.hasOwn(dualBindings[0], "chatBaseUrl"), false);

console.log("OpenCode cache isolation and atomic runner defaults tests passed");
