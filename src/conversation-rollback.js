const ROLLBACK_SESSION_KEYS = Object.freeze([
  "currentCandidate",
  "currentCandidateTarget",
  "currentCandidateMemoryUpdate",
]);

const ACTIVE_CONVERSATION_STATE_KEYS = Object.freeze([
  "messages",
  "snapshots",
  "isolatedBranches",
  "currentCandidate",
  "currentCandidateTarget",
  "currentCandidateMemoryUpdate",
]);

const cloneValue = (value) => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

export const conversationRollbackSessionKeys = () => [...ROLLBACK_SESSION_KEYS];

export const captureEphemeralConversationRollbackBaseline = (conversation = {}) => cloneValue(conversation);

export const persistableStateWithoutEphemeralConversationRollbacks = (state = {}, baselines = new Map()) => {
  const baselineEntries = baselines instanceof Map ? [...baselines.entries()] : Object.entries(baselines ?? {});
  if (!baselineEntries.length) return state;
  const baselineByConversationId = new Map(baselineEntries.filter(([conversationId, conversation]) => conversationId && conversation));
  const conversations = (state.conversations ?? []).map((conversation) => (
    baselineByConversationId.has(conversation.id)
      ? cloneValue(baselineByConversationId.get(conversation.id))
      : conversation
  ));
  const activeBaseline = baselineByConversationId.get(state.activeConversationId);
  if (!activeBaseline) return { ...state, conversations };
  const persistable = { ...state, conversations };
  for (const key of ACTIVE_CONVERSATION_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(activeBaseline, key)) persistable[key] = cloneValue(activeBaseline[key]);
  }
  return persistable;
};

// A conversation rollback may restore only transient conversation context.
// Documents, directory placement, histories, trash and workspace settings are
// deliberately not copied from legacy snapshots, even when those fields exist.
export const conversationRollbackPatch = (snapshot = {}) => {
  const patch = {};
  for (const key of ROLLBACK_SESSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) patch[key] = cloneValue(snapshot[key]);
  }
  return patch;
};
