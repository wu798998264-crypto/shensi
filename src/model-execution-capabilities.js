export const executionModeCapabilities = () => ({
  modes: ["agent"],
  source: "unified_agent_runtime",
  reasons: { agent: "所有文字任务统一由 Agent 运行器处理" },
});

export const executionModeOptionState = (profile = {}, options = {}) => {
  const capability = executionModeCapabilities(profile, options);
  return {
    ...capability,
    options: { agent: { enabled: true, reason: "" } },
  };
};

export const modeValueForCapabilities = () => "agent";
