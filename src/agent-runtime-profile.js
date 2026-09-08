import { agentEngineDescriptor, normalizeAgentEngineId } from "./agent-engine-registry.js";

const defaultCapabilities = (engine) => ["codex_api", "deepseek_opencode", "opencode", "claude_code"].includes(engine)
  ? {
      permissionMode: "workspace_scoped",
      permissionLabel: "工作区访问",
      filesystemAccess: "workspace_only",
      networkCapability: false,
      shensiSkillContext: true,
      openCodeToolsEnabled: ["deepseek_opencode", "opencode"].includes(engine),
      claudeCodeToolsEnabled: engine === "claude_code",
      globalPluginsEnabled: false,
      globalMcpEnabled: false,
      globalSkillsEnabled: false,
      appsEnabled: false,
      multiAgentEnabled: false,
      workspaceToolsAvailable: false,
      workspaceToolsProtocol: "unavailable",
      workspaceToolsUnavailableReason: "provider_dynamic_tools_unsupported",
    }
  : {
      permissionMode: "danger_full_access",
      permissionLabel: "完整访问（与 Codex 最高权限一致）",
      filesystemAccess: "os_user_full",
      networkCapability: true,
      shensiSkillContext: true,
      openCodeToolsEnabled: false,
      globalPluginsEnabled: true,
      globalMcpEnabled: true,
      globalSkillsEnabled: true,
      appsEnabled: true,
      multiAgentEnabled: true,
      workspaceToolsAvailable: true,
      workspaceToolsProtocol: "shensi_workspace_tools_v1",
      workspaceToolsUnavailableReason: "",
    };

export const agentRuntimeProfile = ({ engine = "", model = "", capabilities = null } = {}) => {
  const normalizedEngine = normalizeAgentEngineId(engine);
  const suppliedCapabilities = capabilities && typeof capabilities === "object"
    ? Object.fromEntries(Object.entries(capabilities).filter(([, value]) => value !== undefined))
    : {};
  return {
    engine: normalizedEngine,
    label: agentEngineDescriptor(normalizedEngine).label,
    model: String(model || "").trim(),
    capabilities: {
      ...defaultCapabilities(normalizedEngine),
      ...suppliedCapabilities,
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
  if (["codex_api", "deepseek_opencode", "opencode", "claude_code"].includes(profile.engine)) {
    const runtimeToolLabel = profile.engine === "codex_api"
      ? capabilities.workspaceToolsAvailable ? "神思工作区工具" : ""
      : ["deepseek_opencode", "opencode"].includes(profile.engine)
        ? capabilities.openCodeToolsEnabled !== false ? "OpenCode 工具" : ""
        : capabilities.claudeCodeToolsEnabled !== false ? "Claude Code 工具" : "";
    return [
      capabilities.filesystemAccess === "workspace_only" ? "工作区文件访问" : capabilities.permissionLabel,
      capabilities.shensiSkillContext !== false ? "神思 Skill 上下文" : "",
      runtimeToolLabel,
      capabilities.workspaceToolsAvailable === false ? "神思工作区动态读取不可用" : "",
      !capabilities.globalPluginsEnabled && !capabilities.globalMcpEnabled && !capabilities.networkCapability && !capabilities.multiAgentEnabled
        ? "不含 Codex 插件、MCP、联网工具和子 Agent"
        : "",
    ].filter(Boolean).join(" · ");
  }
  return [
    capabilities.filesystemAccess === "os_user_full" ? "完整文件访问" : capabilities.permissionLabel,
    capabilities.networkCapability ? "联网工具" : "",
    capabilities.globalSkillsEnabled || capabilities.globalPluginsEnabled || capabilities.globalMcpEnabled || capabilities.appsEnabled
      ? "Skill、插件、MCP 与 App"
      : "",
    capabilities.multiAgentEnabled ? "多 Agent" : "",
    capabilities.workspaceToolsAvailable ? "神思工作区按需读取" : "",
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
