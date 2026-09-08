import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeGenerationProfile, generationSettingsForChannel } from "../src/generation-profiles.js";

const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-route-isolation-"));
process.env.SHENSI_MACHINE_DATA_ROOT = runtimeRoot;
const {
  resolveTrustedGenerationSettings,
  saveGenerationRuntimeBindings,
} = await import(`../src/server/generation-runtime-store.mjs?route-isolation=${Date.now()}`);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const whiteboardChatSnapshot = appSource.match(/const whiteboardTextGenerationSettings = [\s\S]*?\n\};/u)?.[0] || "";
assert.match(
  whiteboardChatSnapshot,
  /activeTextChatConnectionId:\s*selected\.id/u,
  "whiteboard Chat request snapshots must pin the picker-selected profile id",
);
assert.match(
  whiteboardChatSnapshot,
  /activeTextConnectionId:\s*selected\.id/u,
  "whiteboard Chat request snapshots must keep the legacy active id aligned with the picker",
);

const apiProfile = (id, provider, model, baseUrl) => ({
  id,
  connectionId: id,
  name: id,
  adapter: "api",
  provider,
  protocol: "chat_completions",
  baseUrl,
  model,
  apiKey: `key-${id}`,
});

const profiles = {
  stale: apiProfile("text-stale", "Stale Provider", "stale-model", "https://stale.invalid/v1"),
  chat: { ...apiProfile("text-chat", "Chat Provider", "chat-model", "https://chat.invalid/v1"), executionModes: ["chat"] },
  agent: { ...apiProfile("text-agent", "Agent Provider", "agent-model", "https://agent.invalid/v1"), executionModes: ["agent"], agentEngine: "codex_api", protocol: "responses" },
  image: apiProfile("image-selected", "Image Provider", "image-model", "https://image.invalid/v1"),
  imageOther: apiProfile("image-other", "Other Image Provider", "other-image", "https://image-other.invalid/v1"),
  video: apiProfile("video-selected", "Video Provider", "video-model", "https://video.invalid/v1"),
  audio: apiProfile("audio-selected", "Audio Provider", "audio-model", "https://audio.invalid/v1"),
};

const conflictingSettings = {
  ...profiles.stale,
  id: profiles.stale.id,
  connectionId: profiles.stale.id,
  activeTextConnectionId: profiles.stale.id,
  activeTextChatConnectionId: profiles.chat.id,
  activeTextAgentConnectionId: profiles.agent.id,
  activeImageConnectionId: profiles.image.id,
  activeVideoConnectionId: profiles.video.id,
  activeAudioConnectionId: profiles.audio.id,
  textConnections: [profiles.stale, profiles.chat, profiles.agent],
  imageConnections: [profiles.imageOther, profiles.image],
  videoConnections: [profiles.video],
  audioConnections: [profiles.audio],
};

const cases = [
  { channel: "text", route: "chat", expected: profiles.chat },
  { channel: "text", route: "agent", expected: profiles.agent },
  { channel: "image", route: "", expected: profiles.image },
  { channel: "video", route: "", expected: profiles.video },
  { channel: "audio", route: "", expected: profiles.audio },
];

const resolved = await Promise.all(cases.map((entry) => resolveTrustedGenerationSettings({
  channel: entry.channel,
  route: entry.route,
  settings: conflictingSettings,
})));

for (let index = 0; index < cases.length; index += 1) {
  const { channel, route, expected } = cases[index];
  const actual = resolved[index];
  assert.equal(actual.connectionId, expected.id, `${channel}/${route || "channel"} must bind the selected profile id`);
  assert.equal(actual.provider, expected.provider, `${channel}/${route || "channel"} must not inherit a stale provider`);
  assert.equal(actual.model, expected.model, `${channel}/${route || "channel"} must not inherit a stale model`);
  assert.equal(actual.baseUrl, expected.baseUrl, `${channel}/${route || "channel"} must not inherit a stale endpoint`);
  assert.equal(actual.apiKey, expected.apiKey, `${channel}/${route || "channel"} must not inherit a stale credential`);
}

const incompleteSelected = {
  ...conflictingSettings,
  activeImageConnectionId: "image-incomplete",
  imageConnections: [{ id: "image-incomplete", adapter: "api", provider: "Incomplete", protocol: "images", model: "image-v1" }],
  baseUrl: "https://must-not-leak.invalid/v1",
  apiKey: "must-not-leak",
};
await assert.rejects(
  resolveTrustedGenerationSettings({ channel: "image", settings: incompleteSelected }),
  (error) => error?.code === "LOCAL_RUNTIME_BINDING_REQUIRED",
  "missing selected-profile fields must not inherit a previous profile endpoint or credential",
);

for (const [channel, activeKey] of [
  ["text", "activeTextChatConnectionId"],
  ["image", "activeImageConnectionId"],
  ["video", "activeVideoConnectionId"],
  ["audio", "activeAudioConnectionId"],
]) {
  const settings = { ...conflictingSettings, [activeKey]: "deleted-or-cross-channel-profile" };
  await assert.rejects(
    resolveTrustedGenerationSettings({ channel, route: channel === "text" ? "chat" : "", settings }),
    (error) => error?.code === "GENERATION_PROFILE_IDENTITY_MISMATCH",
    `${channel} must fail closed when its selected profile is missing`,
  );
}

assert.equal(activeGenerationProfile(conflictingSettings, "image", "deleted-image"), null);
assert.equal(generationSettingsForChannel(conflictingSettings, "video", "deleted-video"), null);

const compactJobSnapshot = await resolveTrustedGenerationSettings({
  channel: "image",
  settings: { ...profiles.image, id: profiles.image.id, connectionId: profiles.image.id },
});
assert.equal(compactJobSnapshot.connectionId, profiles.image.id, "persisted job snapshots retain their explicit profile identity");

const managedPublicProfile = await resolveTrustedGenerationSettings({
  channel: "text",
  route: "chat",
  settings: {
    id: "text-public-kilo",
    connectionId: "text-public-kilo",
    adapter: "api",
    provider: "自定义兼容接口",
    protocol: "responses",
    baseUrl: "https://must-not-route.invalid/v1",
    model: "poolside/laguna-s-2.1:free",
    apiKey: "must-not-leak",
  },
});
assert.equal(managedPublicProfile.provider, "免费模型");
assert.equal(managedPublicProfile.protocol, "chat_completions");
assert.equal(managedPublicProfile.baseUrl, "https://api.kilo.ai/api/openrouter");
assert.equal(managedPublicProfile.apiKey, "", "system public profile must never inherit or send a private credential");

const boundProfileId = "text-bound-custom";
const storedBinding = {
  channel: "text",
  profileId: boundProfileId,
  adapter: "cli",
  provider: "Custom CLI",
  protocol: "responses",
  baseUrl: "https://bound.invalid/v1",
  cliPath: "C:\\tools\\bound-cli.exe",
  cliArgs: "run --profile bound",
};
await saveGenerationRuntimeBindings({ bindings: [storedBinding] });
const boundProfile = {
  id: boundProfileId,
  connectionId: boundProfileId,
  adapter: storedBinding.adapter,
  provider: storedBinding.provider,
  protocol: storedBinding.protocol,
  baseUrl: storedBinding.baseUrl,
  cliPath: storedBinding.cliPath,
  cliArgs: storedBinding.cliArgs,
  model: "bound-model",
};
assert.equal(
  (await resolveTrustedGenerationSettings({ channel: "text", settings: boundProfile })).cliPath,
  storedBinding.cliPath,
  "an unchanged profile must retain its exact authorized runtime",
);
for (const [field, changed] of [
  ["baseUrl", "https://changed.invalid/v1"],
  ["cliPath", "C:\\tools\\other-cli.exe"],
  ["cliArgs", "run --profile other"],
]) {
  await assert.rejects(
    resolveTrustedGenerationSettings({ channel: "text", settings: { ...boundProfile, [field]: changed } }),
    (error) => error?.code === "LOCAL_RUNTIME_BINDING_REQUIRED",
    `same-id ${field} changes must not reuse a stale authorized runtime`,
  );
}

const dreaminaBinding = {
  channel: "image",
  profileId: "image-dreamina-bound",
  adapter: "cli",
  provider: "即梦",
  protocol: "dreamina_cli",
  cliPath: "custom-dreamina",
  cliArgs: "generate",
  dreaminaCliProfile: "guobazai",
};
await saveGenerationRuntimeBindings({ bindings: [dreaminaBinding] });
const portableDreamina = await resolveTrustedGenerationSettings({
  channel: "image",
  settings: {
    id: dreaminaBinding.profileId,
    adapter: "cli",
    provider: "即梦",
    protocol: "dreamina_cli",
    model: "dreamina-image",
  },
});
assert.equal(
  portableDreamina.dreaminaCliProfile,
  dreaminaBinding.dreaminaCliProfile,
  "a portable Dreamina profile must recover the account from its exact channel/profile binding",
);
await assert.rejects(
  resolveTrustedGenerationSettings({
    channel: "image",
    settings: { ...dreaminaBinding, id: dreaminaBinding.profileId, dreaminaCliProfile: "chenan", model: "dreamina-image" },
  }),
  (error) => error?.code === "LOCAL_RUNTIME_BINDING_REQUIRED",
  "same-id Dreamina account changes must not reuse another account binding",
);

const openCodeBinding = {
  channel: "text",
  profileId: "text-opencode-bound",
  adapter: "cli",
  provider: "DeepSeek",
  protocol: "chat_completions",
  baseUrl: "https://chat-bound.invalid/v1",
  cliPath: "opencode",
  cliArgs: "run",
  chatAdapter: "api",
  chatProtocol: "chat_completions",
  chatBaseUrl: "https://chat-bound.invalid/v1",
};
await saveGenerationRuntimeBindings({ bindings: [openCodeBinding] });
const openCodeProfile = {
  id: openCodeBinding.profileId,
  adapter: "cli",
  provider: "DeepSeek",
  protocol: "chat_completions",
  baseUrl: "https://chat-changed.invalid/v1",
  cliPath: "opencode",
  cliArgs: "run",
  model: "deepseek/deepseek-chat",
  chatModelId: "deepseek-chat",
  agentEngine: "opencode",
  credentialSource: "shensi",
  executionModes: ["chat", "agent"],
};
await assert.rejects(
  resolveTrustedGenerationSettings({ channel: "text", route: "chat", settings: openCodeProfile }),
  (error) => error?.code === "LOCAL_RUNTIME_BINDING_REQUIRED",
  "OpenCode Chat must not reuse a same-id binding for a different endpoint",
);

await rm(runtimeRoot, { recursive: true, force: true });

console.log("generation route isolation matrix tests passed");
