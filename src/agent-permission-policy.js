const PERMISSION_MODE_IDS = Object.freeze(["shensi_only", "approval_required", "full_access"]);

export const DEFAULT_AGENT_PERMISSION_MODE = "shensi_only";

export const AGENT_PERMISSION_MODES = Object.freeze({
  shensi_only: Object.freeze({
    id: "shensi_only",
    label: "仅限神思",
    description: "只使用神思提供的作品、Skill、媒体和交互工具。",
    sandbox: "read-only",
    approvalPolicy: "never",
    network: false,
    shell: false,
    systemFiles: false,
    secrets: false,
    globalExtensions: false,
    multiAgent: false,
    workspaceTools: true,
    externalWrites: false,
    approvalRequired: false,
  }),
  approval_required: Object.freeze({
    id: "approval_required",
    label: "操作需确认",
    description: "可使用完整 Agent 能力；密钥、作品外写入、依赖、服务、网络外发和破坏性操作逐项确认。",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    network: true,
    shell: true,
    systemFiles: true,
    secrets: true,
    globalExtensions: true,
    multiAgent: true,
    workspaceTools: true,
    externalWrites: true,
    approvalRequired: true,
  }),
  full_access: Object.freeze({
    id: "full_access",
    label: "完全权限",
    description: "使用当前系统账户可用的 Agent 能力，不经过神思逐项确认。",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    network: true,
    shell: true,
    systemFiles: true,
    secrets: true,
    globalExtensions: true,
    multiAgent: true,
    workspaceTools: true,
    externalWrites: true,
    approvalRequired: false,
  }),
});

const MODE_ALIASES = Object.freeze({
  workspace_scoped: "shensi_only",
  shensi: "shensi_only",
  safe: "shensi_only",
  restricted: "shensi_only",
  ask: "approval_required",
  on_request: "approval_required",
  approval: "approval_required",
  danger_full_access: "full_access",
  native: "full_access",
  unrestricted: "full_access",
});

const clean = (value) => String(value ?? "").trim().toLowerCase();

export const normalizeAgentPermissionMode = (value, fallback = DEFAULT_AGENT_PERMISSION_MODE) => {
  const candidate = clean(value);
  if (PERMISSION_MODE_IDS.includes(candidate)) return candidate;
  if (MODE_ALIASES[candidate]) return MODE_ALIASES[candidate];
  const normalizedFallback = clean(fallback);
  return PERMISSION_MODE_IDS.includes(normalizedFallback) ? normalizedFallback : DEFAULT_AGENT_PERMISSION_MODE;
};

export const agentPermissionModeInfo = (value, fallback = DEFAULT_AGENT_PERMISSION_MODE) => (
  AGENT_PERMISSION_MODES[normalizeAgentPermissionMode(value, fallback)]
);

export const agentPermissionModeOptions = () => PERMISSION_MODE_IDS.map((id) => ({
  id,
  label: AGENT_PERMISSION_MODES[id].label,
  description: AGENT_PERMISSION_MODES[id].description,
}));

export const normalizeAgentPermissionSettings = (settings = {}) => ({
  ...settings,
  agentPermissionMode: normalizeAgentPermissionMode(settings.agentPermissionMode),
});

export const permissionContractFor = (value, { runner = "", taskId = "", snapshotAt = "" } = {}) => {
  const mode = normalizeAgentPermissionMode(value);
  const info = AGENT_PERMISSION_MODES[mode];
  return Object.freeze({
    schemaVersion: 1,
    mode,
    label: info.label,
    runner: String(runner || "").trim(),
    taskId: String(taskId || "").trim(),
    snapshotAt: String(snapshotAt || new Date().toISOString()),
    capabilities: Object.freeze({
      shell: info.shell,
      network: info.network,
      filesystem: info.systemFiles ? "os_user_full" : "shensi_workspace_tools",
      secrets: info.secrets,
      globalPlugins: info.globalExtensions,
      globalMcp: info.globalExtensions,
      globalSkills: info.globalExtensions,
      apps: info.globalExtensions,
      hooks: info.globalExtensions,
      skillSearch: info.globalExtensions,
      multiAgent: info.multiAgent,
      workspaceTools: info.workspaceTools,
      externalWrites: info.externalWrites,
    }),
    confirmation: Object.freeze({
      required: info.approvalRequired,
      scope: info.approvalRequired ? "per_operation" : "none",
      protectedOperations: info.approvalRequired
        ? Object.freeze(["secret_read", "external_write", "system_change", "dependency_install", "service_start", "destructive_command", "network_exfiltration", "extension_change"])
        : Object.freeze([]),
    }),
  });
};

export const codexPermissionConfig = (value) => {
  const info = agentPermissionModeInfo(value);
  return {
    sandbox: info.sandbox,
    sandboxPolicy: info.sandbox === "danger-full-access"
      ? { type: "dangerFullAccess" }
      : info.sandbox === "workspace-write"
        ? { type: "workspaceWrite", networkAccess: true }
        : { type: "readOnly", networkAccess: false },
    approvalPolicy: info.approvalPolicy,
    networkSearch: info.network,
    isolation: info.id === "shensi_only",
  };
};

export const permissionModeIds = () => [...PERMISSION_MODE_IDS];

