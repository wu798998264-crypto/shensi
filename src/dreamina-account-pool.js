const finiteCredit = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export const rankDreaminaAccountCandidates = (candidates = []) => (Array.isArray(candidates) ? candidates : [])
  .map((candidate, index) => {
    const credit = finiteCredit(candidate?.credit);
    const estimatedCredit = Math.max(0, Number(candidate?.estimatedCredit) || 0);
    const eligible = candidate?.eligible !== false
      && credit !== null
      && (estimatedCredit > 0 ? credit >= estimatedCredit : credit > 0);
    return { ...candidate, credit, estimatedCredit, eligible, poolOrder: index };
  })
  .filter((candidate) => candidate.eligible)
  .sort((left, right) => right.credit - left.credit || left.poolOrder - right.poolOrder);

export const selectDreaminaAccountCandidate = (candidates = []) => rankDreaminaAccountCandidates(candidates)[0] || null;
