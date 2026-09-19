import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generationProfileLabel,
  normalizeGenerationProfiles,
} from "../src/generation-profiles.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");

const normalized = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 2,
  activeTextConnectionId: "text-default",
  activeTextAgentConnectionId: "text-default",
  textConnections: [
    {
      id: "legacy-codex-alias",
      name: "OpenAI · gpt-5.6-sol",
      provider: "OpenAI",
      adapter: "cli",
      agentEngine: "codex",
      model: "gpt-5.6-sol",
      agentModelId: "gpt-5.6-sol",
    },
    {
      id: "text-default",
      name: "GPT Agent · Codex CLI",
      provider: "OpenAI",
      adapter: "cli",
      agentEngine: "codex",
      model: "gpt-5.6-sol",
      agentModelId: "gpt-5.6-sol",
    },
  ],
});

const codexProfiles = normalized.textConnections.filter((profile) => profile.adapter === "cli" && profile.agentEngine === "codex");
assert.equal(codexProfiles.length, 1, "同一 Codex/OpenAI CLI 配置不得在选择器中重复出现");
assert.equal(generationProfileLabel(codexProfiles[0], "text"), "OpenAI CLI", "Codex 配置只显示配置名称");
assert.equal(generationProfileLabel({
  name: "OpenAI · gpt-5.6-sol",
  provider: "OpenAI",
  adapter: "api",
  agentEngine: "codex_api",
  model: "gpt-5.6-sol",
  agentModelId: "gpt-5.6-sol",
}, "text"), "OpenAI", "旧配置名中的尾部模型型号必须从配置标签移除");
assert.equal(generationProfileLabel({
  name: "聚合api",
  remarkName: "聚合api",
  provider: "自定义兼容接口",
  adapter: "api",
  agentEngine: "codex_api",
  model: "gpt-6-astra",
}, "text"), "聚合api", "用户配置名必须保持不变");

const upgradedLegacyDefault = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 2,
  activeTextConnectionId: "text-default",
  activeTextAgentConnectionId: "text-default",
  textConnections: [{
    id: "text-default",
    name: "OpenAI 文字",
    provider: "OpenAI",
    adapter: "api",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    agentEngine: "codex_api",
    model: "gpt-5.6-sol",
    agentModelId: "gpt-5.6-sol",
    apiKey: "",
  }],
});
const upgradedOpenAi = upgradedLegacyDefault.textConnections.filter((profile) => profile.provider === "OpenAI");
assert.equal(upgradedOpenAi.length, 1, "空的旧 OpenAI API 占位配置不得与 OpenAI CLI 同时出现");
assert.equal(upgradedOpenAi[0].id, "text-default", "升级后应继续复用稳定的默认配置 ID");
assert.equal(upgradedOpenAi[0].adapter, "cli", "空的旧 OpenAI API 占位配置应升级为 OpenAI CLI");

const realApiMustRemain = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 2,
  textConnections: [{
    id: "text-default",
    name: "OpenAI 正式 API",
    remarkName: "OpenAI 正式 API",
    provider: "OpenAI",
    adapter: "api",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    agentEngine: "codex_api",
    model: "gpt-5.6-sol",
    agentModelId: "gpt-5.6-sol",
    apiKey: "configured-secret",
  }],
});
assert.equal(realApiMustRemain.textConnections.filter((profile) => profile.provider === "OpenAI").length, 2, "真实 API 配置不得被误删");

assert.match(appSource, /const temporaryProfile = null;/u, "已保存 OpenAI CLI 存在时不得再插入临时 Codex 配置");
assert.doesNotMatch(appSource, /labels\[index\]\}\$\{escapeHtml\(quickTextConnectionStatusSuffix/u, "配置下拉项不得拼接运行状态");
assert.doesNotMatch(appSource, /configuredProfileLabels\[index\]\}\$\{escapeHtml\(quickTextConnectionStatusSuffix/u, "快捷配置下拉项不得拼接运行状态");

console.log("text configuration picker label regression passed");
