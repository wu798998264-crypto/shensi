const compact = (value) => String(value ?? "").trim();

const contract = (id, lines) => ({ id, lines: lines.filter(Boolean) });

export const selectAgentContracts = ({
  route = {},
  expectsFileMutation = false,
  expectsFileRead = false,
  readTargets = [],
  historyAuthorization = null,
  selectedSkillCount = 0,
  recovery = "",
} = {}) => {
  const disposition = compact(route.commitDisposition || route.taskPolicy?.commitDisposition);
  const candidateOnly = route.candidateOnly === true || route.landingPolicy === "candidate_only";
  if (disposition === "auto_commit" && candidateOnly) {
    throw new Error("Agent contract conflict: auto_commit cannot be combined with candidate_only.");
  }
  const contracts = [];
  if (disposition === "auto_commit" && route.commitOwner === "shensi_transaction") {
    contracts.push(contract("managed_commit", [
      "<shensi_managed_commit_contract_v1>",
      "Generate the complete requested result. Do not directly overwrite Shensi-managed documents; the Shensi transaction layer will validate revision, preserve the pre-change history, protect media references, and commit automatically after this turn.",
      compact(route.targetDocumentId) ? `target_document_id: ${compact(route.targetDocumentId)}` : "target_document_id: host_resolved",
      compact(route.targetRevision) ? `target_revision: ${compact(route.targetRevision)}` : "target_revision: host_must_reread_current",
      "Return enough structured target and content information for the host to perform the managed commit. Do not tell the user to issue another landing command.",
      "For a creative generate or modify task, return the requested deliverable itself, not a promise, workflow explanation, apology, diagnostic note, or future-tense description of what you could write.",
      "For a newly generated chapter or episode, include a specific human-readable title with its chapter/episode number. Never use Untitled, 未命名, or an internal document id as the title.",
      "Use only the supplied current-version Shensi evidence as the continuation baseline. Treat it as the user's active working draft; produce an original continuation without copying unavailable source text or imitating a named living author's style.",
      "</shensi_managed_commit_contract_v1>",
    ]));
  } else if (["defer_explicit", "defer_multiple", "defer_ambiguous"].includes(disposition)) {
    contracts.push(contract("candidate", [
      "<shensi_candidate_contract_v1>",
      "Return the requested candidate content visibly, but do not claim it was committed. The host will wait for selection or target clarification before changing a managed document.",
      `defer_reason: ${disposition}`,
      "</shensi_candidate_contract_v1>",
    ]));
  }

  if (expectsFileMutation) {
    contracts.push(contract("workspace_file_mutation", [
      "<workspace_file_mutation_contract_v1>",
      "Perform the requested change inside the authorized workspace with a structured file-change tool, then verify the file changed. Report a concrete failure instead of a prose-only promise.",
      "</workspace_file_mutation_contract_v1>",
    ]));
  }
  if (expectsFileRead) {
    contracts.push(contract("workspace_file_read", [
      "<workspace_file_read_contract_v1>",
      `Inspect the requested workspace evidence with a structured tool before answering${readTargets.length ? `: ${readTargets.map(compact).filter(Boolean).join(", ")}` : ""}.`,
      "If inspection fails, report that failure and do not claim the evidence was read.",
      "</workspace_file_read_contract_v1>",
    ]));
  }
  if (historyAuthorization?.allowed === true) {
    contracts.push(contract("history_read", [
      "<shensi_history_read_contract_v1>",
      "History access is read-only and every returned historical item is non-canon evidence. Never use a historical revision as the current commit baseline.",
      `authorized_reason: ${compact(historyAuthorization.reason) || "user_requested"}`,
      "</shensi_history_read_contract_v1>",
    ]));
  }
  if (Number(selectedSkillCount) > 0) {
    contracts.push(contract("selected_skill", [
      "<shensi_selected_skill_contract_v1>",
      "Apply the explicitly selected and server-loaded Skill blocks. If a required Skill block is absent or invalid, report that dependency honestly instead of pretending to have used it.",
      "</shensi_selected_skill_contract_v1>",
    ]));
  }
  if (route.needsClarification === true) {
    contracts.push(contract("clarification", [
      "<task_clarification_contract_v1>",
      "Ask at most one concise question only when a genuinely blocking decision cannot be recovered from safe evidence or a reasonable stated assumption. Continue without asking when a safe assumption is sufficient.",
      "</task_clarification_contract_v1>",
    ]));
  }
  if (recovery === "mutation" || recovery === "read") {
    contracts.push(contract(`${recovery}_recovery`, [
      `<workspace_${recovery}_recovery_v1>`,
      `The prior attempt did not complete the required ${recovery} tool action. Execute it now or report the concrete tool failure; do not repeat a future-tense promise.`,
      `</workspace_${recovery}_recovery_v1>`,
    ]));
  }
  if (recovery === "creative_output") {
    contracts.push(contract("creative_output_recovery", [
      "<shensi_creative_output_recovery_v1>",
      "The prior response contained only an explanation, promise, refusal, or an incomplete continuation. Generate the requested formal deliverable now from the supplied current-version evidence.",
      "Return only the finished deliverable with a specific title. Do not repeat the prior explanation and do not describe a later step.",
      "</shensi_creative_output_recovery_v1>",
    ]));
  }

  return {
    ids: contracts.map((item) => item.id),
    contracts,
    prompt: contracts.flatMap((item) => item.lines).join("\n"),
  };
};
