import {
  agentEngineForProfile,
  isShensiAgentCompatibleProfile,
  isSystemManagedPublicAgentProfile,
  SHENSI_AGENT_API_PROTOCOLS,
} from "./agent-engine-registry.js";

const text = (value = "") => String(value ?? "").trim();
const uniqueModes = () => ["agent"];

const failed = ({ code, message, profileId = "", surface = "", ...rest }) => ({
  ok: false,
  code,
  message,
  profileId,
  surface,
  ...rest,
});

const credentialSourceForProfile = (profile = {}, engine = "", surface = "") => {
  const explicit = text(profile.credentialSource);
  if (explicit) return explicit;
  if (profile.adapter === "api") return "shensi";
  if (engine === "codex") return "codex";
  if (engine === "opencode" || engine === "deepseek_opencode") return "opencode";
  if (engine === "claude_code") return "claude";
  return "shensi";
};

const modelForSurface = (profile = {}, surface = "chat", engine = "") => {
  return text(profile.agentModelId || profile.model);
};

const runnerForSurface = (profile = {}, surface = "chat", engine = "") => {
  if (engine === "codex_api" && profile.adapter === "api") return "codex_api_agent";
  return engine || "";
};

export const runtimeContractForProfile = ({ profile = null, surface = "chat" } = {}) => {
  const requestedSurface = "agent";
  const legacyRequestedSurface = text(surface) === "chat" ? "chat" : "agent";
  const profileId = text(profile?.id || profile?.connectionId);
  if (!profile || !profileId) return failed({ code: "RUNTIME_PROFILE_REQUIRED", message: "没有选择有效的文字模型配置", surface: requestedSurface });
  const supportedSurfaces = uniqueModes(profile);
  if (!supportedSurfaces.includes(requestedSurface)) {
    return failed({
      code: "RUNTIME_SURFACE_UNSUPPORTED",
      message: `配置 ${profileId} 不支持 ${requestedSurface === "agent" ? "Agent" : "Chat"} 模式`,
      profileId,
      surface: requestedSurface,
      supportedSurfaces,
    });
  }

  const engine = requestedSurface === "agent" || profile.adapter === "cli" ? agentEngineForProfile(profile) : "";
  const runner = runnerForSurface(profile, requestedSurface, engine);
  const provider = text(profile.provider);
  const model = modelForSurface(profile, requestedSurface, engine);
  const credentialSource = credentialSourceForProfile(profile, engine, requestedSurface);
  const base = {
    profileId,
    surface: requestedSurface,
    legacyRequestedSurface,
    supportedSurfaces,
    provider,
    adapter: text(profile.adapter),
    protocol: text(profile.protocol),
    runner,
    engine,
    model,
    credentialSource,
    baseUrl: text(profile.baseUrl),
    cliPath: text(profile.cliPath),
    cliArgs: text(profile.cliArgs),
  };

  if (!provider) return failed({ ...base, code: "RUNTIME_PROVIDER_REQUIRED", message: "没有选择模型服务商" });
  if (!runner) return failed({ ...base, code: "RUNTIME_RUNNER_REQUIRED", message: "没有选择可用的运行器" });
  if (!model) return failed({ ...base, code: "RUNTIME_MODEL_REQUIRED", message: "没有选择模型" });
  if (requestedSurface === "agent"
    && engine === "codex"
    && model.includes("/")) {
    return failed({ ...base, code: "CODEX_MODEL_ID_INVALID", message: "Codex 使用普通模型 ID，不能使用 provider/model 格式" });
  }
  if (requestedSurface === "agent" && engine === "opencode" && !/^[^/\s]+\/[^/\s]+$/u.test(model)) {
    return failed({ ...base, code: "OPENCODE_MODEL_ID_INVALID", message: "OpenCode 必须使用完整 provider/model 模型 ID" });
  }
  if (requestedSurface === "agent" && engine === "codex" && provider !== "OpenAI") {
    return failed({ ...base, code: "CODEX_PROVIDER_MISMATCH", message: "Codex Agent 只能使用 OpenAI 模型配置" });
  }
  if (requestedSurface === "agent" && engine === "codex_api" && !isShensiAgentCompatibleProfile(profile)) {
    return failed({ ...base, code: "SHENSI_AGENT_PROTOCOL_UNSUPPORTED", message: "当前配置不是神思运行器支持的 API Agent 协议" });
  }
  if (requestedSurface === "agent" && engine === "codex_api") {
    if (text(profile.adapter) !== "api") return failed({ ...base, code: "CODEX_API_ADAPTER_REQUIRED", message: "神思运行器必须使用 API 连接" });
    if (!SHENSI_AGENT_API_PROTOCOLS.includes(text(profile.protocol))) return failed({ ...base, code: "CODEX_API_PROTOCOL_REQUIRED", message: "神思运行器需要 Responses、Chat Completions 或 Anthropic Messages Agent 协议" });
    if (!text(profile.baseUrl)) return failed({ ...base, code: "CODEX_API_BASE_URL_REQUIRED", message: "神思运行器缺少 API 地址" });
    if (!text(profile.apiKey) && !isSystemManagedPublicAgentProfile(profile)) return failed({ ...base, code: "CODEX_API_KEY_REQUIRED", message: "神思运行器缺少 API Key" });
  }
  return { ok: true, code: "", message: "", ...base };
};

export const effectiveRuntimeContract = ({ settings = {}, surface = "chat", profileId = "" } = {}) => {
  const requestedSurface = "agent";
  const profiles = Array.isArray(settings.textConnections) ? settings.textConnections : [];
  const requestedId = text(profileId)
    || text(settings.activeTextAgentConnectionId)
    || text(settings.activeTextConnectionId);
  const profile = profiles.find((item) => text(item?.id || item?.connectionId) === requestedId)
    || (text(settings.id || settings.connectionId) === requestedId ? settings : null);
  if (!profile) return failed({ code: "RUNTIME_PROFILE_NOT_FOUND", message: "当前文字模型配置不存在", profileId: requestedId, surface: requestedSurface });
  return runtimeContractForProfile({ profile, surface });
};

export const shouldShowCodexAccountControls = (profile = {}) => (
  text(profile.provider) === "OpenAI"
  && text(profile.adapter) === "cli"
  && agentEngineForProfile(profile) === "codex"
);
