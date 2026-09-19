import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generationConfigurationSettings,
  normalizeGenerationProfiles,
  withoutGenerationConfiguration,
} from "../src/generation-profiles.js";
import {
  listGenerationProfileSettings,
  saveGenerationProfileSettings,
} from "../src/server/generation-profile-store.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-global-profiles-"));
const path = join(root, "generation-profiles-v1.json");

try {
  const workspaceSettings = {
    workspacePath: "E:\\Workspace\\Novel-A",
    editorFontSize: "19",
    activeTextConnectionId: "text-default",
    activeTextAgentConnectionId: "text-default",
    textConnections: [
      { id: "text-default", name: "GPT Agent · Codex CLI", adapter: "cli", provider: "OpenAI", protocol: "responses", model: "gpt-5.6-sol", agentModelId: "gpt-5.6-sol", agentEngine: "codex", cliPath: "codex", apiKey: "must-not-persist" },
      { id: "text-1787923302281-8ygl7", name: "聚合api", remarkName: "聚合api", adapter: "api", provider: "自定义兼容接口", protocol: "responses", model: "gpt-6-astra", agentModelId: "gpt-6-astra", agentEngine: "codex_api", baseUrl: "http://127.0.0.1:5317/v1", apiKey: "must-not-persist" },
      { id: "text-claude-code-deepseek", name: "DeepSeek Agent", remarkName: "DeepSeek Agent", adapter: "cli", provider: "DeepSeek", protocol: "chat_completions", model: "deepseek/deepseek-v4-pro", agentModelId: "deepseek/deepseek-v4-pro", agentEngine: "opencode", cliPath: "opencode" },
      { id: "text-workbuddy-cli", name: "WorkBuddy", remarkName: "WorkBuddy", adapter: "cli", provider: "", protocol: "", model: "", agentModelId: "", agentEngine: "workbuddy", cliPath: "codebuddy", cliArgs: "-p {prompt}" },
    ],
    activeImageConnectionId: "image-dreamina-cli",
    imageConnections: [{ id: "image-openai-codex-cli", name: "OpenAI CLI", remarkName: "OpenAI CLI", adapter: "cli", provider: "OpenAI", protocol: "images", model: "gpt-image-2.5", cliPath: "shensi-openai-image", apiKey: "must-not-persist" }],
  };

  const saved = await saveGenerationProfileSettings({ settings: workspaceSettings, path });
  assert.equal(saved.exists, true);
  assert.equal(saved.revision, 1);
  const loaded = await listGenerationProfileSettings({ path });
  assert.equal(loaded.settings.textConnections.some((profile) => profile.id === "text-1787923302281-8ygl7"), true);
  assert.equal(loaded.settings.textConnections.some((profile) => profile.id === "text-claude-code-deepseek"), true);
  assert.equal(loaded.settings.textConnections.some((profile) => profile.id === "text-workbuddy-cli"), true);
  assert.equal(loaded.settings.imageConnections.some((profile) => profile.id === "image-openai-codex-cli"), true);
  assert.equal(Object.hasOwn(loaded.settings, "workspacePath"), false, "工作区路径不得进入全局模型配置");
  assert.equal(Object.hasOwn(loaded.settings, "editorFontSize"), false, "编辑器偏好不得进入模型配置文件");
  assert.equal(JSON.stringify(loaded).includes("must-not-persist"), false, "全局模型配置不得持久化密钥");
  assert.equal(JSON.stringify(await readFile(path, "utf8")).includes("must-not-persist"), false);

  const normalized = normalizeGenerationProfiles(loaded.settings);
  assert.equal(normalized.imageConnections.filter((profile) => profile.id === "image-openai-codex-cli").length, 1);
  assert.equal(normalized.imageConnections.some((profile) => profile.id === "image-cockpit-aggregate-api"), true, "恢复 OpenAI CLI 时必须保留聚合 API 图片配置");
  assert.equal(normalized.imageConnections.some((profile) => profile.id === "image-dreamina-cli"), true, "恢复 OpenAI CLI 时必须保留即梦图片配置");

  const secondWorkspace = { workspacePath: "E:\\Workspace\\Novel-B", editorFontSize: "16", textConnections: [{ id: "workspace-local-stale" }] };
  const merged = normalizeGenerationProfiles({
    ...withoutGenerationConfiguration(secondWorkspace),
    ...generationConfigurationSettings(loaded.settings),
  });
  assert.equal(merged.textConnections.some((profile) => profile.id === "workspace-local-stale"), false, "工作区旧副本不得覆盖全局配置");
  assert.equal(merged.textConnections.some((profile) => profile.id === "text-workbuddy-cli"), true);
  assert.equal(merged.editorFontSize, "16", "非模型工作区设置应继续保留");

  const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(
    appSource,
    /ensureStateSchema\(\);\s*if \(machineGenerationProfiles\.exists\) \{[\s\S]{0,800}withoutGenerationConfiguration\(state\.settings/u,
    "作品载入完成后必须重新应用全局生成配置，不能被作品旧副本覆盖",
  );

  await assert.rejects(
    saveGenerationProfileSettings({ settings: loaded.settings, expectedRevision: 0, path }),
    (error) => error?.code === "GENERATION_PROFILE_REVISION_CONFLICT",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Global generation profile store contracts passed");
