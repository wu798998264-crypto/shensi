export const executionModeCapabilities = (profile = {}, { existing = false } = {}) => {
  if (existing) return {
    modes: ["agent"],
    source: "unified_agent_runtime",
    reasons: { chat: "文字配置统一由 Agent 运行器按需处理", both: "不再提供独立 Chat 模式" },
  };

  return {
    modes: ["agent"],
    source: "unified_agent_runtime",
    reasons: { chat: "文字配置统一由 Agent 运行器按需处理", both: "不再提供独立 Chat 模式" },
  };
};

export const executionModeOptionState = (profile = {}, options = {}) => {
  const capability = executionModeCapabilities(profile, options);
  const available = new Set(capability.modes);
  return {
    ...capability,
    options: {
      chat: { enabled: available.has("chat"), reason: available.has("chat") ? "" : capability.reasons.chat || "当前连接不支持 Chat" },
      agent: { enabled: available.has("agent"), reason: available.has("agent") ? "" : capability.reasons.agent || "当前连接不支持 Agent" },
      both: {
        enabled: available.has("chat") && available.has("agent"),
        reason: available.has("chat") && available.has("agent") ? "" : capability.reasons.both || "当前连接没有同时实现 Chat 与 Agent",
      },
    },
  };
};

export const modeValueForCapabilities = (requested = "", capability = {}) => {
  return "agent";
};
