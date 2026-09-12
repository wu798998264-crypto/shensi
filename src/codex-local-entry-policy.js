export const DETECTED_CODEX_CONNECTION_ID = "__detected_codex_cli__";
export const DETECTED_CODEX_CONNECTION_LABEL = "Codex CLI Agent（本机已检测）";
export const CODEX_AGENT_MODE_LABEL = "Agent（复杂任务、工具调用与多步执行）";

const codexExecutableName = (value = "") => String(value || "").split(/[\\/]/u).at(-1) || "";

export const codexCliProfile = (profile = {}) => profile?.adapter === "cli"
  && (profile?.agentEngine === "codex"
    || (profile?.provider === "OpenAI" && /^codex(?:\.(?:exe|cmd|ps1))?$/iu.test(codexExecutableName(profile?.cliPath))));

export const codexSettingsProfile = (profile = {}) => profile?.adapter === "cli"
  && profile?.provider === "OpenAI"
  && profile?.agentEngine === "codex"
  && /^codex(?:\.(?:exe|cmd|ps1))?$/iu.test(codexExecutableName(profile?.cliPath));

export const codexSettingsActionState = ({
  profile = {},
  saved = false,
  hasSavedCodexProfile = false,
  executionMode = "",
  agentEngine = "",
  codexCapability = {},
} = {}) => {
  const awaitingRunner = profile?.draft === true
    && saved !== true
    && ["agent", "both"].includes(String(executionMode || ""))
    && !String(agentEngine || "").trim();
  const savedCodexNeedsDetection = saved === true
    && codexCliProfile(profile)
    && codexCapability?.available !== true;
  return {
    showConnectCodex: (awaitingRunner && !hasSavedCodexProfile) || savedCodexNeedsDetection,
    showAddOpenCode: awaitingRunner,
    connectCodexDisabled: awaitingRunner && !hasSavedCodexProfile && codexCapability?.available !== true,
    connectCodexAction: savedCodexNeedsDetection ? "redetect" : "connect",
    connectCodexLabel: savedCodexNeedsDetection ? "重新检测 Codex CLI" : "连接当前 Codex CLI",
  };
};

export const shouldOfferDetectedCodexEntry = ({ capability = {}, profiles = [] } = {}) => capability?.available === true
  && !profiles.some(codexCliProfile);

export const detectedCodexTemporaryOption = (capability = {}) => ({
  id: DETECTED_CODEX_CONNECTION_ID,
  label: DETECTED_CODEX_CONNECTION_LABEL,
  temporary: true,
  provider: "OpenAI",
  adapter: "cli",
  agentEngine: "codex",
  credentialSource: "codex_session",
  executionMode: "agent",
  executionModes: ["agent"],
  model: String(capability.defaultModel || capability.models?.[0]?.slug || ""),
  cliPath: String(capability.cliPath || ""),
  cliArgs: String(capability.cliArgs || ""),
});

const availableCodexProfileId = (profiles = []) => {
  const ids = new Set(profiles.map((profile) => String(profile?.id || "")).filter(Boolean));
  if (!ids.has("text-default")) return "text-default";
  if (!ids.has("text-openai-codex-cli")) return "text-openai-codex-cli";
  let index = 2;
  while (ids.has(`text-openai-codex-cli-${index}`)) index += 1;
  return `text-openai-codex-cli-${index}`;
};

export const materializeDetectedCodexProfile = (settings = {}, capability = {}, { activate = true } = {}) => {
  const profiles = Array.isArray(settings.textConnections) ? settings.textConnections : [];
  const existing = profiles.find(codexCliProfile) || null;
  if (existing) {
    return {
      created: false,
      profile: existing,
      settings: activate ? {
        ...settings,
        activeTextConnectionId: existing.id,
        activeTextAgentConnectionId: existing.id,
      } : settings,
    };
  }
  if (capability?.available !== true || !String(capability.cliPath || "").trim()) {
    throw new Error("本机 Codex CLI 当前不可用，不能建立连接配置");
  }
  const modelOption = capability.models?.find((item) => item.slug === capability.defaultModel)
    || capability.models?.[0]
    || null;
  const id = availableCodexProfileId(profiles);
  const profile = {
    id,
    name: "Codex CLI Agent",
    remarkName: "",
    provider: "OpenAI",
    adapter: "cli",
    protocol: "responses",
    baseUrl: "",
    model: String(modelOption?.slug || capability.defaultModel || "gpt-5.6-sol"),
    reasoningEffort: String(modelOption?.defaultReasoningLevel || "medium"),
    speedMode: "default",
    temperature: "0.7",
    maxOutputTokens: "4000",
    timeoutMs: "600000",
    cliPath: String(capability.cliPath || ""),
    cliArgs: String(capability.cliArgs || ""),
    apiKey: "",
    executionMode: "agent",
    executionModes: ["agent"],
    agentEngine: "codex",
    credentialSource: "codex_session",
    agentModelId: String(modelOption?.slug || capability.defaultModel || ""),
  };
  const disabledBuiltInTextProfileIds = (Array.isArray(settings.disabledBuiltInTextProfileIds)
    ? settings.disabledBuiltInTextProfileIds
    : []).filter((profileId) => profileId !== "text-default" && profileId !== id);
  return {
    created: true,
    profile,
    settings: {
      ...settings,
      textConnections: [...profiles, profile],
      disabledBuiltInTextProfileIds,
      ...(activate ? {
        activeTextConnectionId: profile.id,
        activeTextAgentConnectionId: profile.id,
      } : {}),
    },
  };
};
