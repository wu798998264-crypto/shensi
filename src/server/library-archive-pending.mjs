const workspaceKey = (value = "") => String(value || "")
  .trim()
  .replaceAll("\\", "/")
  .toLocaleLowerCase("en-US");

const sameWorkspace = (left = "", right = "") => {
  const leftKey = workspaceKey(left);
  const rightKey = workspaceKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
};

export const clearPendingLibraryArchiveDecisions = ({
  pendingDecisions,
  fingerprint = "",
  workspacePath = "",
} = {}) => {
  const expectedFingerprint = String(fingerprint || "").trim();
  const expectedWorkspace = String(workspacePath || "").trim();
  if (!pendingDecisions || typeof pendingDecisions[Symbol.iterator] !== "function") return 0;
  if (!expectedFingerprint && !expectedWorkspace) return 0;

  let removed = 0;
  for (const [decisionId, decision] of pendingDecisions) {
    if (decision?.workflow !== "library_archive") continue;
    const payload = decision.workflowPayload || {};
    if (expectedFingerprint && String(payload.fingerprint || "").trim() !== expectedFingerprint) continue;
    if (expectedWorkspace && !sameWorkspace(payload.workspacePath, expectedWorkspace)) continue;
    pendingDecisions.delete(decisionId);
    removed += 1;
  }
  return removed;
};
