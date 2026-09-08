const clean = (value = "") => String(value || "").trim();

export const agentContextCompactionPlan = ({
  agentEngine = "",
  nativeCompaction = false,
  checkpointAvailable = true,
} = {}) => ({
  owner: "current_agent",
  agentEngine: clean(agentEngine) || "current",
  strategy: nativeCompaction ? "agent_native" : "verified_incremental_capsule",
  fallback: checkpointAvailable ? "verified_incremental_capsule" : "source_messages",
  blockOnFailure: false,
  duplicateConversationContext: false,
});

export const contextCompactionFailureDecision = ({ sourceMessagesAvailable = true } = {}) => ({
  continue: true,
  source: sourceMessagesAvailable ? "source_messages" : "current_instruction_and_document",
  warningOnly: true,
});
