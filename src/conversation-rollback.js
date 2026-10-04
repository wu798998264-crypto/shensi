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

const ROLLBACK_TOMBSTONE_LIMIT = 512;

const cloneValue = (value) => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

export const conversationRollbackSessionKeys = () => [...ROLLBACK_SESSION_KEYS];

const normalizedIds = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => String(value || "").trim())
  .filter(Boolean))];

export const conversationRollbackRevision = (conversation = {}) => Math.max(0, Number(conversation?.rollbackRevision) || 0);

export const conversationRollbackTombstones = (conversation = {}) => ({
  messageIds: normalizedIds(conversation?.rollbackTombstones?.messageIds),
  queueIds: normalizedIds(conversation?.rollbackTombstones?.queueIds),
});

// A rollback is a destructive timeline operation.  The revision and bounded
// tombstones make that deletion durable across an in-flight save or a late
// provider completion, instead of allowing the older writer to merge the
// removed task back into the conversation.
export const recordConversationRollback = (conversation = {}, {
  messageIds = [],
  queueIds = [],
  at = Date.now(),
} = {}) => {
  const previous = conversationRollbackTombstones(conversation);
  conversation.rollbackRevision = conversationRollbackRevision(conversation) + 1;
  conversation.rollbackTombstones = {
    messageIds: [...new Set([...previous.messageIds, ...normalizedIds(messageIds)])].slice(-ROLLBACK_TOMBSTONE_LIMIT),
    queueIds: [...new Set([...previous.queueIds, ...normalizedIds(queueIds)])].slice(-ROLLBACK_TOMBSTONE_LIMIT),
    recordedAt: Math.max(1, Number(at) || Date.now()),
  };
  return conversation.rollbackRevision;
};

export const rollbackTombstoneSet = (conversation = {}, key = "messageIds") => new Set(
  conversationRollbackTombstones(conversation)[key === "queueIds" ? "queueIds" : "messageIds"],
);

export const filterConversationRollbackMessages = (messages = [], conversation = {}) => {
  const tombstones = rollbackTombstoneSet(conversation, "messageIds");
  return (Array.isArray(messages) ? messages : []).filter((message) => !tombstones.has(String(message?.id || "")));
};

export const filterConversationRollbackQueue = (queue = [], conversation = {}) => {
  const tombstones = rollbackTombstoneSet(conversation, "queueIds");
  return (Array.isArray(queue) ? queue : []).filter((item) => !tombstones.has(String(item?.id || "")));
};

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
