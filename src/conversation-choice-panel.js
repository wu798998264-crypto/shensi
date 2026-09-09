export const conversationChoiceUserInstruction = ({ label = "", value = "" } = {}) => (
  String(label || value || "").trim()
);

// A choice panel is opened only from an explicit structured Agent event. Text
// displayed in a reply is never parsed for options or task type keywords.
export const assistantChoicePrompt = () => null;

// Retained for stored pre-refactor guidance records. New conversation choices
// are emitted by interaction.ask in the unified Agent runtime.
export const structuredCreativeGuidanceChoice = (execution = {}) => {
  const state = execution?.guidanceState;
  if (!state || state.interactionMode !== "choice_fallback") return null;
  const options = (Array.isArray(state.candidateOptions) ? state.candidateOptions : [])
    .filter((option) => option && typeof option === "object" && String(option.label || "").trim())
    .slice(0, 3);
  if (options.length < 2) return null;
  return {
    question: String(execution.choiceQuestion || state.pendingReflectionQuestion || "请选择更接近你当前判断的方向。").trim(),
    options,
  };
};
