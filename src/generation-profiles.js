import { DREAMINA_CLI_PROFILES, DREAMINA_IMAGE_CLI_ALIAS, DREAMINA_IMAGE_CLI_ARGS, DREAMINA_VIDEO_CLI_ALIAS, DREAMINA_VIDEO_CLI_ARGS, LIBTV_CLI_ALIAS, LIBTV_CLI_ARGS, OPENAI_IMAGE_CLI_ALIAS, OPENAI_IMAGE_CLI_ARGS, validDreaminaCliProfileId } from "./media-cli-presets.js?v=2.19.7-media-account-pool";
import { DEEPSEEK_OPENCODE_CLI_ALIAS, DEEPSEEK_OPENCODE_CLI_ARGS, getProviderAudioModelOptions, getProviderImageModelOptions, getProviderModelOptions, getProviderPreset, getProviderVideoModelOptions } from "./model-presets.js";
import { normalizeAgentPermissionMode } from "./agent-permission-policy.js";

const CHANNELS = ["text", "image", "video", "audio"];
const GENERATION_RUNTIME_FIELDS = Object.freeze(["baseUrl", "cliPath", "cliArgs"]);
const LEGACY_GENERATION_RUNTIME_FIELDS = Object.freeze([
  "baseUrl",
  "cliPath",
  "cliArgs",
  "imageBaseUrl",
  "imageCliPath",
  "imageCliArgs",
  "videoBaseUrl",
  "videoCliPath",
  "videoCliArgs",
  "audioBaseUrl",
  "audioCliPath",
  "audioCliArgs",
]);
export const IMAGE_MODEL_SELECTION_VERSION = 4;
export const VIDEO_CLI_DEFAULT_VERSION = 3;
export const CLI_REMARK_MIGRATION_VERSION = 2;
export const TEXT_CODEX_CLI_PROFILE_VERSION = 1;
export const PROVIDER_MODEL_ISOLATION_VERSION = 1;
export const AGGREGATE_IMAGE_API_PROFILE_VERSION = 1;
export const AGGREGATE_CUSTOM_MEDIA_PROFILE_VERSION = 1;
export const TEXT_PROFILE_CLEANUP_VERSION = 2;

const PROFILE_KEYS = {
  text: { list: "textConnections", active: "activeTextConnectionId" },
  image: { list: "imageConnections", active: "activeImageConnectionId" },
  video: { list: "videoConnections", active: "activeVideoConnectionId" },
  audio: { list: "audioConnections", active: "activeAudioConnectionId" },
};

const DEFAULTS = {
  text: {
    id: "text-default",
    name: "OpenAI 文字",
    adapter: "api",
    provider: "OpenAI",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    speedMode: "default",
    temperature: "0.7",
    maxOutputTokens: "4000",
    timeoutMs: "120000",
    apiKey: "",
    cliPath: "",
    cliArgs: "",
    executionMode: "agent",
    executionModes: ["agent"],
    agentEngine: "codex_api",
    agentModelId: "gpt-5.6-sol",
    chatModelId: "",
    credentialSource: "shensi",
    runtimeProfileId: "",
    runtimeConfigPath: "",
  },
  image: {
    id: "image-default",
    name: "OpenAI GPT 图片 CLI",
    adapter: "cli",
    provider: "OpenAI",
    protocol: "images",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2",
    timeoutMs: "660000",
    apiKey: "",
    cliPath: OPENAI_IMAGE_CLI_ALIAS,
    cliArgs: OPENAI_IMAGE_CLI_ARGS,
  },
  video: {
    id: "video-default",
    name: "OpenAI 视频",
    adapter: "api",
    provider: "OpenAI",
    protocol: "videos",
    baseUrl: "https://api.openai.com/v1",
    model: "sora-2",
    timeoutMs: "900000",
    apiKey: "",
    cliPath: "",
    cliArgs: "",
  },
  audio: {
    id: "audio-libtv-jimeng",
    name: "libtv · 即梦音频",
    remarkName: "libtv",
    adapter: "cli",
    provider: "LibTV",
    protocol: "media",
    baseUrl: "",
    model: "seed-audio-1.0",
    timeoutMs: "900000",
    apiKey: "",
    cliPath: LIBTV_CLI_ALIAS,
    cliArgs: LIBTV_CLI_ARGS,
    reserved: false,
  },
};

const BUILT_IN_GPT_CHAT_CLI = {
  id: "text-default",
  name: "GPT Agent · Codex CLI",
  adapter: "cli",
  provider: "OpenAI",
  protocol: "responses",
  baseUrl: "",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  speedMode: "default",
  temperature: "0.7",
  maxOutputTokens: "4000",
  timeoutMs: "120000",
  apiKey: "",
  cliPath: getProviderPreset("OpenAI").cli.path,
  cliArgs: getProviderPreset("OpenAI").cli.args,
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "codex",
};

const PUBLIC_TEXT_PROVIDER_PRESET = getProviderPreset("免费模型");
const BUILT_IN_PUBLIC_TEXT_PROFILE = {
  id: "text-public-kilo",
  name: "免费模型",
  remarkName: "免费模型",
  systemManaged: true,
  adapter: "api",
  provider: "免费模型",
  protocol: PUBLIC_TEXT_PROVIDER_PRESET.api.protocol,
  baseUrl: PUBLIC_TEXT_PROVIDER_PRESET.api.baseUrl,
  model: PUBLIC_TEXT_PROVIDER_PRESET.api.model,
  reasoningEffort: "",
  speedMode: "default",
  temperature: "0.7",
  maxOutputTokens: "10000",
  timeoutMs: "120000",
  apiKey: "",
  cliPath: "",
  cliArgs: "",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "codex_api",
  agentModelId: PUBLIC_TEXT_PROVIDER_PRESET.api.model,
  chatModelId: "",
  credentialSource: "public",
};

const BUILT_IN_PUBLIC_AGENT_PROFILE = {
  id: "text-public-agent",
  name: "免费模型",
  remarkName: "免费模型",
  systemManaged: true,
  adapter: "api",
  provider: "免费模型",
  protocol: PUBLIC_TEXT_PROVIDER_PRESET.api.protocol,
  baseUrl: PUBLIC_TEXT_PROVIDER_PRESET.api.baseUrl,
  model: "poolside/laguna-s-2.1:free",
  agentModelId: "poolside/laguna-s-2.1:free",
  chatModelId: "",
  reasoningEffort: "",
  speedMode: "default",
  temperature: "0.7",
  maxOutputTokens: "10000",
  timeoutMs: "180000",
  apiKey: "",
  cliPath: "",
  cliArgs: "",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "codex_api",
  credentialSource: "public",
};

const BUILT_IN_LIBTV_IMAGE = {
  id: "image-libtv",
  name: "libtv",
  remarkName: "libtv",
  adapter: "cli",
  provider: "LibTV",
  protocol: "media",
  baseUrl: "",
  model: "lib-image-2",
  timeoutMs: "900000",
  apiKey: "",
  cliPath: LIBTV_CLI_ALIAS,
  cliArgs: LIBTV_CLI_ARGS,
};

const BUILT_IN_LIBTV_VIDEO = {
  id: "video-libtv",
  name: "libtv",
  remarkName: "libtv",
  adapter: "cli",
  provider: "LibTV",
  protocol: "media",
  baseUrl: "",
  model: "MiniMax-Hailuo-H3",
  timeoutMs: "1800000",
  apiKey: "",
  cliPath: LIBTV_CLI_ALIAS,
  cliArgs: LIBTV_CLI_ARGS,
};

const BUILT_IN_LIBTV_AUDIO_PROFILES = [
  {
    id: "audio-libtv-jimeng",
    name: "libtv · 即梦音频",
    remarkName: "libtv",
    adapter: "cli",
    provider: "LibTV",
    protocol: "media",
    baseUrl: "",
    model: "seed-audio-1.0",
    timeoutMs: "900000",
    apiKey: "",
    cliPath: LIBTV_CLI_ALIAS,
    cliArgs: LIBTV_CLI_ARGS,
    reserved: false,
  },
  {
    id: "audio-libtv-hailuo",
    name: "libtv · 海螺音频",
    remarkName: "libtv",
    adapter: "cli",
    provider: "LibTV",
    protocol: "media",
    baseUrl: "",
    model: "speech-2.8-hd",
    timeoutMs: "900000",
    apiKey: "",
    cliPath: LIBTV_CLI_ALIAS,
    cliArgs: LIBTV_CLI_ARGS,
    reserved: false,
  },
];

const BUILT_IN_DREAMINA_VIDEO = {
  id: "video-dreamina-cli",
  name: "即梦视频 CLI",
  adapter: "cli",
  provider: "即梦",
  protocol: "videos",
  baseUrl: "",
  model: "seedance2.5",
  timeoutMs: "1800000",
  apiKey: "",
  cliPath: DREAMINA_VIDEO_CLI_ALIAS,
  cliArgs: DREAMINA_VIDEO_CLI_ARGS,
};

const BUILT_IN_DREAMINA_IMAGE = {
  id: "image-dreamina-cli",
  name: "即梦图片 CLI",
  adapter: "cli",
  provider: "即梦",
  protocol: "images",
  baseUrl: "",
  model: "5.0",
  timeoutMs: "1800000",
  apiKey: "",
  cliPath: DREAMINA_IMAGE_CLI_ALIAS,
  cliArgs: DREAMINA_IMAGE_CLI_ARGS,
};

const BUILT_IN_AGGREGATE_IMAGE_API = {
  id: "image-cockpit-aggregate-api",
  name: "聚合api",
  remarkName: "聚合api",
  adapter: "api",
  provider: "自定义兼容接口",
  protocol: "images",
  baseUrl: "http://127.0.0.1:5317/v1",
  model: "gpt-image-2",
  timeoutMs: "660000",
  apiKey: "",
  cliPath: "",
  cliArgs: "",
};

const BUILT_IN_AGGREGATE_VIDEO_API = {
  id: "video-cockpit-aggregate-api",
  name: "聚合api",
  remarkName: "聚合api",
  adapter: "api",
  provider: "自定义兼容接口",
  protocol: "videos",
  baseUrl: "http://127.0.0.1:5317/v1",
  model: "sora-2",
  timeoutMs: "1800000",
  apiKey: "",
  cliPath: "",
  cliArgs: "",
};

const stringValue = (value, fallback = "") => typeof value === "string" ? value : fallback;

const withoutNonDreaminaIdentity = (profile = {}) => {
  if (profile.adapter === "cli" && profile.provider === "即梦") return profile;
  if (!Object.hasOwn(profile, "dreaminaCliProfile") && !Object.hasOwn(profile, "dreaminaExpectedIdentity")) return profile;
  const next = { ...profile };
  delete next.dreaminaCliProfile;
  delete next.dreaminaExpectedIdentity;
  return next;
};

const legacyProfile = (settings, channel) => {
  if (channel === "text") return {
    ...DEFAULTS.text,
    adapter: settings.adapter,
    provider: settings.provider,
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    speedMode: settings.speedMode,
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    apiKey: settings.apiKey,
    cliPath: settings.cliPath,
    cliArgs: settings.cliArgs,
  };
  const prefix = channel;
  const title = channel === "image" ? "图片" : channel === "video" ? "视频" : "音频";
  return {
    ...DEFAULTS[channel],
    name: `${settings[`${prefix}Provider`] || "OpenAI"} ${title}`,
    adapter: settings[`${prefix}Adapter`] || DEFAULTS[channel].adapter,
    provider: settings[`${prefix}Provider`] || DEFAULTS[channel].provider,
    protocol: settings[`${prefix}Protocol`] || DEFAULTS[channel].protocol,
    baseUrl: settings[`${prefix}BaseUrl`] || DEFAULTS[channel].baseUrl,
    model: settings[`${prefix}Model`] || DEFAULTS[channel].model,
    timeoutMs: settings[`${prefix}TimeoutMs`] || settings.timeoutMs || DEFAULTS[channel].timeoutMs,
    apiKey: settings[`${prefix}ApiKey`] || "",
    cliPath: settings[`${prefix}CliPath`] || DEFAULTS[channel].cliPath,
    cliArgs: settings[`${prefix}CliArgs`] || DEFAULTS[channel].cliArgs,
  };
};

const normalizedProfile = (channel, value = {}, index = 0, secrets = {}) => {
  const fallback = DEFAULTS[channel];
  const draft = value.draft === true;
  const id = stringValue(value.id).trim() || `${channel}-${index + 1}`;
  const genericOpenCode = channel === "text" && stringValue(value.agentEngine).trim() === "opencode";
  const requestedProvider = draft || genericOpenCode
    ? stringValue(value.provider).trim()
    : stringValue(value.provider, fallback.provider).trim() || fallback.provider;
  const provider = requestedProvider === "公益模型" ? "免费模型" : requestedProvider;
  const adapter = value.adapter === "cli" ? "cli" : value.adapter === "api" ? "api" : draft ? "" : "api";
  const requestedModel = draft ? stringValue(value.model).trim() : stringValue(value.model, fallback.model).trim();
  const providerPreset = getProviderPreset(provider);
  const catalog = channel === "image"
    ? getProviderImageModelOptions(provider, adapter)
    : channel === "video"
      ? getProviderVideoModelOptions(provider, adapter)
      : channel === "text"
        ? getProviderModelOptions(provider).filter((item) => !item.capabilities?.some((capability) => ["image_generation", "video_generation"].includes(capability)))
        : channel === "audio"
          ? getProviderAudioModelOptions(provider, adapter)
          : [];
  // Built-in providers are strict namespaces. A stale model copied from a
  // different provider must never leak back into this profile's picker or
  // request. Custom providers keep arbitrary model IDs by design.
  const model = !draft && !genericOpenCode && providerPreset.custom !== true && providerPreset.public !== true && catalog.length && !catalog.some((item) => item.slug === requestedModel)
    ? catalog.find((item) => item.available !== false && item.selectable !== false)?.slug || catalog[0].slug
    : requestedModel;
  const channelLabel = channel === "text" ? "文字" : channel === "image" ? "图片" : channel === "video" ? "视频" : "音频";
  const requestedProtocol = draft
    ? stringValue(value.protocol).trim()
    : stringValue(value.protocol, fallback.protocol).trim() || fallback.protocol;
  const explicitAgentEngine = stringValue(value.agentEngine).trim();
  const defaultAgentEngine = channel !== "text"
    ? ""
    : explicitAgentEngine
      || (adapter === "api" && ["responses", "chat_completions"].includes(requestedProtocol) ? "codex_api" : "")
      || (adapter === "cli" && provider === "OpenAI" ? "codex" : "");
  const executionModes = channel === "text" ? ["agent"] : [];
  const normalized = {
    ...fallback,
    ...value,
    id,
    draft,
    name: (provider === "免费模型" && stringValue(value.name).trim() === "公益模型" ? "免费模型" : stringValue(value.name).trim()) || (draft
      ? `未配置${channelLabel}连接`
      : `${provider} ${channelLabel}${model ? ` · ${model}` : ""}`),
    adapter,
    provider,
    protocol: requestedProtocol,
    baseUrl: draft ? stringValue(value.baseUrl).trim() : stringValue(value.baseUrl, fallback.baseUrl).trim(),
    model,
    timeoutMs: draft ? stringValue(value.timeoutMs) : stringValue(value.timeoutMs, fallback.timeoutMs),
    apiKey: stringValue(secrets[id], stringValue(value.apiKey)),
    cliPath: stringValue(value.cliPath),
    cliArgs: stringValue(value.cliArgs),
    remarkName: (provider === "免费模型" && stringValue(value.remarkName).trim() === "公益模型"
      ? "免费模型"
      : stringValue(value.remarkName).trim()).slice(0, 80),
    executionMode: channel === "text" ? "agent" : "",
    executionModes,
    agentEngine: channel === "text" ? defaultAgentEngine : "",
    agentModelId: channel === "text" ? stringValue(value.agentModelId, model).trim() : "",
    chatModelId: channel === "text" ? stringValue(value.chatModelId).trim() : "",
    credentialSource: channel === "text"
      ? stringValue(value.credentialSource).trim()
        || (providerPreset.public === true || value.systemManaged === true && provider === "免费模型" ? "public" : defaultAgentEngine === "codex_api" ? "shensi" : "")
      : "",
    runtimeProfileId: channel === "text" ? stringValue(value.runtimeProfileId).trim() : "",
    runtimeConfigPath: channel === "text" ? stringValue(value.runtimeConfigPath).trim() : "",
  };
  // Dreamina identity is meaningful only for the Dreamina CLI account pool.
  // Clear legacy fields when a profile is changed to another provider or
  // adapter so they cannot leak into runtime binding comparisons.
  return withoutNonDreaminaIdentity(normalized);
};

const isLegacyOpenAiImageDefault = (profile = {}) => profile.id === "image-default"
  && profile.adapter === "api"
  && profile.provider === "OpenAI"
  && profile.protocol === "images"
  && /^https:\/\/api\.openai\.com\/v1\/?$/i.test(profile.baseUrl)
  && /^gpt-image-(?:1(?:\.5)?|2)$/i.test(profile.model)
  && !profile.cliPath;

const migrateLegacyOpenAiImageDefault = (profile) => isLegacyOpenAiImageDefault(profile) ? {
  ...profile,
  name: "OpenAI GPT 图片 CLI",
  adapter: "cli",
  model: "gpt-image-2",
  cliPath: OPENAI_IMAGE_CLI_ALIAS,
  cliArgs: OPENAI_IMAGE_CLI_ARGS,
} : profile;

const migratePreferredOpenAiImageModel = (profile) => profile.provider === "OpenAI" && profile.model === "gpt-image-1.5"
  ? { ...profile, model: "gpt-image-2" }
  : profile;

const baseProfileIsConfigured = (profile = {}) => profile.adapter === "cli"
  ? Boolean(profile.cliPath)
  : Boolean(profile.adapter === "api"
    && profile.baseUrl
    && profile.model
    && (profile.apiKey || getProviderPreset(profile.provider).public === true));

const ensureBuiltInOpenAiImageProfile = (profiles, secrets = {}) => {
  const migrated = profiles.map(migrateLegacyOpenAiImageDefault);
  if (migrated.some((profile) => profile.cliPath === OPENAI_IMAGE_CLI_ALIAS)) return migrated;
  const id = migrated.some((profile) => profile.id === DEFAULTS.image.id) ? "image-openai-cli" : DEFAULTS.image.id;
  const reusableApiKey = migrated.find((profile) => profile.provider === "OpenAI"
    && /^https:\/\/api\.openai\.com\/v1\/?$/i.test(profile.baseUrl)
    && profile.apiKey)?.apiKey || "";
  return [
    ...migrated,
    normalizedProfile("image", { ...DEFAULTS.image, id, apiKey: reusableApiKey }, migrated.length, secrets),
  ];
};

const ensureBuiltInAggregateImageApiProfile = (profiles, secrets = {}) => {
  const comparableBaseUrl = (value) => String(value || "").trim().replace(/\/+$/, "").toLocaleLowerCase();
  const expectedBaseUrl = comparableBaseUrl(BUILT_IN_AGGREGATE_IMAGE_API.baseUrl);
  const alreadyConfigured = profiles.some((profile) => profile.id === BUILT_IN_AGGREGATE_IMAGE_API.id
    || (profile.adapter === "api"
      && profile.provider === BUILT_IN_AGGREGATE_IMAGE_API.provider
      && comparableBaseUrl(profile.baseUrl) === expectedBaseUrl
      && String(profile.model || "").trim().toLocaleLowerCase() === BUILT_IN_AGGREGATE_IMAGE_API.model));
  if (alreadyConfigured) return profiles;
  return [
    ...profiles,
    normalizedProfile("image", BUILT_IN_AGGREGATE_IMAGE_API, profiles.length, secrets),
  ];
};

const ensureBuiltInAggregateVideoApiProfile = (profiles, secrets = {}) => {
  const comparableBaseUrl = (value) => String(value || "").trim().replace(/\/+$/, "").toLocaleLowerCase();
  const expectedBaseUrl = comparableBaseUrl(BUILT_IN_AGGREGATE_VIDEO_API.baseUrl);
  const alreadyConfigured = profiles.some((profile) => profile.id === BUILT_IN_AGGREGATE_VIDEO_API.id
    || (profile.adapter === "api"
      && profile.provider === BUILT_IN_AGGREGATE_VIDEO_API.provider
      && comparableBaseUrl(profile.baseUrl) === expectedBaseUrl
      && String(profile.model || "").trim().toLocaleLowerCase() === BUILT_IN_AGGREGATE_VIDEO_API.model));
  if (alreadyConfigured) return profiles;
  return [
    ...profiles,
    normalizedProfile("video", BUILT_IN_AGGREGATE_VIDEO_API, profiles.length, secrets),
  ];
};

const comparableSharedCredentialEndpoint = (value) => String(value || "")
  .trim()
  .replace(/\/+$/u, "")
  .toLocaleLowerCase();

const customApiCredentialGroupKey = (profile = {}) => {
  if (profile.adapter !== "api" || getProviderPreset(profile.provider).custom !== true) return "";
  if (profile.credentialSharing === "isolated") return "";
  const provider = String(profile.provider || "").trim().toLocaleLowerCase();
  const endpoint = comparableSharedCredentialEndpoint(profile.baseUrl);
  return provider && endpoint ? `${provider}\0${endpoint}` : "";
};

// Custom/aggregate endpoints often expose text, image and video behind one
// access token. Reuse that token only when the exact provider+Base URL group
// has one unambiguous credential. Explicit per-channel credentials always win;
// multiple different credentials on one endpoint are never guessed between.
export const shareCustomApiCredentials = (settings = {}, secrets = {}) => {
  const next = { ...settings };
  const groups = new Map();
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    next[keys.list] = (settings[keys.list] ?? []).map((profile) => ({ ...profile }));
    for (const profile of next[keys.list]) {
      const groupKey = customApiCredentialGroupKey(profile);
      if (!groupKey) continue;
      const ownSecret = String(secrets?.[channel]?.[profile.id] || "").trim();
      const inherited = Boolean(profile.credentialSharedFromChannel && profile.credentialSharedFromProfileId);
      const directSecret = ownSecret || (inherited ? "" : String(profile.apiKey || "").trim());
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ channel, profile, directSecret });
    }
  }
  for (const records of groups.values()) {
    const donors = records.filter((record) => record.directSecret);
    const uniqueSecrets = [...new Set(donors.map((record) => record.directSecret))];
    if (uniqueSecrets.length !== 1) continue;
    const donor = donors[0];
    for (const record of records) {
      if (record.directSecret) {
        delete record.profile.credentialSharedFromChannel;
        delete record.profile.credentialSharedFromProfileId;
        continue;
      }
      record.profile.apiKey = donor.directSecret;
      record.profile.credentialSharing = "same_endpoint";
      record.profile.credentialSharedFromChannel = donor.channel;
      record.profile.credentialSharedFromProfileId = donor.profile.id;
    }
  }
  return next;
};

const isCodexTextCliProfile = (profile = {}) => profile.adapter === "cli"
  && profile.provider === "OpenAI"
  && (profile.agentEngine === "codex"
    || /^codex(?:\.(?:exe|cmd|ps1))?$/i.test(String(profile.cliPath || "").split(/[\\/]/u).at(-1) || ""));

const isCodexTextCliBinding = (binding = {}) => binding.channel === "text"
  && binding.adapter === "cli"
  && binding.provider === "OpenAI"
  && /^codex(?:\.(?:exe|cmd|ps1))?$/i.test(String(binding.cliPath || "").split(/[\\/]/u).at(-1) || "codex");

// A Codex CLI profile supports both Chat and Agent. Older migrations could
// materialize the same connection twice when text-default was already in use.
// Collapse those aliases while retaining the profile selected by either mode.
const collapseDuplicateCodexCliProfiles = (profiles = [], settings = {}) => {
  const codexProfiles = profiles.filter(isCodexTextCliProfile);
  if (codexProfiles.length < 2) return { profiles, aliases: new Map() };
  const requestedIds = [settings.activeTextChatConnectionId, settings.activeTextAgentConnectionId]
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const canonical = codexProfiles.find((profile) => profile.id === "text-default")
    || codexProfiles.find((profile) => requestedIds.includes(profile.id))
    || codexProfiles[0];
  const activeProfiles = codexProfiles.filter((profile) => requestedIds.includes(profile.id));
  const mergeOrder = [canonical, ...activeProfiles, ...codexProfiles]
    .filter((profile, index, list) => list.findIndex((candidate) => candidate.id === profile.id) === index);
  const merged = { ...canonical };
  for (const profile of mergeOrder.slice(1)) {
    for (const [key, value] of Object.entries(profile)) {
      if (key === "id" || value === undefined || value === null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      merged[key] = value;
    }
  }
  merged.executionMode = "agent";
  merged.executionModes = ["agent"];
  merged.agentEngine = "codex";
  const normalized = normalizedProfile("text", { ...merged, id: canonical.id }, 0);
  const codexIds = new Set(codexProfiles.map((profile) => profile.id));
  const aliases = new Map(codexProfiles.map((profile) => [profile.id, canonical.id]));
  return {
    profiles: profiles
      .filter((profile) => !codexIds.has(profile.id) || profile.id === canonical.id)
      .map((profile) => profile.id === canonical.id ? normalized : profile),
    aliases,
  };
};

const ensureBuiltInGptChatCliProfile = (profiles, secrets = {}, disabledProfileIds = []) => {
  const preset = getProviderPreset("OpenAI").cli;
  const existingIndex = profiles.findIndex((profile) => profile.adapter === "cli"
    && (profile.agentEngine === "codex"
      || (profile.provider === "OpenAI"
        && (profile.id === BUILT_IN_GPT_CHAT_CLI.id
          || /^codex(?:\.(?:exe|cmd|ps1))?$/i.test(String(profile.cliPath).split(/[\\/]/).at(-1) || "")))));
  if (existingIndex >= 0) {
    return profiles.map((profile, index) => index === existingIndex ? {
      ...profile,
      name: !profile.name || /^OpenAI\s/.test(profile.name) ? BUILT_IN_GPT_CHAT_CLI.name : profile.name,
      protocol: profile.protocol || BUILT_IN_GPT_CHAT_CLI.protocol,
      model: profile.model || BUILT_IN_GPT_CHAT_CLI.model,
      cliPath: profile.cliPath || preset.path,
      cliArgs: profile.cliArgs || preset.args,
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "codex",
    } : profile);
  }
  if (disabledProfileIds.includes(BUILT_IN_GPT_CHAT_CLI.id)) return profiles;
  const ids = new Set(profiles.map((profile) => profile.id));
  let id = BUILT_IN_GPT_CHAT_CLI.id;
  if (ids.has(id)) {
    id = "text-openai-codex-cli";
    let suffix = 2;
    while (ids.has(id)) id = `text-openai-codex-cli-${suffix++}`;
  }
  return [
    ...profiles,
    normalizedProfile("text", { ...BUILT_IN_GPT_CHAT_CLI, id }, profiles.length, secrets),
  ];
};

const ensureBuiltInPublicTextProfile = (profiles) => {
  const existingIndex = profiles.findIndex((profile) => profile.id === BUILT_IN_PUBLIC_TEXT_PROFILE.id);
  if (existingIndex >= 0) {
    const existing = profiles[existingIndex];
    const managed = normalizedProfile("text", {
      ...BUILT_IN_PUBLIC_TEXT_PROFILE,
      ...existing,
      id: BUILT_IN_PUBLIC_TEXT_PROFILE.id,
      name: BUILT_IN_PUBLIC_TEXT_PROFILE.name,
      remarkName: BUILT_IN_PUBLIC_TEXT_PROFILE.remarkName,
      systemManaged: true,
      adapter: BUILT_IN_PUBLIC_TEXT_PROFILE.adapter,
      provider: BUILT_IN_PUBLIC_TEXT_PROFILE.provider,
      protocol: BUILT_IN_PUBLIC_TEXT_PROFILE.protocol,
      baseUrl: BUILT_IN_PUBLIC_TEXT_PROFILE.baseUrl,
      model: existing.model || BUILT_IN_PUBLIC_TEXT_PROFILE.model,
      apiKey: "",
      cliPath: "",
      cliArgs: "",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "codex_api",
      agentModelId: existing.model || BUILT_IN_PUBLIC_TEXT_PROFILE.model,
      chatModelId: "",
      credentialSource: "public",
    }, existingIndex, {});
    return profiles.map((profile, index) => index === existingIndex ? managed : profile);
  }
  return [
    ...profiles,
    normalizedProfile("text", BUILT_IN_PUBLIC_TEXT_PROFILE, profiles.length, {}),
  ];
};

const ensureBuiltInPublicAgentProfile = (profiles) => {
  const existingIndex = profiles.findIndex((profile) => profile.id === BUILT_IN_PUBLIC_AGENT_PROFILE.id);
  if (existingIndex >= 0) {
    const existing = profiles[existingIndex];
    const managed = normalizedProfile("text", {
      ...BUILT_IN_PUBLIC_AGENT_PROFILE,
      ...existing,
      id: BUILT_IN_PUBLIC_AGENT_PROFILE.id,
      name: BUILT_IN_PUBLIC_AGENT_PROFILE.name,
      remarkName: BUILT_IN_PUBLIC_AGENT_PROFILE.remarkName,
      systemManaged: true,
      adapter: BUILT_IN_PUBLIC_AGENT_PROFILE.adapter,
      provider: BUILT_IN_PUBLIC_AGENT_PROFILE.provider,
      protocol: existing.protocol || BUILT_IN_PUBLIC_AGENT_PROFILE.protocol,
      baseUrl: existing.baseUrl || BUILT_IN_PUBLIC_AGENT_PROFILE.baseUrl,
      model: existing.model || BUILT_IN_PUBLIC_AGENT_PROFILE.model,
      agentModelId: existing.model || BUILT_IN_PUBLIC_AGENT_PROFILE.model,
      chatModelId: "",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "codex_api",
      credentialSource: "public",
    }, existingIndex, {});
    return profiles.map((profile, index) => index === existingIndex ? managed : profile);
  }
  return [
    ...profiles,
    normalizedProfile("text", BUILT_IN_PUBLIC_AGENT_PROFILE, profiles.length, {}),
  ];
};

const normalizeDeepSeekTextModes = (profiles) => profiles.map((profile) => {
  // The legacy DeepSeek CLI migration only owns profiles that never selected
  // a runner (or explicitly retain the old deepseek_opencode compatibility
  // runner). A modern explicit runner such as Claude Code must survive reload
  // unchanged; otherwise the saved composite silently routes back to the old
  // OpenCode-only path.
  if (profile.agentEngine && profile.agentEngine !== "deepseek_opencode") return profile;
  if (profile.provider !== "DeepSeek") return profile;
  if (profile.adapter === "api") {
    return {
      ...profile,
      name: !profile.name || /^DeepSeek(?:\s+(?:Chat|API))?(?:\s*·\s*API)?$/i.test(profile.name) ? "DeepSeek · 神思运行器" : profile.name,
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "codex_api",
      agentModelId: profile.agentModelId || profile.model,
      chatModelId: "",
      credentialSource: profile.credentialSource || "shensi",
    };
  }
  if (profile.adapter === "cli") {
    const migrated = unifiedOpenCodeProfile(profile);
    const legacyLabel = /^(?:OpenCode\+DeepSeek|DeepSeek(?:\s+(?:Agent|CLI))?(?:\s*[·+]\s*OpenCode(?:\s+CLI)?)?)$/iu;
    return {
      ...migrated,
      name: !profile.name || legacyLabel.test(profile.name) ? "DeepSeek Agent" : profile.name,
      remarkName: !profile.remarkName || legacyLabel.test(profile.remarkName) ? "DeepSeek Agent" : profile.remarkName,
    };
  }
  return profile;
});

const collapseLegacyDeepSeekOpenCodeProfiles = (profiles = []) => {
  const aliases = new Map();
  const removed = new Set();
  const comparableEndpoint = (value = "") => String(value || "https://api.deepseek.com/v1").trim().replace(/\/+$/u, "").toLowerCase();
  const modern = profiles.filter((profile) => profile.agentEngine === "opencode"
    && profile.provider === "DeepSeek"
    && profile.adapter === "cli");
  for (const legacy of profiles.filter((profile) => profile.agentEngine === "deepseek_opencode")) {
    const legacyModel = qualifiedOpenCodeModel(legacy.agentModelId || legacy.model, legacy.provider || "DeepSeek");
    const replacement = modern.find((profile) => (
      qualifiedOpenCodeModel(profile.agentModelId || profile.model, profile.provider || "DeepSeek") === legacyModel
      && comparableEndpoint(profile.baseUrl) === comparableEndpoint(legacy.baseUrl)
    ));
    if (!replacement) continue;
    aliases.set(legacy.id, replacement.id);
    removed.add(legacy.id);
    if (!replacement.apiKey && legacy.apiKey) replacement.apiKey = legacy.apiKey;
  }
  return {
    profiles: profiles.filter((profile) => !removed.has(profile.id)),
    aliases,
  };
};

const normalizeTextRuntimeModelFields = (profile = {}) => {
  const model = String(profile.model || "").trim();
  const modes = Array.isArray(profile.executionModes) ? profile.executionModes : [];
  const engine = String(profile.agentEngine || "").trim();
  if (engine === "codex_api") {
    return {
      ...profile,
      agentModelId: modes.includes("agent") ? model : "",
      chatModelId: modes.includes("chat") ? model : "",
    };
  }
  if (engine === "opencode") {
    const qualified = qualifiedOpenCodeModel(profile.agentModelId || model, profile.provider);
    const source = profile.credentialSource === "shensi" ? "shensi" : "opencode";
    return {
      ...profile,
      model: qualified,
      agentModelId: modes.includes("agent") ? qualified : "",
      chatModelId: modes.includes("chat") && source === "shensi" ? qualified.split("/").slice(1).join("/") : "",
      credentialSource: source,
    };
  }
  if (engine === "codex" || engine === "claude_code") {
    return {
      ...profile,
      agentModelId: modes.includes("agent") ? model : "",
      chatModelId: modes.includes("chat") ? model : "",
    };
  }
  return {
    ...profile,
    agentEngine: "",
    agentModelId: "",
    chatModelId: modes.includes("chat") ? model : "",
  };
};

const normalizeOpenCodeProfileLabel = (profile = {}) => {
  if (profile.agentEngine !== "opencode" || profile.provider !== "DeepSeek") return profile;
  const oldLabel = /^(?:OpenCode\+DeepSeek|DeepSeek(?:\s+(?:Agent|CLI))?(?:\s*[·+]\s*OpenCode(?:\s+CLI)?)?)$/iu;
  return {
    ...profile,
    name: !profile.name || oldLabel.test(profile.name) ? "DeepSeek Agent" : profile.name,
    remarkName: !profile.remarkName || oldLabel.test(profile.remarkName) ? "DeepSeek Agent" : profile.remarkName,
  };
};

const LEGACY_REMOVED_TEXT_PROFILE_IDS = new Set([
  "text-public-kilo",
  "text-1785037658236-3q8e8",
  "text-1785566796473-sznmo",
]);

const deepSeekAgentProfile = (profile = {}) => profile.provider === "DeepSeek"
  && profile.adapter === "cli"
  && (["opencode", "deepseek_opencode", "claude_code"].includes(String(profile.agentEngine || "").trim())
    || ["opencode", DEEPSEEK_OPENCODE_CLI_ALIAS].includes(String(profile.cliPath || "").trim()));

const legacyRemovedTextProfile = (profile = {}) => LEGACY_REMOVED_TEXT_PROFILE_IDS.has(String(profile.id || ""))
  || (profile.agentEngine === "codex_api" && profile.systemManaged !== true
    && /^(?:神思运行器|神思运行器配置)$/u.test(String(profile.remarkName || profile.name || "").trim()));

const deepSeekAgentScore = (profile = {}, activeIds = new Set()) => {
  const hasCredential = Boolean(String(profile.apiKey || "").trim());
  return (activeIds.has(profile.id) ? 10_000 : 0)
    + (profile.credentialSource === "shensi" && hasCredential ? 1_000 : 0)
    + (hasCredential ? 300 : 0)
    + (profile.credentialSource === "shensi" ? 100 : 0)
    + (profile.id === "text-claude-code-deepseek" ? 20 : 0)
    + (profile.agentEngine === "opencode" ? 10 : 0);
};

// This text-only pass retains the public Agent, removes retired standalone
// entries and collapses duplicate DeepSeek Agent rows. It only receives
// the text registry so no media profile, account lock or credential route can
// be changed by this migration.
export const cleanupLegacyTextProfiles = (profiles = [], settings = {}) => {
  const aliases = new Map();
  const activeIds = new Set([
    settings.activeTextConnectionId,
    settings.activeTextChatConnectionId,
    settings.activeTextAgentConnectionId,
  ].map((value) => String(value || "").trim()).filter(Boolean));
  const retained = profiles.filter((profile) => !legacyRemovedTextProfile(profile));
  const deepSeekProfiles = retained.filter(deepSeekAgentProfile);
  const canonicalDeepSeek = [...deepSeekProfiles].sort((left, right) => (
    deepSeekAgentScore(right, activeIds) - deepSeekAgentScore(left, activeIds)
  ))[0] || null;
  const cleaned = retained.filter((profile) => !deepSeekAgentProfile(profile) || profile.id === canonicalDeepSeek?.id)
    .map((profile) => profile.id === canonicalDeepSeek?.id ? {
      ...profile,
      name: "DeepSeek Agent",
      remarkName: "DeepSeek Agent",
      executionMode: "agent",
      executionModes: ["agent"],
      chatModelId: "",
    } : profile);
  for (const profile of profiles) {
    if (profile.id === canonicalDeepSeek?.id) continue;
    if (deepSeekAgentProfile(profile)) aliases.set(profile.id, canonicalDeepSeek.id);
    else if (legacyRemovedTextProfile(profile) && profile.provider === "DeepSeek" && canonicalDeepSeek) {
      aliases.set(profile.id, canonicalDeepSeek.id);
    }
    else if (legacyRemovedTextProfile(profile)) aliases.set(profile.id, BUILT_IN_PUBLIC_AGENT_PROFILE.id);
  }
  return { profiles: cleaned, aliases, canonicalDeepSeekId: canonicalDeepSeek?.id || "" };
};

export const pruneRetiredTextProfileSecrets = (secrets = {}, settings = {}) => {
  // Removing a connection from the picker does not authorize erasing its
  // credential. Keep locally held secrets available for explicit recovery.
  const next = Object.fromEntries(Object.entries(secrets && typeof secrets === "object" ? secrets : {})
    .map(([channel, records]) => [channel, { ...(records && typeof records === "object" && !Array.isArray(records) ? records : {}) }]));
  next.text = { ...(next.text ?? {}) };
  return next;
};

const deduplicateBuiltInOpenAiImageProfiles = (profiles, preferredId = "") => {
  const identity = (profile) => profile?.cliPath === OPENAI_IMAGE_CLI_ALIAS
    ? JSON.stringify([
        profile.adapter,
        profile.provider,
        profile.protocol,
        profile.baseUrl,
        profile.model,
        profile.timeoutMs,
        profile.cliPath,
        profile.cliArgs,
        profile.apiKey,
      ])
    : "";
  const groups = new Map();
  for (const profile of profiles) {
    const key = identity(profile);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(profile);
  }
  const removedIds = new Set();
  const replacements = new Map();
  for (const matches of groups.values()) {
    if (matches.length < 2) continue;
    const byRemark = new Map();
    for (const profile of matches) {
      const remark = String(profile.remarkName || "").trim();
      if (!byRemark.has(remark)) byRemark.set(remark, []);
      byRemark.get(remark).push(profile);
    }
    // Two explicitly named entries may represent two intentional account
    // slots, even when their executable templates are currently identical.
    // Preserve different non-empty remarks; only remove exact aliases and the
    // unnamed built-in alias that otherwise reappears beside a named slot.
    for (const sameRemark of byRemark.values()) {
      if (sameRemark.length < 2) continue;
      const keep = sameRemark.find((profile) => profile.id === preferredId) || sameRemark[0];
      for (const profile of sameRemark) if (profile.id !== keep.id) removedIds.add(profile.id);
    }
    const unnamed = byRemark.get("")?.filter((profile) => !removedIds.has(profile.id)) || [];
    const named = matches.filter((profile) => String(profile.remarkName || "").trim() && !removedIds.has(profile.id));
    if (!unnamed.length || !named.length) continue;
    const preferredUnnamed = unnamed.find((profile) => profile.id === preferredId);
    if (preferredUnnamed && named.length === 1) {
      replacements.set(preferredUnnamed.id, { ...preferredUnnamed, remarkName: named[0].remarkName });
      removedIds.add(named[0].id);
      for (const profile of unnamed) if (profile.id !== preferredUnnamed.id) removedIds.add(profile.id);
    } else {
      for (const profile of unnamed) removedIds.add(profile.id);
    }
  }
  return profiles
    .filter((profile) => !removedIds.has(profile.id))
    .map((profile) => replacements.get(profile.id) || profile);
};

const ensureBuiltInDreaminaImageProfile = (profiles, secrets = {}) => {
  const builtInIndex = profiles.findIndex((profile) => profile.cliPath === DREAMINA_IMAGE_CLI_ALIAS
    || (profile.id === BUILT_IN_DREAMINA_IMAGE.id
      && profile.adapter === "cli"
      && profile.provider === BUILT_IN_DREAMINA_IMAGE.provider));
  if (builtInIndex >= 0) {
    return profiles
      .map((profile, index) => index === builtInIndex ? {
        ...profile,
        cliPath: profile.cliPath || DREAMINA_IMAGE_CLI_ALIAS,
        cliArgs: profile.cliArgs || DREAMINA_IMAGE_CLI_ARGS,
      } : profile)
      .filter((profile, index) => index === builtInIndex
        || !(/^image-dreamina-cli-\d+$/i.test(profile.id)
          && profile.adapter === "cli"
          && profile.provider === BUILT_IN_DREAMINA_IMAGE.provider
          && (!profile.cliPath || profile.cliPath === DREAMINA_IMAGE_CLI_ALIAS)));
  }
  const id = profiles.some((profile) => profile.id === BUILT_IN_DREAMINA_IMAGE.id)
    ? "image-dreamina-cli-2"
    : BUILT_IN_DREAMINA_IMAGE.id;
  return [
    ...profiles,
    normalizedProfile("image", { ...BUILT_IN_DREAMINA_IMAGE, id }, profiles.length, secrets),
  ];
};

const ensureBuiltInDreaminaVideoProfile = (profiles, secrets = {}) => {
  const builtInIndex = profiles.findIndex((profile) => profile.cliPath === DREAMINA_VIDEO_CLI_ALIAS
    || (profile.id === BUILT_IN_DREAMINA_VIDEO.id
      && profile.adapter === "cli"
      && profile.provider === BUILT_IN_DREAMINA_VIDEO.provider));
  if (builtInIndex >= 0) {
    return profiles
      .map((profile, index) => index === builtInIndex ? {
        ...profile,
        cliPath: profile.cliPath || DREAMINA_VIDEO_CLI_ALIAS,
        cliArgs: profile.cliArgs || DREAMINA_VIDEO_CLI_ARGS,
      } : profile)
      .filter((profile, index) => index === builtInIndex
        || !(/^video-dreamina-cli-\d+$/i.test(profile.id)
          && profile.adapter === "cli"
          && profile.provider === BUILT_IN_DREAMINA_VIDEO.provider
          && (!profile.cliPath || profile.cliPath === DREAMINA_VIDEO_CLI_ALIAS)));
  }
  const id = profiles.some((profile) => profile.id === BUILT_IN_DREAMINA_VIDEO.id)
    ? "video-dreamina-cli-2"
    : BUILT_IN_DREAMINA_VIDEO.id;
  return [
    ...profiles,
    normalizedProfile("video", { ...BUILT_IN_DREAMINA_VIDEO, id }, profiles.length, secrets),
  ];
};

const ensureNamedDreaminaCliProfiles = (profiles, channel, secrets = {}) => {
  const base = channel === "image" ? BUILT_IN_DREAMINA_IMAGE : BUILT_IN_DREAMINA_VIDEO;
  const cliProfiles = new Map(DREAMINA_CLI_PROFILES.map((profile) => [profile.id, profile]));
  const normalized = profiles.map((profile) => {
    const identityText = `${profile.id || ""} ${profile.name || ""} ${profile.remarkName || ""}`.toLowerCase();
    const inferredProfileId = /xiaoyujie|小鱼姐/u.test(identityText)
      ? "xiaoyujie"
      : /guobazai|锅巴仔/u.test(identityText)
        ? "guobazai"
        : /chenan|陈安/u.test(identityText)
          ? "chenan"
          : /tashuo-juyougeng|她说剧有梗/u.test(identityText)
            ? "tashuo-juyougeng"
        : profile.id === base.id
          ? "default"
          : "";
    const selectedProfileId = String(profile.dreaminaCliProfile || inferredProfileId).trim();
    if (!selectedProfileId) return profile;
    const cliProfile = cliProfiles.get(selectedProfileId);
    if (!cliProfile) {
      if (!validDreaminaCliProfileId(selectedProfileId)) return { ...profile, dreaminaCliProfile: "" };
      return normalizedProfile(channel, {
        ...profile,
        dreaminaCliProfile: selectedProfileId,
        cliPath: base.cliPath,
        cliArgs: profile.cliArgs || base.cliArgs,
      }, 0, secrets);
    }
    return normalizedProfile(channel, {
      ...profile,
      dreaminaCliProfile: cliProfile.id,
      remarkName: profile.remarkName || cliProfile.remarkName,
      cliPath: base.cliPath,
      cliArgs: profile.cliArgs || base.cliArgs,
    }, 0, secrets);
  });
  const configuredProfileIds = new Set(normalized
    .map((profile) => String(profile.dreaminaCliProfile || "").trim())
    .filter(Boolean));
  const additions = DREAMINA_CLI_PROFILES
    .filter((profile) => profile.id !== "default" && !configuredProfileIds.has(profile.id))
    .map((profile, index) => normalizedProfile(channel, {
      ...base,
      id: `${base.id}-${profile.id}`,
      name: `${base.name} · ${profile.remarkName}`,
      remarkName: profile.remarkName,
      dreaminaCliProfile: profile.id,
    }, normalized.length + index, secrets));
  return [...normalized, ...additions];
};

const ensureBuiltInLibTvProfile = (profiles, channel, secrets = {}) => {
  const builtIns = channel === "image"
    ? [BUILT_IN_LIBTV_IMAGE]
    : channel === "video"
      ? [BUILT_IN_LIBTV_VIDEO]
      : channel === "audio" ? BUILT_IN_LIBTV_AUDIO_PROFILES : [];
  let next = [...profiles];
  for (const builtIn of builtIns) {
    const existingIndex = next.findIndex((profile) => profile.id === builtIn.id);
    if (existingIndex >= 0) {
      // Workspace documents intentionally omit machine-local runtime fields.
      // Restore the bundled LibTV driver on every normalization so a restart
      // cannot turn a valid built-in profile into an unavailable placeholder.
      next[existingIndex] = normalizedProfile(channel, {
        ...next[existingIndex],
        adapter: builtIn.adapter,
        provider: builtIn.provider,
        protocol: builtIn.protocol,
        baseUrl: builtIn.baseUrl,
        cliPath: builtIn.cliPath,
        cliArgs: builtIn.cliArgs,
        ...(channel === "audio" ? { reserved: false } : {}),
      }, existingIndex, secrets);
      continue;
    }
    next = [...next, normalizedProfile(channel, builtIn, next.length, secrets)];
  }
  return next;
};

const migratePreferredDreaminaVideoModel = (profile) => profile.adapter === "cli"
  && profile.provider === "即梦"
  && profile.cliPath === DREAMINA_VIDEO_CLI_ALIAS
  ? { ...profile, model: "seedance2.5" }
  : profile;

const migrateRequestedCliRemarks = (profiles, channel, activeId = "") => profiles.map((profile) => {
  const activeOrBuiltIn = profile.id === activeId || profile.id === `${channel}-default`;
  if (channel === "text" && activeOrBuiltIn && profile.adapter === "cli" && profile.provider === "OpenAI") {
    return { ...profile, remarkName: "麻雀" };
  }
  if (channel === "image" && activeOrBuiltIn && profile.adapter === "cli" && profile.provider === "OpenAI") {
    return { ...profile, remarkName: "麻雀" };
  }
  if (["image", "video"].includes(channel)
    && profile.adapter === "cli"
    && profile.provider === "即梦"
    && String(profile.dreaminaCliProfile || "").trim() === "default"
    && (!profile.remarkName || profile.remarkName === "默认即梦")) {
    return { ...profile, remarkName: "柏物语" };
  }
  return profile;
});

const deduplicateProfilesById = (profiles = []) => {
  const seen = new Set();
  return profiles.filter((profile) => {
    if (!profile?.id || seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
};

const exactProfileSignature = (profile = {}) => JSON.stringify([
  profile.name || "",
  profile.remarkName || "",
  profile.adapter || "",
  profile.provider || "",
  profile.protocol || "",
  profile.baseUrl || "",
  profile.model || "",
  profile.apiKey || "",
  profile.cliPath || "",
  profile.cliArgs || "",
  profile.timeoutMs || "",
  profile.executionMode || "",
  ...(profile.executionModes || []),
  profile.agentEngine || "",
  profile.agentModelId || "",
  profile.chatModelId || "",
  profile.runtimeProfileId || "",
  profile.runtimeConfigPath || "",
  profile.dreaminaCliProfile || "",
  profile.credentialSource || "",
  profile.systemManaged === true,
  profile.draft === true,
]);

const cleanupInvalidGenerationProfiles = (profiles = [], { activeIds = [] } = {}) => {
  const active = new Set(activeIds.map(String).filter(Boolean));
  const cleaned = [];
  const signatures = new Map();
  const aliases = new Map();
  for (const profile of profiles) {
    if (!profile?.id || profile.reserved === true) continue;
    const signature = exactProfileSignature(profile);
    const previousIndex = signatures.get(signature);
    if (previousIndex === undefined) {
      signatures.set(signature, cleaned.length);
      cleaned.push(profile);
      continue;
    }
    const previous = cleaned[previousIndex];
    if (active.has(profile.id) && !active.has(previous.id)) {
      cleaned[previousIndex] = profile;
      aliases.set(previous.id, profile.id);
    } else {
      aliases.set(profile.id, previous.id);
    }
  }
  return { profiles: cleaned, aliases };
};

export const createGenerationProfile = (channel, overrides = {}) => {
  if (!CHANNELS.includes(channel)) throw new Error("未知生成通道");
  const id = String(overrides.id || `${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  if (overrides.draft === true) {
    const blank = Object.fromEntries(Object.keys(DEFAULTS[channel]).map((key) => [key, ""]));
    return normalizedProfile(channel, { ...blank, ...overrides, id, draft: true }, 0);
  }
  return normalizedProfile(channel, { ...DEFAULTS[channel], ...overrides, id }, 0);
};

export const normalizeGenerationProfiles = (settings = {}, secrets = {}) => {
  const next = { ...settings, agentPermissionMode: normalizeAgentPermissionMode(settings.agentPermissionMode) };
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    const source = Array.isArray(settings[keys.list]) && settings[keys.list].length
      ? settings[keys.list]
      : [legacyProfile(settings, channel)];
    let profiles = deduplicateProfilesById(source.map((profile, index) => normalizedProfile(channel, profile, index, secrets[channel] ?? {})));
    if (channel === "text") {
      const disabledBuiltInTextProfileIds = Array.isArray(settings.disabledBuiltInTextProfileIds)
        ? settings.disabledBuiltInTextProfileIds
        : [];
      next.disabledBuiltInTextProfileIds = [...new Set(disabledBuiltInTextProfileIds)];
      profiles = ensureBuiltInGptChatCliProfile(
        profiles,
        secrets.text ?? {},
        disabledBuiltInTextProfileIds,
      );
      const openCodeCollapse = collapseLegacyDeepSeekOpenCodeProfiles(profiles);
      profiles = openCodeCollapse.profiles;
      const remapOpenCodeId = (value) => openCodeCollapse.aliases.get(String(value || "").trim()) || value;
      next.activeTextConnectionId = remapOpenCodeId(next.activeTextConnectionId);
      next.activeTextChatConnectionId = remapOpenCodeId(next.activeTextChatConnectionId);
      next.activeTextAgentConnectionId = remapOpenCodeId(next.activeTextAgentConnectionId);
      const codexCollapse = collapseDuplicateCodexCliProfiles(profiles, settings);
      profiles = codexCollapse.profiles;
      const remapCodexId = (value) => codexCollapse.aliases.get(String(value || "").trim()) || value;
      // Accept an old Chat pointer only as an upgrade input when the unified
      // or Agent pointer did not yet exist. All three fields are collapsed to
      // one Agent configuration below; this preserves the user's selection
      // without reviving an independently selectable Chat mode.
      const requestedTextId = settings.activeTextAgentConnectionId || settings.activeTextConnectionId || settings.activeTextChatConnectionId;
      const remappedRequestedTextId = remapCodexId(remapOpenCodeId(requestedTextId));
      next.activeTextConnectionId = remappedRequestedTextId;
      next.activeTextChatConnectionId = remappedRequestedTextId;
      next.activeTextAgentConnectionId = remappedRequestedTextId;
      profiles = normalizeDeepSeekTextModes(profiles);
      profiles = profiles.map(normalizeTextRuntimeModelFields).map(normalizeOpenCodeProfileLabel);
      const previousPublic = profiles.find((profile) => profile.id === BUILT_IN_PUBLIC_AGENT_PROFILE.id && profile.provider === "免费模型")
        || profiles.find((profile) => profile.id === BUILT_IN_PUBLIC_TEXT_PROFILE.id && profile.provider === "免费模型");
      const textCleanup = cleanupLegacyTextProfiles(profiles, next);
      profiles = ensureBuiltInPublicAgentProfile(previousPublic && !textCleanup.profiles.some((profile) => profile.id === BUILT_IN_PUBLIC_AGENT_PROFILE.id)
        ? [...textCleanup.profiles, { ...previousPublic, id: BUILT_IN_PUBLIC_AGENT_PROFILE.id }]
        : textCleanup.profiles);
      const retainedIds = new Set(profiles.map((profile) => profile.id));
      const backup = new Map((Array.isArray(settings.retiredTextProfileBackup) ? settings.retiredTextProfileBackup : []).map((profile) => [profile.id, profile]));
      for (const profile of source) {
        if (!profile?.id || retainedIds.has(profile.id) || backup.has(profile.id)) continue;
        const metadata = Object.fromEntries(["id", "name", "remarkName", "provider", "adapter", "agentEngine", "model", "agentModelId", "baseUrl", "protocol", "cliPath", "cliArgs", "credentialSource", "systemManaged", "executionMode", "executionModes"]
          .filter((key) => Object.hasOwn(profile, key)).map((key) => [key, profile[key]]));
        backup.set(profile.id, metadata);
      }
      next.retiredTextProfileBackup = [...backup.values()];
      next.textProfileAliases = { ...settings.textProfileAliases, ...Object.fromEntries(openCodeCollapse.aliases), ...Object.fromEntries(codexCollapse.aliases), ...Object.fromEntries(textCleanup.aliases) };
      const remapCleanedTextId = (value) => textCleanup.aliases.get(String(value || "").trim()) || value;
      next.activeTextConnectionId = remapCleanedTextId(next.activeTextConnectionId);
      next.activeTextChatConnectionId = remapCleanedTextId(next.activeTextChatConnectionId);
      next.activeTextAgentConnectionId = remapCleanedTextId(next.activeTextAgentConnectionId);
      const legacyConnectionSelected = !Array.isArray(settings.textConnections) && Boolean(settings.provider || settings.model || settings.adapter);
      if (!legacyConnectionSelected && !(settings.activeTextAgentConnectionId || settings.activeTextConnectionId || settings.activeTextChatConnectionId)
        || ![next.activeTextConnectionId, next.activeTextAgentConnectionId].some((id) => retainedIds.has(id))) {
        const defaultId = legacyConnectionSelected && retainedIds.has(source[0]?.id) ? source[0].id : BUILT_IN_PUBLIC_AGENT_PROFILE.id;
        next.activeTextConnectionId = next.activeTextAgentConnectionId = defaultId;
      }
      next.textProfileCleanupVersion = TEXT_PROFILE_CLEANUP_VERSION;
    }
    if (channel === "image") {
      profiles = ensureBuiltInOpenAiImageProfile(profiles, secrets.image ?? {});
      profiles = deduplicateBuiltInOpenAiImageProfiles(profiles, settings[keys.active]);
      profiles = ensureBuiltInDreaminaImageProfile(profiles, secrets.image ?? {});
      profiles = ensureNamedDreaminaCliProfiles(profiles, "image", secrets.image ?? {});
      if ((Number(settings.aggregateImageApiProfileVersion) || 0) < AGGREGATE_IMAGE_API_PROFILE_VERSION) {
        profiles = ensureBuiltInAggregateImageApiProfile(profiles, secrets.image ?? {});
      }
      if ((Number(settings.imageModelSelectionVersion) || 0) < IMAGE_MODEL_SELECTION_VERSION) {
        profiles = profiles.map(migratePreferredOpenAiImageModel);
      }
      next.imageModelSelectionVersion = IMAGE_MODEL_SELECTION_VERSION;
      next.aggregateImageApiProfileVersion = AGGREGATE_IMAGE_API_PROFILE_VERSION;
      profiles = ensureBuiltInLibTvProfile(profiles, channel, secrets.image ?? {});
    }
    if (channel === "video") {
      profiles = ensureBuiltInDreaminaVideoProfile(profiles, secrets.video ?? {});
      profiles = ensureNamedDreaminaCliProfiles(profiles, "video", secrets.video ?? {});
      if ((Number(settings.aggregateCustomMediaProfileVersion) || 0) < AGGREGATE_CUSTOM_MEDIA_PROFILE_VERSION) {
        profiles = ensureBuiltInAggregateVideoApiProfile(profiles, secrets.video ?? {});
      }
      if ((Number(settings.videoCliDefaultVersion) || 0) < VIDEO_CLI_DEFAULT_VERSION) {
        profiles = profiles.map(migratePreferredDreaminaVideoModel);
      }
      next.videoCliDefaultVersion = VIDEO_CLI_DEFAULT_VERSION;
      next.aggregateCustomMediaProfileVersion = AGGREGATE_CUSTOM_MEDIA_PROFILE_VERSION;
      profiles = ensureBuiltInLibTvProfile(profiles, channel, secrets.video ?? {});
    }
    if (channel === "audio") {
      profiles = ensureBuiltInLibTvProfile(profiles, channel, secrets.audio ?? {});
    }
    const cleanup = cleanupInvalidGenerationProfiles(profiles, {
      activeIds: channel === "text"
        ? [next.activeTextConnectionId, next.activeTextChatConnectionId, next.activeTextAgentConnectionId]
        : [settings[keys.active]],
    });
    profiles = cleanup.profiles;
    const remapCleanedId = (value) => cleanup.aliases.get(String(value || "")) || value;
    if (channel === "text") {
      next.activeTextConnectionId = remapCleanedId(next.activeTextConnectionId);
      next.activeTextChatConnectionId = remapCleanedId(next.activeTextChatConnectionId);
      next.activeTextAgentConnectionId = remapCleanedId(next.activeTextAgentConnectionId);
    }
    if ((Number(settings.cliRemarkMigrationVersion) || 0) < CLI_REMARK_MIGRATION_VERSION) {
      profiles = migrateRequestedCliRemarks(profiles, channel, settings[keys.active]);
    }
    const requestedActiveId = channel === "text"
      ? next.activeTextConnectionId
      : settings[keys.active];
    let activeId = profiles.some((profile) => profile.id === requestedActiveId)
      ? requestedActiveId
      : profiles[0]?.id || "";
    if (channel === "text") {
      const requestedAgentId = String(next.activeTextAgentConnectionId || "");
      const unifiedId = profiles.find((profile) => profile.id === requestedAgentId)?.id
        || profiles.find((profile) => profile.id === activeId)?.id
        || profiles[0]?.id
        || "";
      activeId = unifiedId;
      next.activeTextConnectionId = unifiedId;
      next.activeTextAgentConnectionId = unifiedId;
      // Retain the legacy field only as an upgrade alias. It no longer
      // represents an independently selectable Chat execution surface.
      next.activeTextChatConnectionId = unifiedId;
    }
    if (["image", "video", "audio"].includes(channel) && !baseProfileIsConfigured(profiles.find((profile) => profile.id === activeId))) {
      activeId = profiles.find((profile) => baseProfileIsConfigured(profile))?.id || activeId;
    }
    next[keys.list] = profiles;
    next[keys.active] = activeId;
  }
  next.cliRemarkMigrationVersion = CLI_REMARK_MIGRATION_VERSION;
  const shared = shareCustomApiCredentials(next, secrets);
  for (const channel of ["image", "video", "audio"]) {
    const keys = PROFILE_KEYS[channel];
    const current = shared[keys.list]?.find((profile) => profile.id === shared[keys.active]);
    if (!baseProfileIsConfigured(current)) {
      shared[keys.active] = shared[keys.list]?.find((profile) => baseProfileIsConfigured(profile))?.id || shared[keys.active];
    }
  }
  return syncAllLegacyGenerationSettings(shared);
};

const profileModelOptions = (profile, channel) => {
  if (channel === "image") return getProviderImageModelOptions(profile.provider, profile.adapter);
  if (channel === "video") return getProviderVideoModelOptions(profile.provider, profile.adapter);
  if (channel === "audio") return [];
  return getProviderModelOptions(profile.provider)
    .filter((item) => !item.capabilities?.some((capability) => ["image_generation", "video_generation"].includes(capability)));
};

const MODEL_FAMILY_LABELS = {
  image: { OpenAI: "GPT Image", Grok: "Grok Imagine", Gemini: "Nano Banana", "智谱 GLM": "CogView", "即梦": "Seedream" },
  video: { OpenAI: "Sora", "即梦": "Seedance", "阿里云百炼": "HappyHorse" },
  audio: { Sumo: "Sumo", "即梦": "Seed Audio" },
};

export const generationProfileLabel = (profile = {}, channel = "text") => {
  const remarkName = String(profile.remarkName || "").trim();
  if (remarkName) return remarkName;
  if (channel === "text" && ["codex_api", "opencode", "deepseek_opencode", "claude_code"].includes(profile.agentEngine)) {
    if (profile.agentEngine === "codex_api") return "神思运行器";
    const provider = String(profile.provider || openCodeProviderForModel(profile.agentModelId || profile.model) || "").trim();
    const runner = profile.agentEngine === "claude_code" ? "Claude Code" : "OpenCode";
    return provider ? `${runner}+${provider}` : runner;
  }
  const provider = String(profile.provider || "未选择服务商").trim();
  if (channel === "text") return profile.adapter === "cli" ? `${provider} CLI` : provider;
  const options = profileModelOptions(profile, channel).filter((item) => item.available !== false);
  const selected = options.find((item) => item.slug === profile.model);
  const family = MODEL_FAMILY_LABELS[channel]?.[provider] || "";
  const detail = options.length > 1
    ? family
    : options.length === 1
      ? selected?.label || options[0].label
      : String(profile.model || "").trim();
  return detail && detail.toLocaleLowerCase() !== provider.toLocaleLowerCase()
    ? `${provider} · ${detail}`
    : provider;
};

export const uniqueGenerationPickerProfiles = (profiles = [], { channel = "text", activeId = "" } = {}) => {
  const slots = [];
  const seenIds = new Set();
  for (const profile of profiles) {
    const id = String(profile?.id || "").trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    slots.push(profile);
  }
  return slots;
};

// A picker is navigation, not an execution gate. Keep every saved concrete
// profile visible even while its capability probe is pending or failed, so the
// active provider and model can never be rendered as two different profiles.
export const visibleGenerationPickerProfiles = (settings = {}, channel = "text") => {
  const keys = PROFILE_KEYS[channel];
  if (!keys) return [];
  const profiles = (Array.isArray(settings[keys.list]) ? settings[keys.list] : [])
    .filter((profile) => profile?.id
      && profile.draft !== true
      && (String(profile.provider || "").trim() || (channel === "text" && profile.agentEngine === "opencode")));
  return uniqueGenerationPickerProfiles(profiles, {
    channel,
    activeId: settings[keys.active] || "",
  });
};

export const activeGenerationProfile = (settings = {}, channel, profileId = "") => {
  const keys = PROFILE_KEYS[channel];
  if (!keys) return null;
  const profiles = Array.isArray(settings[keys.list]) ? settings[keys.list] : [];
  let requestedId = String(profileId || settings[keys.active] || "").trim();
  if (channel === "text" && !profiles.some((profile) => profile.id === requestedId)) {
    const visited = new Set();
    while (settings.textProfileAliases?.[requestedId] && !visited.has(requestedId)) {
      visited.add(requestedId);
      requestedId = String(settings.textProfileAliases[requestedId]);
      if (profiles.some((profile) => profile.id === requestedId)) break;
    }
  }
  if (requestedId) return profiles.find((profile) => profile.id === requestedId) ?? null;
  return profiles[0] ?? null;
};

export const deepSeekOpenCodeManualProfile = ({
  id = "",
  name = "DeepSeek Agent",
  model = "",
  apiKey = "",
  reasoningEffort = "high",
  temperature = "0.7",
  maxOutputTokens = "4000",
  timeoutMs = "600000",
} = {}) => ({
  ...genericOpenCodeManualProfile({
    id,
    name,
    remarkName: name,
    provider: "DeepSeek",
    model: qualifiedOpenCodeModel(model, "DeepSeek"),
    reasoningEffort,
    timeoutMs,
    credentialSource: "shensi",
    apiKey,
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "chat_completions",
  }),
  temperature,
  maxOutputTokens,
});

const openCodeRemarkFamily = (model = "") => {
  const modelId = String(model || "").trim().toLowerCase();
  const separator = modelId.indexOf("/");
  if (separator <= 0) return "";
  const namespace = modelId.slice(0, separator);
  if (namespace !== "opencode") return namespace;
  const slug = modelId.slice(separator + 1);
  const versionBoundary = slug.search(/-v?\d(?:[.-]|$)/u);
  if (versionBoundary > 0) return slug.slice(0, versionBoundary);
  return "";
};

const OPEN_CODE_PROVIDER_LABELS = Object.freeze({
  openai: "OpenAI",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  moonshot: "Moonshot",
  alibaba: "Alibaba",
  zhipu: "Zhipu",
  minimax: "MiniMax",
  mistral: "Mistral",
  meta: "Meta",
});

const OPEN_CODE_PROVIDER_NAMESPACES = Object.freeze({
  openai: "openai",
  deepseek: "deepseek",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  moonshot: "moonshot",
  alibaba: "alibaba",
  zhipu: "zhipu",
  minimax: "minimax",
  mistral: "mistral",
  meta: "meta",
});

export const openCodeProviderNamespace = (provider = "") => {
  const key = String(provider || "").trim().toLowerCase().replace(/[\s_-]+/gu, "");
  return OPEN_CODE_PROVIDER_NAMESPACES[key] || key.replace(/[^a-z0-9.-]/gu, "");
};

export const qualifiedOpenCodeModel = (model = "", provider = "") => {
  const modelId = String(model || "").trim();
  if (!modelId || modelId.includes("/")) return modelId;
  const namespace = openCodeProviderNamespace(provider);
  return namespace ? `${namespace}/${modelId}` : modelId;
};

export const openCodeProviderForModel = (model = "") => {
  const modelId = String(model || "").trim().toLowerCase();
  const separator = modelId.indexOf("/");
  if (separator <= 0) return "";
  const namespace = modelId.slice(0, separator);
  const family = namespace === "opencode" ? openCodeRemarkFamily(modelId) : namespace;
  return OPEN_CODE_PROVIDER_LABELS[family] || "";
};

export const genericOpenCodeManualProfile = ({
  id = "",
  name = "opencode",
  provider = "",
  model = "",
  remarkName = "",
  reasoningEffort = "",
  timeoutMs = "600000",
  credentialSource = "opencode",
  apiKey = "",
  baseUrl = "",
  protocol = "",
} = {}) => {
  const source = credentialSource === "shensi" ? "shensi" : "opencode";
  const modelId = qualifiedOpenCodeModel(model, provider);
  const modelFamily = openCodeRemarkFamily(modelId);
  const selectedProvider = String(provider || openCodeProviderForModel(modelId)).trim();
  const compositeName = selectedProvider ? `OpenCode+${selectedProvider}` : "OpenCode";
  const profile = createGenerationProfile("text", {
  id,
  name: name && name !== "opencode" ? name : compositeName,
  adapter: "cli",
  provider: selectedProvider,
  protocol: source === "shensi" ? String(protocol || "chat_completions").trim() : "",
  baseUrl: source === "shensi" ? String(baseUrl || "").trim() : "",
  model: modelId,
  agentModelId: modelId,
  remarkName: String(remarkName || compositeName || `OpenCode${modelFamily ? `+${modelFamily}` : ""}`).trim(),
  reasoningEffort,
  speedMode: "default",
  timeoutMs: String(Math.max(Number(timeoutMs) || 0, 600_000)),
  apiKey: source === "shensi" ? String(apiKey || "") : "",
  cliPath: "opencode",
  cliArgs: "",
  executionMode: "agent",
  executionModes: ["agent"],
  agentEngine: "opencode",
  credentialSource: source,
  chatModelId: "",
  });
  return {
    ...profile,
    model: modelId,
    agentModelId: modelId,
    provider: selectedProvider,
    credentialSource: source,
    chatModelId: "",
  };
};

// Present the former DeepSeek-specific OpenCode profile through the same
// provider/credential/runner/model contract as every new OpenCode profile.
// This helper is intentionally pure: opening Settings never rewrites a saved
// profile. Callers may persist the returned profile only after a real test.
export const unifiedOpenCodeProfile = (profile = {}) => {
  const legacy = String(profile.agentEngine || "").trim() === "deepseek_opencode";
  if (!legacy) return {
    ...profile,
    credentialSource: profile.credentialSource === "shensi" ? "shensi" : "opencode",
    model: qualifiedOpenCodeModel(profile.model || profile.agentModelId, profile.provider),
    agentModelId: qualifiedOpenCodeModel(profile.agentModelId || profile.model, profile.provider),
  };
  const provider = String(profile.provider || "DeepSeek").trim() || "DeepSeek";
  const model = qualifiedOpenCodeModel(profile.agentModelId || profile.model, provider);
  return {
    ...profile,
    name: `OpenCode+${provider}`,
    remarkName: `OpenCode+${provider}`,
    adapter: "cli",
    provider,
    protocol: String(profile.protocol || "chat_completions").trim(),
    baseUrl: String(profile.baseUrl || "https://api.deepseek.com/v1").trim(),
    model,
    agentModelId: model,
    cliPath: "opencode",
    cliArgs: "",
    executionMode: "agent",
    executionModes: ["agent"],
    agentEngine: "opencode",
    credentialSource: "shensi",
    chatModelId: "",
  };
};

export const validateGenericOpenCodeConnection = ({ profile = {}, capability = {} } = {}) => {
  if (profile.adapter !== "cli") return { ok: false, stage: "adapter", message: "OpenCode Agent 必须使用 CLI" };
  if (profile.agentEngine !== "opencode") return { ok: false, stage: "engine", message: "Agent 运行器必须选择 OpenCode" };
  if (capability.available !== true) return { ok: false, stage: "command", message: capability.message || "尚未检测到可用的 OpenCode CLI" };
  const model = String(profile.agentModelId || profile.model || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/.test(model)) {
    return { ok: false, stage: "model", message: "请从 OpenCode 当前模型目录选择完整 provider/model ID" };
  }
  const credentialSource = profile.credentialSource === "shensi" ? "shensi" : "opencode";
  if (credentialSource === "shensi") {
    if (!String(profile.provider || "").trim()) return { ok: false, stage: "provider", message: "请选择模型服务商" };
    if (!String(profile.apiKey || "").trim()) return { ok: false, stage: "credential", message: `${profile.provider} 凭据不可用` };
    if (!/^https?:\/\//iu.test(String(profile.baseUrl || "").trim())) return { ok: false, stage: "endpoint", message: "模型服务地址必须是有效的 HTTP(S) 地址" };
    const namespace = openCodeProviderNamespace(profile.provider);
    if (namespace && !model.toLowerCase().startsWith(`${namespace}/`)) {
      return { ok: false, stage: "model", message: `模型 ID 必须使用 ${namespace}/model 格式` };
    }
  }
  const reportedModels = (Array.isArray(capability.models) ? capability.models : [])
    .map((item) => String(item?.slug || item?.id || "").trim())
    .filter(Boolean);
  if (capability.modelsVerified === true && reportedModels.length && !reportedModels.includes(model)) {
    return { ok: false, stage: "catalog", message: `OpenCode 当前没有报告模型 ${model}` };
  }
  return { ok: true, stage: "ready", message: `${profile.provider || "OpenCode"} → OpenCode → ${model} → Agent` };
};

export const validateDeepSeekOpenCodeConnection = ({ profile = {}, capability = {} } = {}) => {
  if (profile.provider !== "DeepSeek") return { ok: false, stage: "provider", message: "模型厂商必须选择 DeepSeek" };
  if (profile.adapter !== "cli") return { ok: false, stage: "adapter", message: "连接方式必须选择 CLI" };
  if (!String(profile.apiKey || "").trim()) return { ok: false, stage: "credential", message: "DeepSeek 凭据不可用；请先完成 DeepSeek API 真实连接测试" };
  if (profile.cliPath !== DEEPSEEK_OPENCODE_CLI_ALIAS) return { ok: false, stage: "command", message: `CLI 路径应为 ${DEEPSEEK_OPENCODE_CLI_ALIAS}` };
  if (profile.cliArgs !== DEEPSEEK_OPENCODE_CLI_ARGS) return { ok: false, stage: "arguments", message: `CLI 参数应为 ${DEEPSEEK_OPENCODE_CLI_ARGS}` };
  if (capability.available !== true) return { ok: false, stage: "command", message: "尚未检测到可用的 OpenCode CLI" };
  if (capability.modelsVerified === false) return { ok: false, stage: "model", message: `OpenCode 模型目录核验失败${capability.modelProbeError ? `：${capability.modelProbeError}` : ""}` };
  const models = (Array.isArray(capability.models) ? capability.models : []).map((item) => String(item?.slug || "").trim()).filter(Boolean);
  if (!String(profile.model || "").trim()) return { ok: false, stage: "model", message: "请先从 OpenCode 能力探测结果中选择模型" };
  if (models.length && !models.includes(profile.model)) return { ok: false, stage: "model", message: `OpenCode 当前没有报告模型 ${profile.model}` };
  return { ok: true, stage: "ready", message: "DeepSeek / OpenCode CLI 配置字段完整" };
};

// Settings editing uses normalized drafts, while untouched saved profiles
// retain unknown extension fields and their exact persisted representation.
export const mergeGenerationProfileDraftsById = (original = {}, draft = {}) => {
  const next = { ...original, ...draft };
  const baseline = normalizeGenerationProfiles(original);
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    const originalProfiles = Array.isArray(original[keys.list]) ? original[keys.list] : [];
    const originalById = new Map(originalProfiles.map((profile) => [String(profile?.id || ""), profile]));
    const baselineById = new Map((baseline[keys.list] || []).map((profile) => [String(profile?.id || ""), profile]));
    const draftProfiles = Array.isArray(draft[keys.list]) ? draft[keys.list] : originalProfiles;
    next[keys.list] = draftProfiles.map((profile) => {
      const saved = originalById.get(String(profile?.id || ""));
      const normalizedBaseline = baselineById.get(String(profile?.id || ""));
      const legacyDeepSeekOpenCode = channel === "text"
        && String(saved?.agentEngine || "").trim() === "deepseek_opencode";
      if (legacyDeepSeekOpenCode) {
        return String(profile?.agentEngine || "").trim() === "deepseek_opencode"
          ? normalizeOpenCodeProfileLabel(unifiedOpenCodeProfile(profile))
          : profile;
      }
      return saved
        && normalizedBaseline
        && JSON.stringify(normalizedBaseline) === JSON.stringify(profile)
        ? withoutNonDreaminaIdentity(saved)
        : withoutNonDreaminaIdentity(profile);
    });
  }
  return next;
};

export const upsertGenerationProfile = (settings = {}, channel, profile, { activate = false } = {}) => {
  const keys = PROFILE_KEYS[channel];
  if (!keys) return settings;
  const next = normalizeGenerationProfiles(settings);
  const normalized = normalizedProfile(channel, profile, 0);
  const index = next[keys.list].findIndex((item) => item.id === normalized.id);
  if (index >= 0) next[keys.list][index] = normalized;
  else next[keys.list].push(normalized);
  if (activate || !next[keys.active]) {
    next[keys.active] = normalized.id;
    if (channel === "text") {
      next.activeTextConnectionId = normalized.id;
      next.activeTextChatConnectionId = normalized.id;
      next.activeTextAgentConnectionId = normalized.id;
    }
  }
  return syncLegacyGenerationSettings(next, channel);
};

export const addDeepSeekOpenCodeProfile = (settings = {}, capability = {}) => {
  const profiles = Array.isArray(settings.textConnections) ? settings.textConnections : [];
  const existing = profiles.find((profile) => profile.provider === "DeepSeek"
    && profile.adapter === "cli"
    && (["opencode", "deepseek_opencode"].includes(String(profile.agentEngine || "").trim())
      || ["opencode", DEEPSEEK_OPENCODE_CLI_ALIAS].includes(String(profile.cliPath || "").trim())));
  // A modern generic OpenCode profile already represents the same DeepSeek
  // runtime. Reuse its stable ID and saved credential instead of creating a
  // second legacy-shaped profile whose picker label would need an ID suffix.
  if (existing?.agentEngine === "opencode") {
    return activateGenerationProfile(settings, "text", existing.id);
  }
  const apiProfile = profiles.find((profile) => profile.provider === "DeepSeek" && profile.adapter === "api" && profile.apiKey)
    ?? profiles.find((profile) => profile.provider === "DeepSeek" && profile.apiKey);
  if (!apiProfile?.apiKey) throw new Error("DeepSeek API Key 当前不可用；请重新输入并点击“真实连接测试”，成功后会用系统凭证安全加密保存");
  const availableModels = Array.isArray(capability.models) ? capability.models : [];
  const selectedModel = availableModels.find((model) => model.slug === (existing?.model || apiProfile.model))
    ?? availableModels.find((model) => model.slug === capability.defaultModel)
    ?? availableModels[0];
  const profile = deepSeekOpenCodeManualProfile({
    ...(existing ?? {}),
    id: existing?.id,
    name: "DeepSeek CLI · OpenCode",
    model: selectedModel?.slug || capability.defaultModel || "deepseek-v4-pro",
    reasoningEffort: existing?.reasoningEffort || apiProfile.reasoningEffort || selectedModel?.defaultReasoningLevel || "high",
    temperature: existing?.temperature || apiProfile.temperature || "0.7",
    maxOutputTokens: existing?.maxOutputTokens || apiProfile.maxOutputTokens || "4000",
    timeoutMs: String(Math.max(Number(existing?.timeoutMs || apiProfile.timeoutMs) || 0, 600_000)),
    apiKey: existing?.apiKey || apiProfile.apiKey,
  });
  return upsertGenerationProfile(settings, "text", profile, { activate: true });
};

export const removeGenerationProfile = (settings = {}, channel, profileId) => {
  const keys = PROFILE_KEYS[channel];
  if (!keys) return settings;
  const next = normalizeGenerationProfiles(settings);
  if (next[keys.list].length <= 1) return next;
  const removedProfile = next[keys.list].find((profile) => profile.id === profileId);
  if (channel === "text" && (removedProfile?.systemManaged === true || removedProfile?.id === BUILT_IN_PUBLIC_TEXT_PROFILE.id)) {
    return next;
  }
  next[keys.list] = next[keys.list].filter((profile) => profile.id !== profileId);
  if (channel === "text" && removedProfile?.adapter === "cli" && removedProfile?.agentEngine === "codex") {
    next.disabledBuiltInTextProfileIds = [...new Set([
      ...(Array.isArray(next.disabledBuiltInTextProfileIds) ? next.disabledBuiltInTextProfileIds : []),
      BUILT_IN_GPT_CHAT_CLI.id,
      removedProfile.id,
    ])];
  }
  if (!next[keys.list].some((profile) => profile.id === next[keys.active])) next[keys.active] = next[keys.list][0].id;
  return syncLegacyGenerationSettings(next, channel);
};

export const activateGenerationProfile = (settings = {}, channel, profileId) => {
  const keys = PROFILE_KEYS[channel];
  if (!keys) return settings;
  const next = normalizeGenerationProfiles(settings);
  if (next[keys.list].some((profile) => profile.id === profileId)) {
    next[keys.active] = profileId;
    if (channel === "text") {
      next.activeTextConnectionId = profileId;
      next.activeTextChatConnectionId = profileId;
      next.activeTextAgentConnectionId = profileId;
    }
  }
  return syncLegacyGenerationSettings(next, channel);
};

export const activateTextExecutionModeProfile = (settings = {}, mode = "chat") => {
  const profileId = String(settings.activeTextAgentConnectionId || settings.activeTextConnectionId || settings.activeTextChatConnectionId || "");
  if (!profileId || !Array.isArray(settings.textConnections)
    || !settings.textConnections.some((profile) => String(profile?.id || "") === profileId)) return settings;
  return activateGenerationProfile(settings, "text", profileId);
};

export const syncLegacyGenerationSettings = (settings = {}, channel) => {
  const next = { ...settings };
  const profile = activeGenerationProfile(next, channel);
  if (!profile) return next;
  if (channel === "text") {
    for (const key of ["adapter", "provider", "protocol", "baseUrl", "model", "reasoningEffort", "speedMode", "temperature", "maxOutputTokens", "timeoutMs", "apiKey", "cliPath", "cliArgs"]) {
      next[key] = profile[key] ?? "";
    }
    return next;
  }
  const prefix = channel;
  for (const key of ["Adapter", "Provider", "Protocol", "BaseUrl", "Model", "TimeoutMs", "ApiKey", "CliPath", "CliArgs"]) {
    const profileKey = key.charAt(0).toLowerCase() + key.slice(1);
    next[`${prefix}${key}`] = profile[profileKey] ?? "";
  }
  return next;
};

export const syncAllLegacyGenerationSettings = (settings = {}) => CHANNELS.reduce(
  (next, channel) => syncLegacyGenerationSettings(next, channel),
  settings,
);

export const generationSettingsForChannel = (settings = {}, channel, profileId = "", overrides = {}) => {
  const profile = activeGenerationProfile(settings, channel, profileId);
  return profile ? { ...profile, ...overrides, workspacePath: settings.workspacePath || "" } : null;
};

export const generationSecrets = (settings = {}) => Object.fromEntries(CHANNELS.map((channel) => {
  const keys = PROFILE_KEYS[channel];
  return [channel, Object.fromEntries((settings[keys.list] ?? [])
    .filter((profile) => profile.apiKey && !(profile.credentialSharedFromChannel && profile.credentialSharedFromProfileId))
    .map((profile) => [profile.id, profile.apiKey]))];
}));

const comparableCredentialEndpoint = (value) => String(value || "")
  .trim()
  .replace(/\/+$/u, "")
  .replace(/\/(?:v1|anthropic)$/iu, "")
  .toLocaleLowerCase();

export const reusableTextProviderCredential = ({ settings = {}, secrets = {}, target = {} } = {}) => {
  const provider = String(target.provider || "").trim().toLocaleLowerCase();
  if (!provider) return "";
  const targetId = String(target.id || target.connectionId || "").trim();
  const records = secrets?.text && typeof secrets.text === "object" ? secrets.text : {};
  const exact = String(target.apiKey || records[targetId] || "").trim();
  if (exact) return exact;
  // Legacy DeepSeek+OpenCode profiles predate `credentialSource` and stored an
  // empty Base URL. They still target DeepSeek's official endpoint; treating
  // that endpoint as a wildcard could copy a key from an unrelated proxy.
  const legacyDeepSeekOpenCode = provider === "deepseek"
    && String(target.agentEngine || "").trim() === "deepseek_opencode";
  const targetEndpoint = comparableCredentialEndpoint(
    target.baseUrl || (legacyDeepSeekOpenCode ? "https://api.deepseek.com/v1" : ""),
  );
  const profiles = Array.isArray(settings.textConnections) ? settings.textConnections : [];
  for (const profile of profiles) {
    if (String(profile?.provider || "").trim().toLocaleLowerCase() !== provider) continue;
    const donorEndpoint = comparableCredentialEndpoint(profile?.baseUrl);
    if (targetEndpoint && donorEndpoint && targetEndpoint !== donorEndpoint) continue;
    const secret = String(profile?.apiKey || records[String(profile?.id || "").trim()] || "").trim();
    if (secret) return secret;
  }
  return "";
};

export const mergeGenerationSecrets = (...sources) => {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [channel, records] of Object.entries(source)) {
      if (!records || typeof records !== "object" || Array.isArray(records)) continue;
      merged[channel] = { ...(merged[channel] ?? {}) };
      for (const [connectionId, secret] of Object.entries(records)) {
        if (connectionId && typeof secret === "string" && secret) merged[channel][connectionId] = secret;
      }
    }
  }
  return merged;
};

export const withoutGenerationSecrets = (settings = {}) => {
  const next = { ...settings, apiKey: "", imageApiKey: "", videoApiKey: "", audioApiKey: "" };
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    next[keys.list] = (settings[keys.list] ?? []).map((profile) => ({ ...profile, apiKey: "" }));
  }
  return next;
};

export const withoutGenerationRuntime = (settings = {}) => {
  const next = { ...settings };
  for (const key of LEGACY_GENERATION_RUNTIME_FIELDS) delete next[key];
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    next[keys.list] = (settings[keys.list] ?? []).map((profile) => {
      const portable = { ...profile };
      for (const field of GENERATION_RUNTIME_FIELDS) delete portable[field];
      return portable;
    });
  }
  return next;
};

export const portableGenerationSettings = (settings = {}) => {
  const next = withoutGenerationRuntime(withoutGenerationSecrets(settings));
  for (const key of ["apiKey", "imageApiKey", "videoApiKey", "audioApiKey"]) delete next[key];
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    next[keys.list] = (next[keys.list] ?? []).map((profile) => {
      const portable = { ...profile };
      delete portable.apiKey;
      return portable;
    });
  }
  return next;
};

export const generationRuntimeBindings = (settings = {}) => ({
  schemaVersion: 1,
  bindings: CHANNELS.flatMap((channel) => {
    const keys = PROFILE_KEYS[channel];
    return (settings[keys.list] ?? []).filter((profile) => {
      if (profile.reserved === true) return false;
      if (profile.adapter === "cli") {
        if (profile.provider === "即梦" && !String(profile.dreaminaCliProfile || "").trim()) return false;
        return Boolean(String(profile.cliPath || "").trim());
      }
      if (profile.adapter === "api" && getProviderPreset(profile.provider).custom) return Boolean(String(profile.baseUrl || "").trim());
      return profile.adapter === "api";
    }).map((profile) => ({
      channel,
      profileId: String(profile.id || ""),
      adapter: String(profile.adapter || ""),
      provider: String(profile.provider || ""),
      protocol: String(profile.protocol || ""),
      baseUrl: String(profile.baseUrl || ""),
      cliPath: String(profile.cliPath || ""),
      cliArgs: String(profile.cliArgs || ""),
      dreaminaCliProfile: String(profile.dreaminaCliProfile || ""),
      chatAdapter: ["opencode", "claude_code"].includes(profile.agentEngine)
        && profile.credentialSource === "shensi"
        && (profile.executionModes || []).includes("chat") ? "api" : "",
      chatProtocol: ["opencode", "claude_code"].includes(profile.agentEngine) && profile.credentialSource === "shensi"
        ? String(profile.protocol || "chat_completions") : "",
      chatBaseUrl: ["opencode", "claude_code"].includes(profile.agentEngine) && profile.credentialSource === "shensi"
        ? String(profile.baseUrl || "") : "",
    })).filter((binding) => binding.profileId);
  }),
});

const comparableEndpoint = (value) => String(value || "").trim().replace(/\/+$/, "").toLocaleLowerCase();

const profileFromRuntimeBinding = (channel, binding = {}, apiKey = "") => {
  const provider = String(binding.provider || "").trim();
  const preset = getProviderPreset(provider);
  const model = channel === "text"
    ? preset.api?.model || DEFAULTS.text.model
    : DEFAULTS[channel]?.model || "";
  const modelOption = channel === "text"
    ? getProviderModelOptions(provider).find((item) => item.slug === model)
    : null;
  return createGenerationProfile(channel, {
    id: String(binding.profileId || binding.id || "").trim(),
    name: `${provider} ${binding.adapter === "cli" ? "CLI" : "API"}`,
    adapter: String(binding.adapter || ""),
    provider,
    protocol: String(binding.protocol || preset.api?.protocol || DEFAULTS[channel]?.protocol || ""),
    baseUrl: String(binding.baseUrl || ""),
    model,
    reasoningEffort: modelOption?.defaultReasoningLevel || DEFAULTS.text.reasoningEffort,
    apiKey,
    cliPath: String(binding.cliPath || ""),
    cliArgs: String(binding.cliArgs || ""),
    dreaminaCliProfile: String(binding.dreaminaCliProfile || ""),
  });
};

export const applyGenerationRuntimeBindings = (settings = {}, payload = {}, secrets = {}) => {
  const source = Array.isArray(payload) ? payload : payload.bindings;
  if (!Array.isArray(source) || !source.length) return settings;
  const bindings = new Map(source.map((binding) => [`${binding.channel}:${binding.profileId}`, binding]));
  const next = normalizeGenerationProfiles(settings, secrets);
  const disabledBuiltInTextProfileIds = new Set(Array.isArray(next.disabledBuiltInTextProfileIds)
    ? next.disabledBuiltInTextProfileIds.map((profileId) => String(profileId || "").trim()).filter(Boolean)
    : []);
  for (const channel of CHANNELS) {
    const keys = PROFILE_KEYS[channel];
    const channelProfiles = next[keys.list] ?? [];
    const hasCodexProfile = channel === "text" && channelProfiles.some(isCodexTextCliProfile);
    const profiles = channelProfiles.map((profile) => {
      const binding = bindings.get(`${channel}:${profile.id}`)
        || (hasCodexProfile && isCodexTextCliProfile(profile)
          ? source.find(isCodexTextCliBinding)
          : null);
      if (!binding) return profile;
      return {
        ...profile,
        adapter: String(binding.adapter || ""),
        provider: String(binding.provider || ""),
        protocol: String(binding.protocol || ""),
        baseUrl: String(binding.baseUrl || ""),
        cliPath: String(binding.cliPath || ""),
        cliArgs: String(binding.cliArgs || ""),
        dreaminaCliProfile: String(binding.dreaminaCliProfile || ""),
      };
    });
    const existingIds = new Set(profiles.map((profile) => profile.id));
    const recovered = source
      .filter((binding) => binding?.channel === channel
        && String(binding.profileId || "").trim()
        && !(channel === "text" && disabledBuiltInTextProfileIds.has(String(binding.profileId).trim()))
        && !(hasCodexProfile && isCodexTextCliBinding(binding))
        && !existingIds.has(String(binding.profileId).trim())
        && ["api", "cli"].includes(String(binding.adapter || ""))
        && String(binding.provider || "").trim())
      .map((binding) => {
        const endpoint = comparableEndpoint(binding.baseUrl);
        const legacySecretDonor = channel === "text" && binding.adapter === "api" && endpoint
          ? profiles.find((profile) => profile.apiKey
            && profile.provider !== binding.provider
            && comparableEndpoint(profile.baseUrl) === endpoint)
          : null;
        return profileFromRuntimeBinding(channel, binding, legacySecretDonor?.apiKey || "");
      });
    next[keys.list] = [...profiles, ...recovered];
  }
  return normalizeGenerationProfiles(next, secrets);
};

export const generationProfileKeys = (channel) => PROFILE_KEYS[channel] ?? null;

export const reorderGenerationProfiles = (settings = {}, channel, orderedIds = []) => {
  const keys = PROFILE_KEYS[channel];
  if (!keys) return settings;
  const profiles = Array.isArray(settings[keys.list]) ? settings[keys.list] : [];
  const positions = new Map(orderedIds.map((id, index) => [String(id), index]));
  const originalPositions = new Map(profiles.map((profile, index) => [String(profile.id), index]));
  const reordered = [...profiles].sort((left, right) => {
    const leftPosition = positions.has(String(left.id)) ? positions.get(String(left.id)) : orderedIds.length + originalPositions.get(String(left.id));
    const rightPosition = positions.has(String(right.id)) ? positions.get(String(right.id)) : orderedIds.length + originalPositions.get(String(right.id));
    return leftPosition - rightPosition;
  });
  return { ...settings, [keys.list]: reordered };
};
