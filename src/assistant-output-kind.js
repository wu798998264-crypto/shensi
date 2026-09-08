import { requestsMultipleCandidates } from "./agent-task-policy.js";
import { validateTaskContractForExecution } from "./task-contract.js";

const text = (value = "") => String(value ?? "").trim();

export const classifyAssistantOutput = ({
  instruction = "",
  route = null,
  result = null,
  candidateCount = 0,
} = {}) => {
  const taskContract = route?.taskContract ?? route?.taskPolicy?.taskContract ?? null;
  const contractDecision = validateTaskContractForExecution(taskContract);
  if (contractDecision.authoritative
    && (!contractDecision.valid || contractDecision.persistence === "none" || contractDecision.deliverables.length === 0)) {
    return { kind: "discussion", landingEligible: false, reason: "task_contract_has_no_artifact" };
  }
  const authorization = result?.writeAuthorization
    ?? route?.writeAuthorization
    ?? route?.taskPolicy?.writeAuthorization
    ?? null;
  const candidate = text(result?.candidate);
  const count = Math.max(
    Number(candidateCount) || 0,
    Array.isArray(result?.candidateDocuments) ? result.candidateDocuments.length : 0,
  );
  if (authorization?.state === "candidate_only" || count > 1 || requestsMultipleCandidates(instruction)) {
    return { kind: "candidate_group", landingEligible: false, reason: "explicit_candidate_request" };
  }
  if (authorization?.state === "commit" && candidate) {
    return { kind: "formal_artifact", landingEligible: true, reason: "authorized_formal_content" };
  }
  return { kind: "discussion", landingEligible: false, reason: candidate ? "candidate_without_commit" : "no_formal_artifact" };
};
