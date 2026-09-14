import assert from "node:assert/strict";
import {
  applyGenerationRuntimeBindings,
  mergeGenerationProfileDraftsById,
  normalizeGenerationProfiles,
  portableGenerationSettings,
  withoutTextGenerationConfiguration,
} from "../src/generation-profiles.js";
import { getProviderModelOptions } from "../src/model-presets.js";

const aggregateId = "text-1787923302281-8ygl7";
const publicId = "text-public-agent";
const runtimeBinding = {
  channel: "text",
  profileId: aggregateId,
  adapter: "api",
  provider: "自定义兼容接口",
  protocol: "responses",
  baseUrl: "http://127.0.0.1:5317/v1",
  agentEngine: "codex_api",
  cliPath: "",
  cliArgs: "",
};
const aggregateProfile = {
  id: aggregateId,
  name: "聚合api",
  remarkName: "聚合api",
  provider: "自定义兼容接口",
  adapter: "api",
  protocol: "responses",
  baseUrl: "",
  model: "gpt-6-astra",
  reasoningEffort: "low",
  agentEngine: "codex_api",
  agentModelId: "gpt-6-astra",
  agentReasoningEffort: "low",
  agentSpeedMode: "default",
  chatModelId: "",
  executionMode: "agent",
  executionModes: ["agent"],
};

const original = {
  textConnections: [aggregateProfile],
  activeTextConnectionId: publicId,
  activeTextAgentConnectionId: aggregateId,
  activeTextChatConnectionId: publicId,
};
const normalized = normalizeGenerationProfiles(original);
assert.equal(normalized.activeTextConnectionId, aggregateId, "统一文字指针应以 Agent 指针为准");
assert.equal(normalized.activeTextAgentConnectionId, aggregateId);
assert.equal(normalized.activeTextChatConnectionId, aggregateId, "旧 Chat 字段只能作为统一指针兼容别名");

const hydrated = applyGenerationRuntimeBindings(normalized, { bindings: [runtimeBinding] });
const hydratedAggregate = hydrated.textConnections.find((profile) => profile.id === aggregateId);
assert.ok(hydratedAggregate);
assert.equal(hydratedAggregate.baseUrl, runtimeBinding.baseUrl, "同 ID 运行时绑定可以回填本机端点");
for (const [field, expected] of Object.entries({
  name: "聚合api",
  remarkName: "聚合api",
  provider: "自定义兼容接口",
  adapter: "api",
  protocol: "responses",
  agentEngine: "codex_api",
  model: "gpt-6-astra",
  agentModelId: "gpt-6-astra",
  reasoningEffort: "low",
  agentReasoningEffort: "low",
  agentSpeedMode: "default",
})) assert.equal(hydratedAggregate[field], expected, `运行时绑定不得覆盖 ${field}`);

const saved = portableGenerationSettings(mergeGenerationProfileDraftsById(hydrated, normalizeGenerationProfiles(hydrated)));
const reloaded = applyGenerationRuntimeBindings(normalizeGenerationProfiles(saved), { bindings: [runtimeBinding] });
const reloadedAggregate = reloaded.textConnections.find((profile) => profile.id === aggregateId);
assert.equal(reloadedAggregate.name, "聚合api");
assert.equal(reloadedAggregate.remarkName, "聚合api");
assert.equal(reloadedAggregate.model, "gpt-6-astra");
assert.equal(reloadedAggregate.agentModelId, "gpt-6-astra");
assert.equal(reloadedAggregate.baseUrl, runtimeBinding.baseUrl);

const withoutAggregate = normalizeGenerationProfiles({
  textConnections: [],
  activeTextConnectionId: publicId,
  activeTextAgentConnectionId: publicId,
});
const staleHydration = applyGenerationRuntimeBindings(withoutAggregate, { bindings: [runtimeBinding] });
assert.equal(staleHydration.textConnections.some((profile) => profile.id === aggregateId), false,
  "残缺文字运行时绑定不得复活已不存在的配置");
assert.equal(staleHydration.textConnections.some((profile) => profile.name === "自定义兼容接口 API"), false,
  "残缺绑定不得生成服务商通用名称");

const conflictingBinding = {
  ...runtimeBinding,
  provider: "OpenAI",
  adapter: "cli",
  protocol: "chat_completions",
  agentEngine: "workbuddy",
  baseUrl: "http://127.0.0.1:5317/v1",
};
const conflictHydration = applyGenerationRuntimeBindings(normalized, { bindings: [conflictingBinding] });
const conflictAggregate = conflictHydration.textConnections.find((profile) => profile.id === aggregateId);
assert.equal(conflictAggregate.baseUrl, conflictingBinding.baseUrl);
assert.equal(conflictAggregate.provider, aggregateProfile.provider);
assert.equal(conflictAggregate.adapter, aggregateProfile.adapter);
assert.equal(conflictAggregate.protocol, aggregateProfile.protocol);
assert.equal(conflictAggregate.agentEngine, aggregateProfile.agentEngine);
assert.equal(conflictAggregate.model, "gpt-6-astra");
assert.equal(conflictAggregate.reasoningEffort, "low");

assert.ok(getProviderModelOptions("自定义兼容接口").some((model) => model.slug === "gpt-6-astra"),
  "自定义兼容接口模型目录必须保留 GPT-6 Astra");
assert.ok(getProviderModelOptions("OpenAI").some((model) => model.slug === "gpt-6-astra"),
  "OpenAI 模型目录必须保留 GPT-6 Astra");

const notebookTextProfile = {
  ...aggregateProfile,
  id: "text-notebook-only",
  name: "笔记本独立文字配置",
  remarkName: "笔记本独立文字配置",
  model: "gpt-5.6-terra",
  agentModelId: "gpt-5.6-terra",
};
const aggregateWorkspaceSettings = {
  ...normalized,
  imageConnections: [{ id: "image-from-aggregate-workspace", name: "保留的图片配置" }],
  activeImageConnectionId: "image-from-aggregate-workspace",
};
const notebookWorkspaceSettings = {
  textConnections: [notebookTextProfile],
  activeTextConnectionId: notebookTextProfile.id,
  activeTextAgentConnectionId: notebookTextProfile.id,
  activeTextChatConnectionId: notebookTextProfile.id,
  imageConnections: [{ id: "image-from-notebook", name: "笔记本图片配置" }],
  activeImageConnectionId: "image-from-notebook",
};
const switchedToNotebook = applyGenerationRuntimeBindings({
  ...notebookWorkspaceSettings,
  ...withoutTextGenerationConfiguration(aggregateWorkspaceSettings),
}, { bindings: [runtimeBinding] });
assert.equal(switchedToNotebook.textConnections.some((profile) => profile.id === aggregateId), false,
  "切换工作区时不得带入上一工作区的聚合 API 文字配置");
assert.equal(switchedToNotebook.activeTextConnectionId, notebookTextProfile.id);
assert.equal(switchedToNotebook.activeTextAgentConnectionId, notebookTextProfile.id);
assert.equal(switchedToNotebook.imageConnections.some((profile) => profile.id === "image-from-aggregate-workspace"), true,
  "本轮不得改变媒体配置原有的跨工作区继承行为");

const switchedBackToAggregate = applyGenerationRuntimeBindings({
  ...aggregateWorkspaceSettings,
  ...withoutTextGenerationConfiguration(switchedToNotebook),
}, { bindings: [runtimeBinding] });
const restoredAggregate = switchedBackToAggregate.textConnections.find((profile) => profile.id === aggregateId);
assert.ok(restoredAggregate, "切回原工作区后应恢复该工作区自己的聚合 API 配置");
assert.equal(restoredAggregate.name, "聚合api");
assert.equal(restoredAggregate.model, "gpt-6-astra");
assert.equal(switchedBackToAggregate.activeTextConnectionId, aggregateId);
assert.equal(switchedBackToAggregate.activeTextAgentConnectionId, aggregateId);

console.log("Aggregate text profile fidelity contracts passed");
