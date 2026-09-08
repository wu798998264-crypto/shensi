const text = (value = "", max = 4000) => String(value ?? "").trim().slice(0, max);

export const normalizeAgentDecisionResolution = (value = null) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decisionId = text(value.decisionId, 180);
  const taskId = text(value.taskId, 180);
  const contractRevision = Math.max(1, Number(value.contractRevision) || 1);
  const optionId = text(value.optionId, 100);
  const answer = text(value.answer, 4000);
  if (!decisionId || !taskId || (!optionId && !answer)) return null;
  return {
    decisionId,
    taskId,
    contractRevision,
    ...(optionId ? { optionId } : {}),
    ...(answer ? { answer } : {}),
  };
};

export const agentDecisionResolutionForOption = ({ decision = null, option = null } = {}) => {
  if (!decision || !option) return null;
  return normalizeAgentDecisionResolution({
    decisionId: decision.id,
    taskId: decision.taskId,
    contractRevision: decision.contractRevision,
    optionId: option.id,
    answer: option.label,
  });
};

export const agentDecisionResolutionForAnswer = ({ decision = null, answer = "" } = {}) => {
  if (!decision) return null;
  return normalizeAgentDecisionResolution({
    decisionId: decision.id,
    taskId: decision.taskId,
    contractRevision: decision.contractRevision,
    answer,
  });
};

export const isAgentDecision = (value = null) => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && text(value.id, 180)
  && text(value.taskId, 180)
  && text(value.question, 1000),
);
