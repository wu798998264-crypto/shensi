export const SHENSI_AGENT_DISPATCH_PROTOCOL = "shensi_agent_dispatch_v1";

const SHENSI_ORCHESTRATED_MODES = new Set([
  "creative",
  "creative_guidance",
  "visual_prompt",
  "quick_revision",
]);

export const compileAgentDispatchContract = (route = {}) => {
  const mode = String(route.mode || route.recommendedMode || "general");
  const shensiOrchestrated = route.shensiLed === true && SHENSI_ORCHESTRATED_MODES.has(mode);
  const executionOwner = shensiOrchestrated
    ? "shensi_orchestrator"
    : mode === "operation"
      ? "shensi_workspace_controller"
      : "workspace_agent";
  const commitDisposition = String(route.commitDisposition || route.taskPolicy?.commitDisposition || "no_artifact");
  const commitOwner = String(route.commitOwner || route.taskPolicy?.commitOwner || "none");
  const landingPolicy = commitOwner === "shensi_transaction"
    ? commitDisposition === "auto_commit"
      ? "agent_output_then_trusted_commit"
      : commitDisposition.startsWith("defer_")
        ? "candidate_then_trusted_commit"
        : "none"
    : executionOwner === "shensi_orchestrator"
      ? "no_direct_write"
    : executionOwner === "shensi_workspace_controller"
      ? "trusted_workspace_transaction"
      : executionOwner === "workspace_agent"
        ? "permissioned_workspace_write_with_verification"
        : "none";
  const completionAuthority = commitOwner === "shensi_transaction" && commitDisposition === "auto_commit"
    ? "managed_commit_result"
    : executionOwner === "workspace_agent"
    ? "runtime_terminal_state"
    : executionOwner === "shensi_workspace_controller"
      ? "transaction_result"
      : executionOwner === "shensi_orchestrator"
        ? "orchestrator_terminal_state"
      : "runtime_terminal_state";

  return {
    dispatchProtocol: SHENSI_AGENT_DISPATCH_PROTOCOL,
    reasoningOwner: String(route.reasoningOwner || route.taskPolicy?.reasoningOwner || "agent"),
    commitOwner,
    commitDisposition,
    executionOwner,
    contextTransport: "typed_content_blocks",
    landingPolicy,
    completionAuthority,
  };
};

export const routeUsesShensiOrchestrator = (route = {}) => {
  if (route?.executionOwner) return route.executionOwner === "shensi_orchestrator";
  const mode = String(route.mode || route.recommendedMode || "");
  return route?.shensiLed === true && SHENSI_ORCHESTRATED_MODES.has(mode);
};

export const routeUsesWorkspaceAgent = (route = {}) => route?.executionOwner === "workspace_agent"
  || (!route?.executionOwner && route?.shensiLed !== true && String(route.mode || route.recommendedMode || "general") !== "operation");
