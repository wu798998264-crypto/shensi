import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyGenerationRuntimeBindings,
  generationRuntimeBindings,
  normalizeGenerationProfiles,
} from "../src/generation-profiles.js";
import { agentEngineDescriptor } from "../src/agent-engine-registry.js";
import { OPENAI_IMAGE_CLI_ALIAS, OPENAI_IMAGE_CLI_ARGS } from "../src/media-cli-presets.js";
import { saveGenerationProfileSettings } from "../src/server/generation-profile-store.mjs";
import { saveGenerationRuntimeBindings } from "../src/server/generation-runtime-store.mjs";

const businessDataRoot = process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData";
const machineDataRoot = process.env.SHENSI_MACHINE_DATA_ROOT
  || join(process.env.LOCALAPPDATA || process.env.TEMP || businessDataRoot, "ShensiCreativeEngine");
process.env.SHENSI_MACHINE_DATA_ROOT = machineDataRoot;
const activeStatePath = join(businessDataRoot, "作品", "向天垂钓", ".shensi", "current-state.json");
const donorStatePath = join(businessDataRoot, "笔记", "我的笔记", ".shensi", "current-state.json");
const runtimePath = join(machineDataRoot, "config", "generation-runtime-v1.json");
const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const backup = async (path, label) => {
  const target = `${path}.bak-${label}-${timestamp}`;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(path, target);
  return target;
};

const activeState = await readJson(activeStatePath);
const donorState = await readJson(donorStatePath);
const runtime = await readJson(runtimePath);
const activeBackup = await backup(activeStatePath, "global-generation-profiles");
const runtimeBackup = await backup(runtimePath, "global-generation-profiles");

const activeSettings = applyGenerationRuntimeBindings(
  normalizeGenerationProfiles(activeState.settings || {}),
  runtime,
);
const donorSettings = applyGenerationRuntimeBindings(
  normalizeGenerationProfiles(donorState.settings || {}),
  runtime,
);

const byId = (profiles, id) => profiles.find((profile) => String(profile?.id || "") === id);
const requiredTextProfiles = [
  byId(activeSettings.textConnections || [], "text-default"),
  byId(activeSettings.textConnections || [], "text-public-agent"),
  byId(donorSettings.textConnections || [], "text-1787923302281-8ygl7"),
  byId(donorSettings.textConnections || [], "text-claude-code-deepseek"),
].filter(Boolean);

const workBuddy = agentEngineDescriptor("workbuddy");
requiredTextProfiles.push({
  id: "text-workbuddy-cli",
  name: "WorkBuddy",
  remarkName: "WorkBuddy",
  adapter: "cli",
  provider: "",
  protocol: "",
  baseUrl: "",
  model: "",
  reasoningEffort: "",
  speedMode: "default",
  temperature: "",
  maxOutputTokens: "",
  timeoutMs: "600000",
  apiKey: "",
  cliPath: workBuddy.cliPath,
  cliArgs: workBuddy.cliArgs,
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "workbuddy",
  agentModelId: "",
  chatModelId: "",
  credentialSource: "runner_login",
  runnerId: "workbuddy",
  providerId: "runner_managed",
  modelPolicy: "runner_default",
});

const openAiImageProfile = {
  id: "image-openai-codex-cli",
  name: "OpenAI CLI",
  remarkName: "OpenAI CLI",
  adapter: "cli",
  provider: "OpenAI",
  protocol: "images",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-image-2.5",
  timeoutMs: "660000",
  apiKey: "",
  cliPath: OPENAI_IMAGE_CLI_ALIAS,
  cliArgs: OPENAI_IMAGE_CLI_ARGS,
};

const settings = normalizeGenerationProfiles({
  ...activeSettings,
  textConnections: requiredTextProfiles,
  activeTextConnectionId: activeSettings.activeTextConnectionId || "text-default",
  activeTextAgentConnectionId: activeSettings.activeTextAgentConnectionId || "text-default",
  activeTextChatConnectionId: activeSettings.activeTextConnectionId || "text-default",
  imageConnections: [
    ...(activeSettings.imageConnections || []).filter((profile) => profile.id !== openAiImageProfile.id),
    openAiImageProfile,
  ],
  activeImageConnectionId: activeSettings.activeImageConnectionId || "image-dreamina-cli",
});

const stored = await saveGenerationProfileSettings({ settings });
const nonDreaminaBindings = Object.values(generationRuntimeBindings(settings))
  .flat()
  .filter((binding) => binding.provider !== "即梦");
await saveGenerationRuntimeBindings({ bindings: nonDreaminaBindings });

process.stdout.write(`${JSON.stringify({
  ok: true,
  globalRevision: stored.revision,
  activeBackup,
  runtimeBackup,
  restoredTextProfileIds: requiredTextProfiles.map((profile) => profile.id),
  restoredImageProfileId: openAiImageProfile.id,
}, null, 2)}\n`);
