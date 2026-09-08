import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  addDeepSeekOpenCodeProfile,
  generationProfileLabel,
  genericOpenCodeManualProfile,
  mergeGenerationProfileDraftsById,
  normalizeGenerationProfiles,
  reusableTextProviderCredential,
  unifiedOpenCodeProfile,
  validateGenericOpenCodeConnection,
} from "../src/generation-profiles.js";

const detectedCatalog = {
  available: true,
  modelsVerified: true,
  models: [
    { slug: "deepseek/deepseek-v4-pro", provider: "deepseek" },
    { slug: "openai/gpt-5", provider: "openai" },
  ],
};

const profile = genericOpenCodeManualProfile({ model: "deepseek/deepseek-v4-pro" });
assert.equal(profile.name, "OpenCode+DeepSeek", "复合配置名称必须按运行器在前、服务商在后显示");
assert.equal(generationProfileLabel({ adapter: "cli", agentEngine: "opencode", provider: "" }, "text"), "OpenCode", "未选择模型服务商时只显示运行器名称");
assert.equal(generationProfileLabel({ adapter: "cli", agentEngine: "opencode", provider: "DeepSeek" }, "text"), "OpenCode+DeepSeek", "复合配置按运行器＋服务商显示");
assert.equal(profile.agentEngine, "opencode");
assert.equal(profile.cliPath, "opencode");
assert.deepEqual(profile.executionModes, ["agent"]);
assert.equal(profile.remarkName, "OpenCode+DeepSeek", "复合配置名称按运行器在前、模型服务商在后显示");
assert.equal(profile.provider, "DeepSeek", "OpenCode 是运行器，模型服务商应从完整模型 ID 独立显示");

const hostedDeepSeekProfile = genericOpenCodeManualProfile({ model: "opencode/deepseek-v4-flash-free" });
assert.equal(hostedDeepSeekProfile.name, "OpenCode+DeepSeek", "OpenCode 托管模型应按真实模型家族命名");
assert.equal(hostedDeepSeekProfile.remarkName, "OpenCode+DeepSeek", "OpenCode 托管命名空间不得被误当成模型家族");
assert.equal(hostedDeepSeekProfile.model, "opencode/deepseek-v4-flash-free", "运行时必须继续使用 OpenCode 实际报告的完整模型 ID");
assert.equal(hostedDeepSeekProfile.provider, "DeepSeek", "OpenCode 托管模型应按模型家族显示服务商，但不得注入 OpenCode 配置");
const explicitProviderProfile = genericOpenCodeManualProfile({ provider: "OpenAI", model: "deepseek/deepseek-v4-pro" });
assert.equal(explicitProviderProfile.provider, "OpenAI", "用户明确选择的模型服务商必须保留，运行仍以完整模型 ID 为准");
assert.equal(profile.agentModelId, "deepseek/deepseek-v4-pro");
assert.equal(profile.credentialSource, "opencode", "默认通用 OpenCode 配置应复用 OpenCode 当前凭据");

const managed = genericOpenCodeManualProfile({
  provider: "DeepSeek",
  model: "deepseek/deepseek-v4-pro",
  credentialSource: "shensi",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "test-only-secret",
});
const reusedManaged = addDeepSeekOpenCodeProfile({
  textConnections: [
    { id: "deepseek-chat", provider: "DeepSeek", adapter: "api", model: "deepseek-chat", apiKey: "api-secret" },
    { ...managed, id: "existing-opencode-deepseek" },
  ],
  activeTextConnectionId: "deepseek-chat",
}, detectedCatalog);
const reusedDeepSeekOpenCodeProfiles = reusedManaged.textConnections.filter((item) => item.provider === "DeepSeek"
  && item.adapter === "cli"
  && ["opencode", "deepseek_opencode"].includes(String(item.agentEngine || "").trim()));
assert.equal(reusedDeepSeekOpenCodeProfiles.length, 1, "已有可用 DeepSeek+OpenCode 配置时不得重复创建同类配置");
assert.equal(reusedManaged.activeTextConnectionId, "existing-opencode-deepseek", "重复接入必须激活原配置 ID");
assert.equal(reusedDeepSeekOpenCodeProfiles[0].id, "existing-opencode-deepseek", "重复接入不得更换原配置 ID");
assert.equal(reusedDeepSeekOpenCodeProfiles[0].apiKey, "test-only-secret", "复用配置不得覆盖已保存凭据");
const openCodeOwned = genericOpenCodeManualProfile({
  id: "opencode-owned-deepseek",
  provider: "DeepSeek",
  model: "deepseek/deepseek-v4-pro",
  credentialSource: "opencode",
  apiKey: "",
});
const reusedOpenCodeOwned = addDeepSeekOpenCodeProfile({
  textConnections: [openCodeOwned],
  activeTextConnectionId: "",
}, detectedCatalog);
assert.equal(reusedOpenCodeOwned.activeTextConnectionId, openCodeOwned.id, "已有 OpenCode 自管凭据配置时必须直接复用，不得强制再建 DeepSeek API 配置");
assert.equal(reusedOpenCodeOwned.textConnections.filter((item) => item.provider === "DeepSeek"
  && item.adapter === "cli"
  && ["opencode", "deepseek_opencode"].includes(String(item.agentEngine || "").trim())).length, 1,
"OpenCode 自管凭据配置重复接入时不得产生第二条同类配置");
assert.equal(managed.credentialSource, "shensi");
assert.equal(managed.apiKey, "test-only-secret", "神思安全凭据只应进入当前内存配置，持久化由凭证仓负责");
assert.equal(reusableTextProviderCredential({
  settings: {
    textConnections: [
      { id: "deepseek-chat", provider: "DeepSeek", baseUrl: "https://api.deepseek.com" },
      managed,
    ],
  },
  secrets: { text: { "deepseek-chat": "reused-safe-secret" } },
  target: { ...managed, apiKey: "" },
}), "reused-safe-secret", "OpenCode+DeepSeek 必须能复用同服务商、同官方端点的安全凭据");
assert.equal(reusableTextProviderCredential({
  settings: { textConnections: [{ id: "deepseek-chat", provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" }] },
  secrets: { text: { "deepseek-chat": "reused-anthropic-safe-secret" } },
  target: { provider: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", credentialSource: "shensi" },
}), "reused-anthropic-safe-secret", "DeepSeek 官方 OpenAI 与 Anthropic 兼容端点必须安全复用同一凭据");
assert.equal(reusableTextProviderCredential({
  settings: { textConnections: [{ id: "deepseek-chat", provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" }] },
  secrets: { text: { "deepseek-chat": "legacy-agent-safe-secret" } },
  target: { id: "legacy-agent", provider: "DeepSeek", baseUrl: "", agentEngine: "deepseek_opencode" },
}), "legacy-agent-safe-secret", "旧 DeepSeek Agent 必须把空地址识别为官方端点并安全复用现有凭据");
assert.equal(reusableTextProviderCredential({
  settings: { textConnections: [{ id: "proxy", provider: "DeepSeek", baseUrl: "https://proxy.example/v1" }] },
  secrets: { text: { proxy: "must-not-bind-legacy-agent" } },
  target: { id: "legacy-agent", provider: "DeepSeek", baseUrl: "", agentEngine: "deepseek_opencode" },
}), "", "旧 DeepSeek Agent 不得把空地址当成通配符并复用代理凭据");
assert.equal(reusableTextProviderCredential({
  settings: { textConnections: [{ id: "custom", provider: "DeepSeek", baseUrl: "https://proxy.example/v1" }] },
  secrets: { text: { custom: "must-not-cross-endpoint" } },
  target: { ...managed, apiKey: "" },
}), "", "安全凭据不得跨不同 Base URL 自动复用");
assert.equal(validateGenericOpenCodeConnection({ profile: managed, capability: detectedCatalog }).ok, true);
const normalizedManaged = normalizeGenerationProfiles({
  textConnections: [managed],
  activeTextConnectionId: managed.id,
});
assert.equal(normalizedManaged.textConnections.find((item) => item.id === managed.id)?.model, "deepseek/deepseek-v4-pro", "统一 OpenCode 配置不得被服务商预置模型反向覆盖");
assert.equal(normalizedManaged.textConnections.find((item) => item.id === managed.id)?.agentEngine, "opencode");

assert.equal(validateGenericOpenCodeConnection({ profile, capability: detectedCatalog }).ok, true);
assert.equal(validateGenericOpenCodeConnection({
  profile: { ...profile, model: "anthropic/claude-sonnet", agentModelId: "anthropic/claude-sonnet" },
  capability: detectedCatalog,
}).stage, "catalog", "没有被当前 OpenCode 真实报告的模型不得通过连接前校验");
assert.equal(validateGenericOpenCodeConnection({
  profile: { ...profile, model: "deepseek-v4-pro", agentModelId: "deepseek-v4-pro" },
  capability: detectedCatalog,
}).stage, "model");

const originalLegacy = {
  id: "legacy-deepseek",
  name: "DeepSeek CLI",
  provider: "DeepSeek",
  adapter: "cli",
  model: "deepseek-v4-pro",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "deepseek_opencode",
  cliPath: "shensi-deepseek-opencode",
  cliArgs: "--model {model}",
  unknownLegacyField: { keep: true },
};
const convertedLegacy = unifiedOpenCodeProfile(originalLegacy);
assert.equal(convertedLegacy.id, originalLegacy.id, "统一格式不得更换配置 ID");
assert.equal(convertedLegacy.name, "OpenCode+DeepSeek");
assert.equal(convertedLegacy.remarkName, "OpenCode+DeepSeek");
assert.equal(convertedLegacy.provider, "DeepSeek");
assert.equal(convertedLegacy.agentEngine, "opencode");
assert.equal(convertedLegacy.credentialSource, "shensi");
assert.equal(convertedLegacy.model, "deepseek/deepseek-v4-pro");
assert.equal(convertedLegacy.agentModelId, "deepseek/deepseek-v4-pro");
assert.equal(convertedLegacy.unknownLegacyField.keep, true, "统一格式转换必须保留未知扩展字段");
const original = {
  activeTextConnectionId: "text-default",
  textConnections: [
    {
      id: "text-default",
      name: "GPT Chat · Codex CLI",
      provider: "OpenAI",
      adapter: "cli",
      model: "gpt-5.6-sol",
      executionModes: ["chat", "agent"],
      agentEngine: "codex",
    },
    originalLegacy,
  ],
};
const merged = mergeGenerationProfileDraftsById(original, {
  ...original,
  textConnections: [...original.textConnections, profile],
});
assert.equal(merged.activeTextConnectionId, "text-default", "新增 OpenCode 配置不得改变活动配置");
assert.equal(merged.textConnections[0], original.textConnections[0], "当前 GPT 配置必须原样保留");
assert.notEqual(merged.textConnections[1], originalLegacy, "保存设置时必须移除旧 DeepSeek 固定组合形态");
assert.equal(merged.textConnections[1].agentEngine, "opencode");
assert.equal(merged.textConnections[1].model, "deepseek/deepseek-v4-pro");
assert.equal(merged.textConnections[1].unknownLegacyField.keep, true, "迁移不得丢失未知扩展字段");
assert.equal(merged.textConnections[2].agentEngine, "opencode");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.doesNotMatch(
  appSource,
  /id="genericOpenCodeManualModel"|name="genericOpenCodeManualModel"/u,
  "普通 OpenCode 配置界面不得保留第二套手动模型输入框",
);
assert.match(appSource, /<option value="opencode">OpenCode<\/option>/u);
assert.doesNotMatch(appSource, /name="textAgentEngine"[\s\S]{0,240}<option value="deepseek_opencode">/u, "模型设置中的旧兼容运行器不得继续作为单独界面选项");
assert.doesNotMatch(appSource, /id="quickAgentEngine"[\s\S]{0,180}deepseek_opencode/iu, "快速 Agent 选择器不得暴露旧的反向命名显示项");
assert.match(appSource, /<label>Agent 配置<select id="quickAgentEngine">/u, "快速 Agent 选择器必须按配置展示，不再暴露运行器映射");
assert.match(appSource, /openCodeCatalogGroupsForProvider/u, "OpenCode 模型目录必须按当前服务商隔离显示");
assert.match(appSource, /openCodeCatalogCacheKey/u, "OpenCode 模型目录缓存必须按凭据来源、服务商和 Base URL 隔离");
assert.doesNotMatch(appSource, /providerField\.hidden = openCodeEngine/u, "选择 OpenCode 时模型服务商字段必须保持可见");
assert.doesNotMatch(appSource, /legacyOpenCodePresentation/u, "用户在统一 OpenCode 界面执行真实测试时不得被表单还原成旧运行器");
assert.match(appSource, /name="textCredentialSource"/u, "OpenCode 配置必须在同一页面选择凭据来源");
assert.match(appSource, /opencodeManagedProbe:\s*true/u, "未保存的神思安全凭据必须通过只读模型探测路径读取真实目录");
assert.match(appSource, /settings\?\.credentialSource \|\| settings\?\.textCredentialSource/u, "模型目录刷新必须识别表单中的神思安全凭据来源字段");
assert.match(appSource, /bindReusableTextProviderCredential[\s\S]{0,700}queueGenerationSecretWrite/u, "白板 Agent 复用凭据后必须绑定到 DPAPI 凭据仓");
assert.match(appSource, /activeTextAgentConnectionId[\s\S]{0,520}textConnections:\s*settings\.textConnections\.map/u, "复用凭据必须同步注入本次 Agent 请求的活动配置，不能只写顶层兼容字段");
assert.match(appSource, /ui\.openCodeCatalogs\.get\(catalogKey\)\?\.available !== true[\s\S]{0,120}await refreshAvailableModels\(\)/u, "真实连接测试必须在需要时自动探测 OpenCode CLI 与模型目录");
assert.match(serverSource, /body\.opencodeManagedProbe === true[\s\S]{0,900}preset\.custom === true/u, "只读模型探测必须限制为内置服务商官方地址，不能成为任意 SSRF 入口");
assert.doesNotMatch(appSource, /当前配置继续使用原连接|DeepSeek \+ OpenCode（旧兼容）/u, "统一界面不得向用户暴露兼容实现说明");
assert.doesNotMatch(appSource, /id="setCurrentOpenCode"/u, "OpenCode 配置页不得保留会改变全局当前引擎的重复按钮");

console.log("Unified OpenCode profile and legacy-preservation tests passed");
