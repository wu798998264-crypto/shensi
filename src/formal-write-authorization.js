import { sha256HexSync } from "./version-integrity.js";
import { taskContractWriteAction, validateTaskContractForExecution } from "./task-contract.js";

const clean = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n").trim();

const uniqueStrings = (values = []) => [...new Set((Array.isArray(values) ? values : [values])
  .map(clean)
  .filter(Boolean))].sort((left, right) => left.localeCompare(right));

const normalizedRevisions = (value = {}, documentIds = []) => {
  if (Array.isArray(value)) {
    return Object.fromEntries(uniqueStrings(documentIds).map((id, index) => [id, clean(value[index])]));
  }
  if (!value || typeof value !== "object") return {};
  const source = Object.fromEntries(Object.entries(value).map(([id, revision]) => [clean(id), clean(revision)]).filter(([id]) => id));
  return Object.fromEntries(uniqueStrings(documentIds.length ? documentIds : Object.keys(source)).map((id) => [id, source[id] ?? ""]));
};

const stableHash = (value = "") => {
  return sha256HexSync(clean(value));
};

export const formalWriteInstructionHash = (instruction = "") => stableHash(instruction);
export const formalWriteCandidateHash = (candidate = "") => stableHash(candidate);

const noAuthorization = ({ instruction = "", sourceMessageId = "", targetDocumentIds = [], expectedRevisions = {}, reason = "not_explicitly_authorized" } = {}) => ({
  state: "none",
  action: "analyze",
  sourceMessageId: clean(sourceMessageId),
  sourceInstructionHash: formalWriteInstructionHash(instruction),
  targetDocumentIds: uniqueStrings(targetDocumentIds),
  expectedRevisions: normalizedRevisions(expectedRevisions, targetDocumentIds),
  allowBodyMutation: false,
  allowTitleMutation: false,
  reason,
});

const WRITE_ACTIONS = new Set(["append", "patch", "replace", "rename", "create"]);

export const createFormalWriteAuthorization = ({
  instruction = "", sourceMessageId = "", targetDocumentIds = [], expectedRevisions = {},
  targetExists = true, targetTitle = "", contextualWriteAction = "",
  candidate = "", candidateAuthorization = null, adoptCandidate = false,
  taskContract = null, semanticWritePlan = null,
} = {}) => {
  const decision = validateTaskContractForExecution(taskContract);
  const contractDeliverables = decision.authoritative ? (taskContract?.deliverables || []).filter(item => item.required !== false) : [];
  const contractIds = contractDeliverables.map(item => item.targetDocumentId || item.targetDocument || item.target?.documentId).filter(Boolean);
  const ids = uniqueStrings(contractIds.length ? contractIds : targetDocumentIds);
  const revisions = normalizedRevisions(expectedRevisions, ids);
  const base = { instruction, sourceMessageId, targetDocumentIds: ids, expectedRevisions: revisions };
  if (!clean(sourceMessageId)) return noAuthorization({ ...base, reason: "missing_source_message" });
  if (decision.authoritative && !decision.valid) return noAuthorization({ ...base, reason: "invalid_task_contract" });
  const explicitAction = WRITE_ACTIONS.has(contextualWriteAction) ? contextualWriteAction : "";
  const semanticIntent = ["none", "candidate", "commit"].includes(semanticWritePlan?.intent) ? semanticWritePlan.intent : "";
  const intent = semanticIntent || (decision.authoritative
    ? decision.persistence === "commit" ? "commit" : decision.persistence === "candidate_only" ? "candidate" : "none"
    : explicitAction || adoptCandidate ? "commit" : "none");
  if (intent === "none") return noAuthorization({ ...base, reason: "agent_semantic_no_write" });
  if (!ids.length) return noAuthorization({ ...base, reason: "agent_semantic_target_unresolved" });
  if (adoptCandidate) {
    const proof = validateFormalWriteAuthorization(candidateAuthorization, { requiredState: "candidate_only", candidate, targetDocumentIds: ids, expectedRevisions: revisions });
    if (!candidate || !proof.valid) return noAuthorization({ ...base, reason: `candidate_adoption_${proof.reason || "missing_content"}` });
  }
  const selectedAction = WRITE_ACTIONS.has(semanticWritePlan?.operation) ? semanticWritePlan.operation
    : explicitAction || (decision.authoritative ? taskContractWriteAction(taskContract) : adoptCandidate ? candidateAuthorization.action : targetExists ? "replace" : "create");
  const action = selectedAction === "generate" ? targetExists ? "replace" : "create" : selectedAction;
  if (!WRITE_ACTIONS.has(action)) return noAuthorization({ ...base, reason: "invalid_write_operation" });
  const state = intent === "candidate" ? "candidate_only" : "commit";
  return {
    state, action, sourceMessageId: clean(sourceMessageId), sourceInstructionHash: formalWriteInstructionHash(instruction),
    targetDocumentIds: ids, expectedRevisions: revisions,
    ...(adoptCandidate ? { candidateHash: formalWriteCandidateHash(candidate) } : {}),
    allowBodyMutation: state === "commit" && action !== "rename",
    allowTitleMutation: state === "commit" && (["rename", "create"].includes(action) || Boolean(targetTitle) || contractDeliverables.some(item => clean(item.title))),
    reason: adoptCandidate ? "explicit_candidate_adoption" : decision.authoritative
      ? intent === "candidate" ? "task_contract_candidate_only" : "task_contract_formal_delivery"
      : `agent_semantic_${intent}`,
    ...(decision.authoritative ? { contractId: clean(taskContract.contractId), contractRevision: Math.max(1, Number(taskContract.revision) || 1) } : {}),
  };
};

export const bindFormalWriteCandidate = (authorization = null, {
  candidate = "",
  targetDocumentIds = null,
  expectedRevisions = null,
} = {}) => {
  if (!authorization || authorization.state === "none" || !clean(candidate)) return authorization;
  const ids = uniqueStrings(targetDocumentIds ?? authorization.targetDocumentIds);
  const revisions = normalizedRevisions(expectedRevisions ?? authorization.expectedRevisions, ids);
  const targetCheck = validateFormalWriteAuthorization(authorization, { targetDocumentIds: ids, expectedRevisions: revisions });
  if (!targetCheck.valid) return noAuthorization({
    instruction: "",
    sourceMessageId: authorization.sourceMessageId,
    targetDocumentIds: ids,
    expectedRevisions: revisions,
    reason: targetCheck.reason,
  });
  return { ...authorization, candidateHash: formalWriteCandidateHash(candidate), targetDocumentIds: ids, expectedRevisions: revisions };
};

export const rebaseFormalWriteAuthorization = (authorization = null, {
  expectedRevisions = {},
  reason = "latest_document_reloaded",
} = {}) => {
  if (!authorization || !["candidate_only", "commit"].includes(authorization.state)) return authorization;
  const ids = uniqueStrings(authorization.targetDocumentIds);
  const revisions = normalizedRevisions(expectedRevisions, ids);
  return {
    ...authorization,
    expectedRevisions: revisions,
    reason: clean(reason) || authorization.reason,
    ...(authorization.candidateHash ? { candidateHash: undefined } : {}),
  };
};

export const validateFormalWriteAuthorization = (authorization = null, {
  requiredState = "",
  sourceMessageId = "",
  instruction = "",
  candidate = "",
  targetDocumentIds = null,
  expectedRevisions = null,
  requireBodyMutation = false,
  requireTitleMutation = false,
} = {}) => {
  if (!authorization || typeof authorization !== "object") return { valid: false, reason: "missing_authorization" };
  if (!new Set(["none", "candidate_only", "commit"]).has(authorization.state)) return { valid: false, reason: "invalid_state" };
  if (authorization.state === "none") return { valid: false, reason: "authorization_denied" };
  if (requiredState && authorization.state !== requiredState) return { valid: false, reason: "state_mismatch" };
  if (!clean(authorization.sourceMessageId)) return { valid: false, reason: "missing_source_message" };
  if (sourceMessageId && clean(sourceMessageId) !== clean(authorization.sourceMessageId)) return { valid: false, reason: "source_message_mismatch" };
  if (instruction && formalWriteInstructionHash(instruction) !== authorization.sourceInstructionHash) return { valid: false, reason: "instruction_hash_mismatch" };
  const expectedIds = uniqueStrings(targetDocumentIds ?? authorization.targetDocumentIds);
  if (JSON.stringify(expectedIds) !== JSON.stringify(uniqueStrings(authorization.targetDocumentIds))) return { valid: false, reason: "target_mismatch" };
  const expectedRevisionMap = normalizedRevisions(expectedRevisions ?? authorization.expectedRevisions, expectedIds);
  if (JSON.stringify(expectedRevisionMap) !== JSON.stringify(normalizedRevisions(authorization.expectedRevisions, expectedIds))) return { valid: false, reason: "revision_mismatch" };
  if (candidate) {
    if (!authorization.candidateHash) return { valid: false, reason: "missing_candidate_hash" };
    if (formalWriteCandidateHash(candidate) !== authorization.candidateHash) return { valid: false, reason: "candidate_hash_mismatch" };
  }
  if (requireBodyMutation && authorization.allowBodyMutation !== true) return { valid: false, reason: "body_mutation_not_authorized" };
  if (requireTitleMutation && authorization.allowTitleMutation !== true) return { valid: false, reason: "title_mutation_not_authorized" };
  return { valid: true, reason: "authorized" };
};
