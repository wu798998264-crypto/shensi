import { isTaskContractComplete } from "./task-contract.js";

export const CREATIVE_TASK_STATES = Object.freeze([
  "queued", "resolving", "reading", "generating", "artifact_ready", "ready_to_commit", "committing", "verifying", "completed",
  "resolution_failed", "generation_failed", "artifact_invalid", "generated_not_landed", "commit_failed", "verification_failed", "cancelled",
]);

const transitions = new Map([
  ["queued", new Set(["resolving", "cancelled"])],
  ["resolving", new Set(["reading", "resolution_failed", "cancelled"])],
  ["reading", new Set(["generating", "resolution_failed", "cancelled"])],
  ["generating", new Set(["artifact_ready", "ready_to_commit", "artifact_invalid", "generation_failed", "cancelled"])],
  ["artifact_ready", new Set(["committing", "generated_not_landed", "cancelled"])],
  ["ready_to_commit", new Set(["committing", "cancelled"])],
  ["committing", new Set(["verifying", "commit_failed"])],
  ["verifying", new Set(["completed", "verification_failed"])],
]);

export const mayTransitionCreativeTask = (from, to) => transitions.get(String(from))?.has(String(to)) === true;
export const completedCreativeTask = ({ status, receipt, taskContract = null, documents = {}, backgroundActive = false } = {}) => {
  if (status !== "completed"
    || receipt?.verified !== true
    || Number(receipt?.failed || 0) !== 0
    || backgroundActive === true) return false;
  if (!taskContract) return true;
  return isTaskContractComplete({
    contract: taskContract,
    documents,
    receipts: Array.isArray(receipt?.results) ? receipt.results : [],
    requireVerifiedWrite: true,
  });
};
