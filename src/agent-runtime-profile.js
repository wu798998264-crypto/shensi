import { agentEngineDescriptor, normalizeAgentEngineId } from "./agent-engine-registry.js";
import { normalizeAgentPermissionMode, permissionContractFor } from "./agent-permission-policy.js";

const defaultCapabilities = (engine, permissionMode = "shensi_only") => {
  const contract = permissionContractFor(normalizeAgentPermissionMode(permissionMode), { runner: engine });
  const enhanced = contract.mode !== "shensi_only";
  const workspaceToolsAvailable = ["codex", "codex_api", "deepseek_opencode", "opencode", "claude_code", "workbuddy", "custom"].includes(engine);
  return {
    permissionMode: contract.mode,
    permissionLabel: contract.label,
    filesystemAccess: contract.capabilities.filesystem,
    networkCapability: contract.capabilities.network,
    shellEnabled: contract.capabilities.shell,
    secretsEnabled: contract.capabilities.secrets,
    shensiSkillContext: true,
    openCodeToolsEnabled: enhanced && ["deepseek_opencode", "opencode"].includes(engine),
    claudeCodeToolsEnabled: enhanced && engine === "claude_code",
    codexToolsEnabled: enhanced && ["codex", "codex_api"].includes(engine),
    externalCliToolsEnabled: enhanced && ["workbuddy", "custom"].includes(engine),
    globalPluginsEnabled: contract.capabilities.globalPlugins,
    globalMcpEnabled: contract.capabilities.globalMcp,
    globalSkillsEnabled: contract.capabilities.globalSkills,
    appsEnabled: contract.capabilities.apps,
    hooksEnabled: contract.capabilities.hooks,
    skillSearchEnabled: contract.capabilities.skillSearch,
    multiAgentEnabled: contract.capabilities.multiAgent,
    workspaceToolsAvailable,
    workspaceToolsProtocol: workspaceToolsAvailable
      ? engine === "codex" ? "shensi_workspace_tools_v1" : "shensi_conversation_agent_v1"
      : "unavailable",
    workspaceToolsUnavailableReason: workspaceToolsAvailable ? "" : "runtime_profile_required",
  };
};

export const agentRuntimeProfile = ({ engine = "", model = "", capabilities = null } = {}) => {
  const normalizedEngine = normalizeAgentEngineId(engine);
  const suppliedCapabilities = capabilities && typeof capabilities === "object"
    ? Object.fromEntries(Object.entries(capabilities).filter(([, value]) => value !== undefined))
    : {};
  const permissionMode = normalizeAgentPermissionMode(suppliedCapabilities.permissionMode);
  return {
    engine: normalizedEngine,
    label: agentEngineDescriptor(normalizedEngine).label,
    model: String(model || "").trim(),
    capabilities: {
      ...defaultCapabilities(normalizedEngine, permissionMode),
      ...suppliedCapabilities,
      permissionMode,
    },
  };
};

export const agentRuntimeProfileFromStatus = (status = {}) => agentRuntimeProfile({
  engine: status.agentEngine,
  model: status.effectiveAgentModel || status.agentModel,
  capabilities: {
    permissionMode: status.permissionMode,
    permissionLabel: status.permissionLabel,
    filesystemAccess: status.filesystemAccess,
    networkCapability: status.networkCapability === true,
    globalPluginsEnabled: status.runtimeIsolation?.globalPluginsEnabled === true,
    globalMcpEnabled: status.runtimeIsolation?.globalMcpEnabled === true,
    globalSkillsEnabled: status.runtimeIsolation?.globalSkillsEnabled === true,
    appsEnabled: status.runtimeIsolation?.appsEnabled === true,
    hooksEnabled: status.runtimeIsolation?.hooksEnabled === true,
    skillSearchEnabled: status.runtimeIsolation?.skillSearchEnabled === true,
    multiAgentEnabled: status.runtimeIsolation?.multiAgentEnabled === true,
    workspaceToolsAvailable: status.workspaceToolsAvailable === true,
    workspaceToolsProtocol: status.workspaceToolsProtocol,
    workspaceToolsUnavailableReason: status.workspaceToolsUnavailableReason,
  },
});

export const agentRuntimeProfileFromExecution = (execution = {}) => agentRuntimeProfile({
  engine: execution.agentEngine
    || execution.engine
    || (String(execution.agentTurnId || "").startsWith("deepseek_") ? "deepseek_opencode"
      : String(execution.agentTurnId || "").startsWith("opencode_") ? "opencode"
        : String(execution.agentTurnId || "").startsWith("claude_") ? "claude_code" : "codex"),
  model: execution.agentModel || execution.model,
  capabilities: execution.agentCapabilities,
});

export const agentCapabilitySummary = (profileValue = {}) => {
  const profile = profileValue?.capabilities ? profileValue : agentRuntimeProfile(profileValue);
  const capabilities = profile.capabilities || {};
  const runtimeToolLabel = ["deepseek_opencode", "opencode"].includes(profile.engine) && capabilities.openCodeToolsEnabled
    ? "OpenCode 原生工具"
    : profile.engine === "claude_code" && capabilities.claudeCodeToolsEnabled
      ? "Claude Code 原生工具"
    : ["codex", "codex_api"].includes(profile.engine) && capabilities.codexToolsEnabled
        ? "Codex 原生工具"
        : ["workbuddy", "custom"].includes(profile.engine) && capabilities.externalCliToolsEnabled
          ? `${profile.label} 原生工具`
        : "";
  const ambientExtensions = capabilities.globalSkillsEnabled || capabilities.globalPluginsEnabled
    || capabilities.globalMcpEnabled || capabilities.appsEnabled || capabilities.hooksEnabled || capabilities.skillSearchEnabled;
  return [
    capabilities.permissionLabel,
    capabilities.workspaceToolsAvailable ? "神思工作区工具" : capabilities.shensiSkillContext !== false ? "神思 Skill 上下文" : "",
    runtimeToolLabel,
    capabilities.shellEnabled ? "Shell 与系统文件" : "",
    capabilities.networkCapability ? "联网工具" : "",
    ambientExtensions ? "全局 Skill、插件、MCP、App 与 Hooks" : "",
    capabilities.multiAgentEnabled ? "多 Agent" : "",
    capabilities.permissionMode === "shensi_only" ? "不访问宿主环境" : "",
  ].filter(Boolean).join(" · ");
};

export const agentExecutionProfilePatch = (value = {}) => {
  const profile = value.agentEngine || value.effectiveAgentModel || value.runtimeIsolation
    ? agentRuntimeProfileFromStatus(value)
    : agentRuntimeProfile({
        engine: value.engine,
        model: value.agentModel || value.model,
        capabilities: value.agentCapabilities || value.capabilities,
      });
  return {
    agentEngine: profile.engine,
    agentEngineLabel: profile.label,
    agentModel: profile.model,
    agentCapabilities: profile.capabilities,
  };
};
