import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  DREAMINA_IMAGE_CLI_ALIAS,
  DREAMINA_IMAGE_CLI_ARGS,
  DREAMINA_VIDEO_CLI_ALIAS,
  DREAMINA_VIDEO_CLI_ARGS,
  normalizeDreaminaCliProfileId,
  validDreaminaCliProfileId,
  OPENAI_IMAGE_CLI_ALIAS,
  OPENAI_IMAGE_CLI_ARGS,
  LIBTV_CLI_ALIAS,
  LIBTV_CLI_ARGS,
} from "../media-cli-presets.js";
import { DEEPSEEK_OPENCODE_CLI_ALIAS, DEEPSEEK_OPENCODE_CLI_ARGS, getProviderPreset } from "../model-presets.js";
import { resolveLocalCodexLaunch } from "../cli/codex-launch.mjs";
import { agentEngineDescriptor } from "../agent-engine-registry.js";
import { machineLocalDataRoot } from "./app-data.mjs";
import { dreaminaExpectedIdentitySync } from "./dreamina-profile-identity-store.mjs";

const CHANNELS = new Set(["text", "image", "video", "audio"]);
const ADAPTERS = new Set(["api", "cli"]);
const EXTERNAL_CLI_AGENT_ENGINES = new Set(["workbuddy", "custom"]);
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{1,119}$/i;
const PROFILE_RUNTIME_IDENTITY_FIELDS = Object.freeze([
  "adapter", "provider", "protocol", "baseUrl", "model", "apiKey", "cliPath", "cliArgs",
  "agentEngine", "agentModelId", "chatModelId", "credentialSource", "dreaminaCliProfile",
]);
const STORE_SCHEMA_VERSION = 1;
let writeQueue = Promise.resolve();
// API credentials are intentionally kept only in this core-process memory.
// They are supplied by the desktop renderer after DPAPI hydration and are
// never written to the runtime binding file or returned by the bindings API.
const transientGenerationCredentials = new Map();
// Keep endpoint metadata beside the process-only secret map so a custom API
// credential saved on the text channel can be safely reused by its image or
// video capability. Metadata never leaves core-process memory and secrets are
// still excluded from runtime binding files and persisted generation jobs.
const transientGenerationCredentialRecords = new Map();

const storePath = () => join(machineLocalDataRoot(), "config", "generation-runtime-v1.json");
const bindingKey = ({ channel, profileId }) => `${channel}:${profileId}`;
const text = (value, maximum = 8_192) => String(value ?? "").trim().slice(0, maximum);
const quoteCliTemplateArg = (value) => `"${String(value).replaceAll('"', '\\"')}"`;

const isDreaminaCli = (value = {}) => value.adapter === "cli" && value.provider === "即梦";

const withoutDreaminaIdentity = (value = {}) => {
  const next = { ...value };
  if (!isDreaminaCli(next)) {
    delete next.dreaminaCliProfile;
    delete next.dreaminaExpectedIdentity;
  }
  return next;
};

const transientCredentialKey = (channel, profileId) => `${String(channel || "").trim()}:${String(profileId || "").trim()}`;

const comparableCredentialEndpoint = (value) => String(value || "")
  .trim()
  .replace(/\/+$/u, "")
  .toLocaleLowerCase();

const comparableCliPath = (value) => {
  const normalized = text(value, 2_048).replaceAll("/", "\\");
  return /^[a-z]:\\/iu.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
};

const assertCandidateMatchesStoredBinding = ({ candidate = {}, explicitFields = new Set(), binding, chatProjection = false }) => {
  const mismatch = (label) => {
    throw runtimeError(`当前配置的${label}已变化，请在设置中重新确认后再生成`, "LOCAL_RUNTIME_BINDING_REQUIRED", 409);
  };
  if (explicitFields.has("baseUrl")
    && comparableCredentialEndpoint(candidate.baseUrl) !== comparableCredentialEndpoint(binding.baseUrl)) mismatch("服务地址");
  if (explicitFields.has("cliPath")
    && comparableCliPath(candidate.cliPath) !== comparableCliPath(binding.cliPath)) mismatch("CLI 程序");
  if (explicitFields.has("cliArgs")
    && text(candidate.cliArgs, 16_384) !== text(binding.cliArgs, 16_384)) mismatch("CLI 参数");
  if (isDreaminaCli(candidate)
    && isDreaminaCli(binding)
    && explicitFields.has("dreaminaCliProfile")
    && (!validDreaminaCliProfileId(candidate.dreaminaCliProfile)
      || !validDreaminaCliProfileId(binding.dreaminaCliProfile)
      || normalizeDreaminaCliProfileId(candidate.dreaminaCliProfile) !== normalizeDreaminaCliProfileId(binding.dreaminaCliProfile))) mismatch("即梦账号");
  if (!chatProjection) return;
  if (binding.chatAdapter !== "api") mismatch("Chat 运行方式");
  if (explicitFields.has("protocol")
    && text(candidate.protocol, 80) !== text(binding.chatProtocol, 80)) mismatch("Chat 协议");
  if (explicitFields.has("baseUrl")
    && comparableCredentialEndpoint(candidate.baseUrl) !== comparableCredentialEndpoint(binding.chatBaseUrl)) mismatch("Chat 服务地址");
};

const credentialRecordKey = (channel, profileId) => transientCredentialKey(channel, profileId);

export const rememberGenerationRuntimeCredentials = ({ credentials = {}, bindings = [] } = {}) => {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return 0;
  let remembered = 0;
  const bindingByKey = new Map((Array.isArray(bindings) ? bindings : [])
    .filter((binding) => binding && typeof binding === "object")
    .map((binding) => [credentialRecordKey(binding.channel, binding.profileId), binding]));
  for (const [channel, records] of Object.entries(credentials).slice(0, CHANNELS.size)) {
    if (!CHANNELS.has(channel) || !records || typeof records !== "object" || Array.isArray(records)) continue;
    for (const [profileId, value] of Object.entries(records).slice(0, 256)) {
      const id = text(profileId, 120);
      const secret = text(value, 16_384);
      if (!PROFILE_ID.test(id)) continue;
      const key = transientCredentialKey(channel, id);
      if (secret) {
        transientGenerationCredentials.set(key, secret);
        const binding = bindingByKey.get(key);
        if (binding) transientGenerationCredentialRecords.set(key, {
          channel,
          profileId: id,
          provider: text(binding.provider, 120).toLocaleLowerCase(),
          baseUrl: comparableCredentialEndpoint(binding.baseUrl),
          secret,
        });
        remembered += 1;
      } else {
        transientGenerationCredentials.delete(key);
        transientGenerationCredentialRecords.delete(key);
      }
    }
  }
  // Materialize unambiguous same-endpoint aliases in process memory. This is
  // what lets a text-only credential unlock the matching image/video profile
  // without duplicating the secret in durable settings or job records.
  const bindingList = Array.isArray(bindings) ? bindings : [];
  const groups = new Map();
  for (const binding of bindingList) {
    if (!binding || binding.adapter !== "api") continue;
    const provider = text(binding.provider, 120).toLocaleLowerCase();
    const endpoint = comparableCredentialEndpoint(binding.baseUrl);
    if (!provider || !endpoint || getProviderPreset(binding.provider)?.custom !== true) continue;
    const groupKey = `${provider}\0${endpoint}`;
    const sourceKey = credentialRecordKey(binding.channel, binding.profileId);
    const sourceSecret = transientGenerationCredentials.get(sourceKey) || "";
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ binding, sourceSecret });
  }
  for (const records of groups.values()) {
    const unique = [...new Set(records.map((record) => record.sourceSecret).filter(Boolean))];
    if (unique.length !== 1) continue;
    const secret = unique[0];
    for (const { binding } of records) {
      const channel = text(binding.channel, 16);
      const profileId = text(binding.profileId, 120);
      if (!CHANNELS.has(channel) || !PROFILE_ID.test(profileId)) continue;
      const key = credentialRecordKey(channel, profileId);
      transientGenerationCredentials.set(key, secret);
      transientGenerationCredentialRecords.set(key, {
        channel,
        profileId,
        provider: text(binding.provider, 120).toLocaleLowerCase(),
        baseUrl: comparableCredentialEndpoint(binding.baseUrl),
        secret,
      });
    }
  }
  return remembered;
};

// Internal handoff for a short-lived media worker child process. This is not
// exposed by the bindings API and is never persisted; callers must pass the
// returned snapshot directly to the worker manager.
export const generationRuntimeCredentialsSnapshot = ({
  channels = [...CHANNELS],
  maxEntries = 128,
  maxBytes = 12_000,
} = {}) => {
  const snapshot = {};
  let remaining = Math.max(1, Math.min(512, Number(maxEntries) || 128));
  let usedBytes = 2;
  const allowedChannels = new Set((Array.isArray(channels) ? channels : [...CHANNELS]).filter((channel) => CHANNELS.has(channel)));
  for (const channel of allowedChannels) {
    if (remaining <= 0) break;
    const records = {};
    for (const [key, value] of transientGenerationCredentials) {
      const separator = key.indexOf(":");
      if (separator < 0 || key.slice(0, separator) !== channel || remaining <= 0) continue;
      const profileId = key.slice(separator + 1);
      const secret = text(value, 16_384);
      if (!PROFILE_ID.test(profileId) || !secret) continue;
      const entryBytes = Buffer.byteLength(JSON.stringify([channel, profileId, secret]), "utf8");
      if (usedBytes + entryBytes > Math.max(2_048, Number(maxBytes) || 12_000)) continue;
      records[profileId] = secret;
      usedBytes += entryBytes;
      remaining -= 1;
    }
    if (Object.keys(records).length) snapshot[channel] = records;
  }
  return snapshot;
};

const transientGenerationCredential = (channel, profileId) => transientGenerationCredentials.get(
  transientCredentialKey(channel, profileId),
) || "";

const transientGenerationCredentialForSettings = (channel, profileId, settings = {}) => {
  const exact = transientGenerationCredential(channel, profileId);
  if (exact) return exact;
  const provider = text(settings.provider, 120).toLocaleLowerCase();
  const endpoint = comparableCredentialEndpoint(settings.baseUrl);
  if (!provider || !endpoint || getProviderPreset(provider)?.custom !== true) return "";
  const matches = [...transientGenerationCredentialRecords.values()]
    .filter((record) => record.provider === provider && record.baseUrl === endpoint && record.secret);
  const unique = [...new Set(matches.map((record) => record.secret))];
  return unique.length === 1 ? unique[0] : "";
};

const runtimeError = (message, code = "LOCAL_RUNTIME_BINDING_INVALID", statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const validateBaseUrl = (value) => {
  const baseUrl = text(value, 2_048);
  if (!baseUrl) return "";
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw runtimeError("模型服务地址不是有效 URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw runtimeError("模型服务地址只允许 HTTP 或 HTTPS");
  if (parsed.username || parsed.password) throw runtimeError("模型服务地址不得内嵌凭据");
  return parsed.toString().replace(/\/$/, "");
};

const normalizeBinding = (value = {}) => {
  const channel = text(value.channel, 16);
  const profileId = text(value.profileId || value.id, 120);
  const adapter = text(value.adapter, 16);
  const provider = text(value.provider, 120);
  const agentEngine = text(value.agentEngine, 64);
  const externalCliAgent = channel === "text" && EXTERNAL_CLI_AGENT_ENGINES.has(agentEngine);
  const protocol = text(value.protocol, 80);
  if (!CHANNELS.has(channel)) throw runtimeError("本机运行时绑定的通道无效");
  if (!PROFILE_ID.test(profileId)) throw runtimeError("本机运行时绑定的配置编号无效");
  if (!ADAPTERS.has(adapter)) throw runtimeError("本机运行时绑定的调用方式无效");
  if (!provider && !externalCliAgent) throw runtimeError("本机运行时绑定缺少服务商");
  const baseUrl = validateBaseUrl(value.baseUrl);
  const cliPath = text(value.cliPath, 2_048);
  const cliArgs = text(value.cliArgs, 16_384);
  const chatAdapter = value.chatAdapter === "api" ? "api" : "";
  const chatProtocol = text(value.chatProtocol, 80);
  const chatBaseUrl = validateBaseUrl(value.chatBaseUrl);
  const inferredDreaminaCliProfile = /(?:^|[-_.])xiaoyujie(?:$|[-_.])/i.test(profileId)
    ? "xiaoyujie"
    : /(?:^|[-_.])guobazai(?:$|[-_.])/i.test(profileId)
      ? "guobazai"
      : /(?:^|[-_.])chenan(?:$|[-_.])/i.test(profileId)
        ? "chenan"
        : /(?:^|[-_.])tashuo-juyougeng(?:$|[-_.])/i.test(profileId)
          ? "tashuo-juyougeng"
          : /^(?:image|video)-dreamina-cli(?:-\d+)?$/i.test(profileId)
            ? "default"
            : "";
  const suppliedDreaminaCliProfile = text(value.dreaminaCliProfile, 120);
  if (provider === "即梦" && adapter === "cli" && suppliedDreaminaCliProfile && !validDreaminaCliProfileId(suppliedDreaminaCliProfile)) {
    throw runtimeError("即梦配置 ID 无效", "DREAMINA_PROFILE_ID_INVALID", 422);
  }
  const dreaminaCliProfile = provider === "即梦" && adapter === "cli"
    ? normalizeDreaminaCliProfileId(suppliedDreaminaCliProfile || inferredDreaminaCliProfile)
    : "";
  if (provider === "即梦" && adapter === "cli" && !dreaminaCliProfile) {
    throw runtimeError("即梦 CLI 绑定缺少明确账号配置", "DREAMINA_PROFILE_REQUIRED", 422);
  }
  if (/\0|[\r\n;&|<>]/.test(cliPath)) throw runtimeError("CLI 程序路径包含不允许的字符");
  if (adapter === "api" && !baseUrl && getProviderPreset(provider).custom) throw runtimeError("自定义 API 绑定缺少服务地址");
  if (adapter === "cli" && !cliPath) throw runtimeError("CLI 绑定缺少程序路径");
  if (externalCliAgent && agentEngine === "custom" && !cliArgs) throw runtimeError("自定义运行器绑定缺少参数模板");
  if (chatAdapter && (!chatProtocol || !chatBaseUrl)) throw runtimeError("双处理器 Chat 绑定缺少协议或服务地址");
  return {
    channel,
    profileId,
    adapter,
    provider,
    agentEngine,
    protocol,
    baseUrl,
    cliPath,
    cliArgs,
    ...(dreaminaCliProfile ? { dreaminaCliProfile } : {}),
    chatAdapter,
    chatProtocol,
    chatBaseUrl,
  };
};

const readStore = async () => {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8"));
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: Math.max(0, Number(parsed.revision) || 0),
      updatedAt: text(parsed.updatedAt, 80),
      bindings: (Array.isArray(parsed.bindings) ? parsed.bindings : []).map((binding) => {
        try { return normalizeBinding(binding); } catch { return null; }
      }).filter(Boolean),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { schemaVersion: STORE_SCHEMA_VERSION, revision: 0, updatedAt: "", bindings: [] };
    throw error;
  }
};

const atomicWrite = async (value) => {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const previous = `${path}.${process.pid}.${randomUUID()}.previous`;
    try {
      await rename(path, previous);
      await rename(temporary, path);
      await rm(previous, { force: true });
    } catch (replacementError) {
      await rename(previous, path).catch(() => {});
      throw replacementError;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

export const listGenerationRuntimeBindings = async () => readStore();

export const saveGenerationRuntimeBindings = async ({ bindings = [], replaceChannels = [] } = {}) => {
  const normalized = bindings.map(normalizeBinding);
  const replacementChannels = new Set((Array.isArray(replaceChannels) ? replaceChannels : [])
    .map((channel) => text(channel, 32))
    .filter((channel) => CHANNELS.has(channel)));
  const operation = writeQueue.catch(() => {}).then(async () => {
    const current = await readStore();
    const merged = new Map(current.bindings
      .filter((binding) => !replacementChannels.has(binding.channel))
      .map((binding) => [bindingKey(binding), binding]));
    for (const binding of normalized) merged.set(bindingKey(binding), binding);
    const nextBindings = [...merged.values()].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)));
    const currentBindings = [...current.bindings].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)));
    if (JSON.stringify(currentBindings) === JSON.stringify(nextBindings)) return current;
    const next = {
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      bindings: nextBindings,
    };
    await atomicWrite(next);
    return next;
  });
  writeQueue = operation;
  return operation;
};

export const recoverStaleCodexBinding = async ({
  binding,
  canAccess = access,
  resolveLaunch = resolveLocalCodexLaunch,
} = {}) => {
  const candidate = normalizeBinding(binding);
  const isOpenAiTextCli = candidate.channel === "text"
    && candidate.adapter === "cli"
    && candidate.provider === "OpenAI"
    && /^codex(?:\.exe)?$/i.test(basename(candidate.cliPath));
  if (!isOpenAiTextCli || !isAbsolute(candidate.cliPath)) return { binding: candidate, recovered: false };
  try {
    await canAccess(candidate.cliPath);
    return { binding: candidate, recovered: false };
  } catch {}

  const launch = await resolveLaunch();
  const executable = text(launch?.executable, 2_048);
  if (!executable) return { binding: candidate, recovered: false };
  if (isAbsolute(executable)) await canAccess(executable);
  const prefix = (Array.isArray(launch?.prefixArgs) ? launch.prefixArgs : [])
    .map(quoteCliTemplateArg)
    .join(" ");
  return {
    binding: normalizeBinding({
      ...candidate,
      cliPath: executable,
      cliArgs: [prefix, candidate.cliArgs].filter(Boolean).join(" "),
    }),
    recovered: true,
  };
};

const requestedProfile = (settings = {}, channel, route = "") => {
  const names = channel === "text"
    ? { list: "textConnections", active: "activeTextConnectionId" }
    : channel === "image"
      ? { list: "imageConnections", active: "activeImageConnectionId" }
      : channel === "video"
        ? { list: "videoConnections", active: "activeVideoConnectionId" }
        : { list: "audioConnections", active: "activeAudioConnectionId" };
  const profiles = Array.isArray(settings[names.list]) ? settings[names.list] : [];
  const routedActive = channel === "text" && route === "chat"
    ? settings.activeTextChatConnectionId
    : channel === "text" && route === "agent"
      ? settings.activeTextAgentConnectionId
      : settings[names.active];
  // A complete registry is authoritative: its active channel/surface selection
  // must outrank stale top-level fields projected by another picker. A compact
  // job/profile snapshot has no registry and therefore uses its explicit id.
  const registrySelection = text(routedActive, 120)
    || (profiles.length === 1 ? text(profiles[0]?.id, 120) : "");
  const profileId = profiles.length
    ? registrySelection
    : text(settings.connectionId || settings.id || routedActive || `${channel}-default`, 120);
  if (!profileId) {
    throw runtimeError("当前通道没有选择有效的生成配置", "GENERATION_PROFILE_SELECTION_REQUIRED", 409);
  }
  const profile = profiles.find((item) => text(item?.id || item?.connectionId, 120) === profileId);
  if (profiles.length && !profile) {
    throw runtimeError("当前选择的生成配置不存在或不属于此通道，已阻止切换到其他配置", "GENERATION_PROFILE_IDENTITY_MISMATCH", 409);
  }
  if (!profile) {
    const compactSettings = withoutDreaminaIdentity(settings);
    return {
      profileId,
      settings: compactSettings,
      explicitRuntimeFields: new Set(PROFILE_RUNTIME_IDENTITY_FIELDS.filter((field) => Object.hasOwn(compactSettings, field))),
    };
  }
  const selectedProfile = withoutDreaminaIdentity(profile);
  const selectedSettings = { ...settings, ...selectedProfile, id: profileId, connectionId: profileId };
  // Missing values on the selected record are missing configuration, not an
  // invitation to inherit the previous channel/profile's projected fields.
  for (const field of PROFILE_RUNTIME_IDENTITY_FIELDS) selectedSettings[field] = selectedProfile[field] ?? "";
  return {
    profileId,
    settings: withoutDreaminaIdentity(selectedSettings),
    explicitRuntimeFields: new Set(PROFILE_RUNTIME_IDENTITY_FIELDS.filter((field) => Object.hasOwn(selectedProfile, field))),
  };
};

const projectTrustedTextRuntimeToSelectedProfile = (settings = {}, profileId = "") => {
  if (!Array.isArray(settings.textConnections) || !profileId) return settings;
  const runtimeFields = Object.fromEntries([
    "adapter", "provider", "protocol", "baseUrl", "apiKey", "cliPath", "cliArgs", "agentEngine",
  ].filter((field) => Object.hasOwn(settings, field)).map((field) => [field, settings[field]]));
  return {
    ...settings,
    textConnections: settings.textConnections.map((profile) => (
      text(profile?.id || profile?.connectionId, 120) === profileId
        ? { ...profile, ...runtimeFields }
        : profile
    )),
  };
};

const isCustomApiProfile = (value = {}) => value.adapter === "api"
  && getProviderPreset(value.provider).custom === true
  && Boolean(text(value.baseUrl, 2_048));

// A profile ID can survive a provider switch while its old Dreamina CLI
// binding remains on disk. Migrate only that unambiguous custom-API case;
// unrelated provider changes still fail closed below.
const migrateLegacyDreaminaBindingForCustomApi = async ({
  binding,
  candidate,
  channel,
  profileId,
  persistBindings,
} = {}) => {
  if (!binding || !isCustomApiProfile(candidate) || !isDreaminaCli(binding)) return binding;
  const migrated = normalizeBinding({
    channel,
    profileId,
    adapter: "api",
    provider: candidate.provider,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    cliPath: "",
    cliArgs: "",
  });
  await persistBindings({ bindings: [migrated] });
  return migrated;
};

const builtInCliBinding = ({ channel, settings }) => {
  if (settings.adapter !== "cli") return null;
  if (channel === "text" && settings.provider === "DeepSeek" && settings.cliPath === DEEPSEEK_OPENCODE_CLI_ALIAS) {
    return { cliPath: DEEPSEEK_OPENCODE_CLI_ALIAS, cliArgs: DEEPSEEK_OPENCODE_CLI_ARGS, baseUrl: "" };
  }
  if (channel === "image" && settings.provider === "OpenAI") {
    return { cliPath: OPENAI_IMAGE_CLI_ALIAS, cliArgs: OPENAI_IMAGE_CLI_ARGS, baseUrl: "" };
  }
  if (channel === "image" && settings.provider === "即梦") {
    return { cliPath: DREAMINA_IMAGE_CLI_ALIAS, cliArgs: DREAMINA_IMAGE_CLI_ARGS, baseUrl: "" };
  }
  if (channel === "video" && settings.provider === "即梦") {
    return { cliPath: DREAMINA_VIDEO_CLI_ALIAS, cliArgs: DREAMINA_VIDEO_CLI_ARGS, baseUrl: "" };
  }
  if (["image", "video", "audio"].includes(channel) && String(settings.provider || "").toLowerCase() === "libtv") {
    return { cliPath: LIBTV_CLI_ALIAS, cliArgs: LIBTV_CLI_ARGS, baseUrl: "" };
  }
  return null;
};

const withDreaminaRuntimeIdentity = (settings = {}) => {
  if (settings.adapter !== "cli" || settings.provider !== "即梦") return settings;
  if (!String(settings.dreaminaCliProfile || "").trim()) {
    throw runtimeError("当前连接未指定即梦账号，请重新选择配置", "DREAMINA_PROFILE_REQUIRED", 422);
  }
  if (!validDreaminaCliProfileId(settings.dreaminaCliProfile)) {
    throw runtimeError("即梦配置 ID 无效", "DREAMINA_PROFILE_ID_INVALID", 422);
  }
  const profileId = normalizeDreaminaCliProfileId(settings.dreaminaCliProfile);
  const identity = dreaminaExpectedIdentitySync(profileId);
  const userId = text(identity.expectedUserId || identity.verifiedUserId, 120).toLocaleLowerCase();
  const fingerprint = text(identity.credentialFingerprint, 256).toLocaleLowerCase();
  return {
    ...settings,
    dreaminaCliProfile: profileId,
    dreaminaExpectedIdentity: userId
      ? `user:${userId}`
      : fingerprint && fingerprint !== "unverified" && fingerprint !== "none"
        ? `credential:${fingerprint}`
        : "",
  };
};

const isBuiltInGptChatCli = ({ channel, settings }) => {
  if (channel !== "text" || settings.adapter !== "cli" || settings.provider !== "OpenAI") return false;
  const executable = basename(String(settings.cliPath || "codex")).toLowerCase();
  return !settings.cliPath || /^codex(?:\.(?:exe|cmd|ps1))?$/.test(executable);
};

const resolveBuiltInGptChatBinding = async ({
  profileId,
  settings,
  resolveLaunch = resolveLocalCodexLaunch,
  persistBindings = saveGenerationRuntimeBindings,
} = {}) => {
  const launch = await resolveLaunch();
  const executable = text(launch?.executable, 2_048);
  if (!executable) throw runtimeError("没有检测到可用于 GPT Chat 的本机 Codex CLI", "LOCAL_CODEX_CLI_REQUIRED", 409);
  if (isAbsolute(executable)) await access(executable);
  const prefix = (Array.isArray(launch?.prefixArgs) ? launch.prefixArgs : [])
    .map(quoteCliTemplateArg)
    .join(" ");
  const binding = normalizeBinding({
    channel: "text",
    profileId,
    adapter: "cli",
    provider: "OpenAI",
    protocol: settings.protocol || "responses",
    baseUrl: "",
    cliPath: executable,
    cliArgs: [prefix, settings.cliArgs || getProviderPreset("OpenAI").cli.args].filter(Boolean).join(" "),
  });
  await persistBindings({ bindings: [binding] });
  return binding;
};

export const resolveTrustedGenerationSettings = async ({
  settings = {},
  channel = "text",
  resolveCodexLaunch = resolveLocalCodexLaunch,
  persistBindings = saveGenerationRuntimeBindings,
  route = "",
} = {}) => {
  if (!CHANNELS.has(channel)) throw runtimeError("生成通道无效");
  const requested = requestedProfile(settings, channel, route);
  const publicPreset = getProviderPreset("免费模型");
  if (channel === "text" && requested.profileId === "text-public-kilo") {
    return {
      ...requested.settings,
      id: requested.profileId,
      connectionId: requested.profileId,
      systemManaged: true,
      adapter: "api",
      provider: "免费模型",
      protocol: publicPreset.api.protocol,
      baseUrl: publicPreset.api.baseUrl,
      apiKey: "",
      cliPath: "",
      cliArgs: "",
      executionMode: "chat",
      executionModes: ["chat"],
      agentEngine: "",
    };
  }
  if (channel === "text" && requested.profileId === "text-public-agent") {
    return {
      ...requested.settings,
      id: requested.profileId,
      connectionId: requested.profileId,
      systemManaged: true,
      adapter: "api",
      provider: "免费模型",
      protocol: publicPreset.api.protocol,
      baseUrl: publicPreset.api.baseUrl,
      apiKey: "",
      cliPath: "",
      cliArgs: "",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "codex_api",
      credentialSource: "public",
      agentModelId: requested.settings.model,
      chatModelId: "",
    };
  }
  const candidateApiKey = text(requested.settings.apiKey, 16_384)
    || transientGenerationCredentialForSettings(channel, requested.profileId, requested.settings);
  if (candidateApiKey && requested.settings.adapter === "api") {
    rememberGenerationRuntimeCredentials({ credentials: { [channel]: { [requested.profileId]: candidateApiKey } } });
  }
  const candidate = candidateApiKey
    ? { ...requested.settings, apiKey: candidateApiKey }
    : requested.settings;
  const adapter = text(candidate.adapter, 16);
  const provider = text(candidate.provider, 120);
  const externalCliAgent = channel === "text"
    && candidate.adapter === "cli"
    && EXTERNAL_CLI_AGENT_ENGINES.has(text(candidate.agentEngine, 64));
  const protocol = text(candidate.protocol, 80);
  if (!ADAPTERS.has(adapter) || (!provider && !externalCliAgent)) throw runtimeError("生成配置缺少调用方式或服务商");

  if (externalCliAgent) {
    const descriptor = agentEngineDescriptor(candidate.agentEngine);
    const cliPath = text(candidate.cliPath, 2_048) || text(descriptor.cliPath, 2_048);
    const cliArgs = text(candidate.cliArgs, 16_384);
    if (candidate.agentEngine === "custom" && !cliPath) throw runtimeError("外置 Agent 缺少 CLI 程序路径", "EXTERNAL_CLI_PATH_REQUIRED", 409);
    if (candidate.agentEngine === "custom" && !cliArgs) throw runtimeError("自定义运行器缺少 CLI 参数模板", "EXTERNAL_CLI_ARGS_REQUIRED", 409);
    return {
      ...candidate,
      id: requested.profileId,
      connectionId: requested.profileId,
      adapter: "cli",
      provider,
      protocol,
      baseUrl: "",
      cliPath,
      cliArgs,
      prefixArgs: Array.isArray(candidate.prefixArgs) ? candidate.prefixArgs.filter((item) => typeof item === "string").slice(0, 16) : [],
    };
  }

  if (isBuiltInGptChatCli({ channel, settings: candidate })) {
    const binding = await resolveBuiltInGptChatBinding({
      profileId: requested.profileId,
      settings: candidate,
      resolveLaunch: resolveCodexLaunch,
      persistBindings,
    });
    return {
      ...candidate,
      id: requested.profileId,
      connectionId: requested.profileId,
      ...binding,
    };
  }

  const builtIn = builtInCliBinding({ channel, settings: candidate });
  if (builtIn) {
    let boundDreaminaCliProfile = "";
    if (provider === "即梦") {
      const store = await readStore();
      const storedBinding = store.bindings.find((item) => item.channel === channel && item.profileId === requested.profileId);
      if (storedBinding) {
        if (storedBinding.adapter !== adapter || storedBinding.provider !== provider || storedBinding.protocol !== protocol) {
          throw runtimeError("项目中的即梦配置与本机授权不一致，请在设置中重新确认", "LOCAL_RUNTIME_BINDING_REQUIRED", 409);
        }
        assertCandidateMatchesStoredBinding({
          candidate,
          explicitFields: requested.explicitRuntimeFields,
          binding: storedBinding,
        });
        boundDreaminaCliProfile = storedBinding.dreaminaCliProfile;
      }
    }
    return withDreaminaRuntimeIdentity({
      ...candidate,
      id: requested.profileId,
      connectionId: requested.profileId,
      ...builtIn,
      ...(boundDreaminaCliProfile ? { dreaminaCliProfile: boundDreaminaCliProfile } : {}),
    });
  }

  const store = await readStore();
  let storedBinding = store.bindings.find((item) => item.channel === channel && item.profileId === requested.profileId);
  storedBinding = await migrateLegacyDreaminaBindingForCustomApi({
    binding: storedBinding,
    candidate,
    channel,
    profileId: requested.profileId,
    persistBindings,
  });
  const chatProjection = route === "chat"
    && candidate.agentEngine === "opencode"
    && candidate.credentialSource === "shensi"
    && (Array.isArray(candidate.executionModes) ? candidate.executionModes : []).includes("chat");
  if (storedBinding) {
    assertCandidateMatchesStoredBinding({
      candidate,
      explicitFields: requested.explicitRuntimeFields,
      binding: storedBinding,
      chatProjection,
    });
  }
  const recovery = storedBinding ? await recoverStaleCodexBinding({ binding: storedBinding }) : null;
  const binding = recovery?.binding ?? storedBinding;
  if (binding) {
    if (binding.adapter !== adapter || binding.provider !== provider || binding.protocol !== protocol) {
      throw runtimeError("项目中的生成配置与本机授权不一致，请在设置中重新确认", "LOCAL_RUNTIME_BINDING_REQUIRED", 409);
    }
    if (recovery?.recovered) await saveGenerationRuntimeBindings({ bindings: [binding] });
    const bindingCredential = binding.adapter === "api"
      ? transientGenerationCredential(channel, requested.profileId)
        || transientGenerationCredentialForSettings(channel, requested.profileId, { ...candidate, ...binding })
      : "";
    if (chatProjection && binding.chatAdapter !== "api") {
      throw runtimeError("此 OpenCode 连接尚未完成 API Chat 双处理器授权，请重新运行真实连接测试", "LOCAL_RUNTIME_BINDING_REQUIRED", 409);
    }
    const resolved = withoutDreaminaIdentity({
      ...candidate,
      ...(bindingCredential ? { apiKey: bindingCredential } : {}),
      id: requested.profileId,
      connectionId: requested.profileId,
      adapter: chatProjection ? binding.chatAdapter : binding.adapter,
      ...(chatProjection ? {
        executionMode: "chat",
        executionModes: ["chat"],
        agentEngine: "",
        agentModelId: "",
      } : {}),
      provider: binding.provider,
      protocol: chatProjection ? binding.chatProtocol : binding.protocol,
      baseUrl: chatProjection ? binding.chatBaseUrl : binding.baseUrl,
      model: chatProjection
        ? text(candidate.chatModelId || String(candidate.model || "").split("/").slice(1).join("/"), 240)
        : candidate.model,
      cliPath: chatProjection ? "" : binding.cliPath,
      cliArgs: chatProjection ? "" : binding.cliArgs,
      dreaminaCliProfile: binding.dreaminaCliProfile,
    });
    return channel === "text"
      ? projectTrustedTextRuntimeToSelectedProfile(resolved, requested.profileId)
      : resolved;
  }

  // The renderer may have just rehydrated a DPAPI-backed API credential and
  // sent it to this core process while the portable runtime binding file is
  // still being written. Keep that short window usable without persisting the
  // secret: the request already carries the complete, validated connection
  // settings and the key is held only in this process memory.
  if (adapter === "api" && candidate.apiKey) {
    const baseUrl = validateBaseUrl(candidate.baseUrl);
    if (baseUrl) {
      return {
        ...candidate,
        id: requested.profileId,
        connectionId: requested.profileId,
        adapter: "api",
        provider,
        protocol,
        baseUrl,
        cliPath: "",
        cliArgs: "",
      };
    }
  }

  const preset = getProviderPreset(provider);
  if (adapter === "api" && !preset.custom && preset.api?.baseUrl) {
    return {
      ...candidate,
      id: requested.profileId,
      connectionId: requested.profileId,
      adapter: "api",
      provider,
      protocol: preset.api.protocol,
      baseUrl: preset.api.baseUrl,
      cliPath: "",
      cliArgs: "",
    };
  }

  throw runtimeError("此连接尚未在本机设置中授权，请重新保存连接配置", "LOCAL_RUNTIME_BINDING_REQUIRED", 409);
};

export const generationRuntimeStorePath = () => storePath();
