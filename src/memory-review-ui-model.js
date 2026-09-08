const list = (value) => Array.isArray(value) ? value : [];

const selectedSet = (value) => value instanceof Set ? new Set(value) : new Set(list(value));

export const memoryReviewCandidatesForPlan = (plan = null) => list(plan?.candidates);

export const memoryReviewCandidateEvidence = (candidate = {}) => list(candidate?.memoryUpdate?.evidence)
  .filter((item) => String(item?.quote || item?.claim || "").trim());

export const memoryReviewSelectableCandidates = (plan = null) => memoryReviewCandidatesForPlan(plan)
  .filter((candidate) => candidate.status === "proposal");

export const memoryReviewRecommendedCandidates = (plan = null) => memoryReviewSelectableCandidates(plan)
  .filter((candidate) => (
    memoryReviewCandidateEvidence(candidate).length > 0
    && ["missing", "stale", "unverified"].includes(candidate.reason)
  ));

export const memoryReviewUiSummary = ({ plan = null, selectedIds = new Set(), lastAdoption = null } = {}) => {
  const selected = selectedSet(selectedIds);
  const candidates = memoryReviewCandidatesForPlan(plan);
  const selectable = memoryReviewSelectableCandidates(plan);
  const recommended = memoryReviewRecommendedCandidates(plan);
  const selectedCount = selectable.filter((candidate) => selected.has(candidate.candidateId)).length;
  const evidenceReady = selectable.filter((candidate) => memoryReviewCandidateEvidence(candidate).length > 0).length;
  const riskCount = Number(plan?.health?.conflicts || 0) + Number(plan?.health?.stale || 0) + Number(plan?.health?.missing || 0) + Number(plan?.blocked || 0);
  const adopted = Number(lastAdoption?.committed || 0) + Number(lastAdoption?.alreadyCommitted || 0);
  return {
    candidates,
    selectable,
    recommended,
    selectedCount,
    evidenceReady,
    riskCount,
    adopted,
    recommendedSelected: recommended.length > 0 && recommended.every((candidate) => selected.has(candidate.candidateId)),
    requested: Number(plan?.requested || candidates.length),
    steps: {
      discovery: candidates.length ? "complete" : "current",
      evidence: evidenceReady === selectable.length && selectable.length ? "complete" : selectable.length ? "current" : "pending",
      risk: riskCount ? "current" : "complete",
      adoption: adopted ? "complete" : selectedCount ? "current" : "pending",
    },
  };
};

export const toggleRecommendedMemorySelection = ({ plan = null, selectedIds = new Set() } = {}) => {
  const selected = selectedSet(selectedIds);
  const recommended = memoryReviewRecommendedCandidates(plan);
  const recommendedIds = new Set(recommended.map((candidate) => candidate.candidateId));
  const allSelected = recommended.length > 0 && recommended.every((candidate) => selected.has(candidate.candidateId));
  return allSelected
    ? new Set([...selected].filter((candidateId) => !recommendedIds.has(candidateId)))
    : new Set([...selected, ...recommendedIds]);
};
