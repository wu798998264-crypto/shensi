const text = (value = "") => String(value ?? "").trim();

export const SHENSI_AGENT_API_PROTOCOLS = Object.freeze(["responses", "chat_completions", "anthropic_messages", "messages"]);
export const SHENSI_SYSTEM_PUBLIC_AGENT_PROFILE_IDS = Object.freeze(["text-public-kilo", "text-public-agent"]);

export const isCodexApiCompatibleProvider = (provider = "") => (
  Boolean(text(provider))
);

export const isSystemManagedPublicAgentProfile = (profile = {}) => (
  profile?.systemManaged === true
  && text(profile.credentialSource) === "public"
  && text(profile.provider) === "免费模型"
  && SHENSI_SYSTEM_PUBLIC_AGENT_PROFILE_IDS.includes(text(profile.id || profile.connectionId))
);

export const isShensiAgentCompatibleProfile = (profile = {}) => (
  text(profile.adapter) === "api"
  && SHENSI_AGENT_API_PROTOCOLS.includes(text(profile.protocol))
  && Boolean(text(profile.provider))
);

const ENGINE_DEFINITIONS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    provider: "OpenAI",
    adapter: "cli",
    launcher: "codex",
  }),
  codex_api: Object.freeze({
    id: "codex_api",
    label: "神思运行器",
    provider: "",
    adapter: "api",
    launcher: "responses-api",
  }),
  deepseek_opencode: Object.freeze({
    id: "deepseek_opencode",
    label: "OpenCode+DeepSeek",
    provider: "DeepSeek",
    adapter: "cli",
    launcher: "deepseek-opencode",
  }),
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    provider: "",
    adapter: "cli",
    launcher: "opencode",
  }),
  claude_code: Object.freeze({
    id: "claude_code",
    label: "Claude Code",
    provider: "",
    adapter: "cli",
    launcher: "claude",
  }),
});

export const AGENT_ENGINE_IDS = Object.freeze(Object.keys(ENGINE_DEFINITIONS));

export const normalizeAgentEngineId = (value = "") => (
  ["codex_api", "deepseek_opencode", "opencode", "claude_code"].includes(text(value)) ? text(value) : "codex"
);

export const agentEngineDescriptor = (value = "") => ENGINE_DEFINITIONS[normalizeAgentEngineId(value)];

export const agentEngineForProfile = (profile = {}) => {
  const explicit = text(profile.agentEngine);
  if (AGENT_ENGINE_IDS.includes(explicit)) return explicit;
  if (text(profile.provider) === "DeepSeek" && text(profile.adapter) === "cli") return "deepseek_opencode";
  if (text(profile.provider) === "OpenAI" && text(profile.adapter) === "cli") return "codex";
  if (text(profile.provider) === "Claude" && text(profile.adapter) === "cli") return "claude_code";
  return "";
};

export const selectedAgentRuntimeProfile = (settings = {}, fallbackEngine = "codex") => {
  const profiles = Array.isArray(settings?.textConnections) ? settings.textConnections : [];
  const requestedId = text(
    settings?.activeTextAgentConnectionId
      || settings?.connectionId
      || settings?.id
      || settings?.activeTextConnectionId,
  );
  const profile = requestedId
    ? profiles.find((item) => text(item?.id || item?.connectionId) === requestedId) || null
    : null;
  const engine = agentEngineForProfile(profile || settings) || normalizeAgentEngineId(fallbackEngine);
  return { profile, engine };
};

export const agentProfileBelongsToEngine = (profile = {}, engine = "") => {
  const engineId = normalizeAgentEngineId(engine);
  const descriptor = agentEngineDescriptor(engineId);
  const providerMatches = engineId === "codex_api"
    ? isShensiAgentCompatibleProfile(profile)
    : !descriptor.provider || text(profile.provider) === descriptor.provider;
  return agentEngineForProfile(profile) === engineId
    && providerMatches
    && text(profile.adapter) === descriptor.adapter;
};

export const agentModelBelongsToEngine = (model = "", engine = "") => {
  const slug = text(typeof model === "string" ? model : model?.slug || model?.id || model?.name).toLocaleLowerCase("en-US");
  if (!slug) return false;
  if (normalizeAgentEngineId(engine) === "codex_api") return true;
  if (normalizeAgentEngineId(engine) === "opencode") return /^[^/\s]+\/[^/\s]+$/u.test(slug);
  if (normalizeAgentEngineId(engine) === "claude_code") return /^(?:claude-|anthropic\/claude-|deepseek-v4-(?:pro|flash)(?:\[1m\])?)/u.test(slug);
  return normalizeAgentEngineId(engine) === "deepseek_opencode"
    ? /(?:^|[\/_-])deepseek(?:$|[\/_-])|^deepseek/u.test(slug)
    : /^(?:gpt-|o\d|codex)|(?:^|[\/_-])(?:gpt-|codex)/u.test(slug) && !/deepseek/u.test(slug);
};

const normalizedModel = (item) => {
  if (typeof item === "string") return { slug: text(item), label: text(item) };
  const slug = text(item?.slug || item?.id || item?.name);
  return slug ? { ...item, slug, label: text(item?.label || item?.displayName || slug) } : null;
};

export const agentModelsForEngine = (engine = "", {
  codexModels = [],
  openCodeModels = [],
  effectiveModel = "",
} = {}) => {
  const engineId = normalizeAgentEngineId(engine);
  const source = ["deepseek_opencode", "opencode"].includes(engineId) ? openCodeModels : codexModels;
  const models = new Map((Array.isArray(source) ? source : [])
    .map(normalizedModel)
    .filter(Boolean)
    .filter((item) => agentModelBelongsToEngine(item.slug, engineId))
    .map((item) => [item.slug, item]));
  const fallback = normalizedModel(effectiveModel);
  if (fallback && agentModelBelongsToEngine(fallback.slug, engineId) && !models.has(fallback.slug)) {
    models.set(fallback.slug, fallback);
  }
  return [...models.values()];
};

export const agentProfilesForEngine = (profiles = [], engine = "") => (
  (Array.isArray(profiles) ? profiles : []).filter((profile) => agentProfileBelongsToEngine(profile, engine))
);
