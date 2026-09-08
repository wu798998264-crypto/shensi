// Conversation history remains fully persisted. Only the DOM window is
// bounded so a months-long conversation does not make every UI update slower.
export const DEFAULT_CONVERSATION_DISPLAY_LIMIT = 96;
export const CONVERSATION_DISPLAY_BATCH = 96;

const normalizedLimit = (value) => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return DEFAULT_CONVERSATION_DISPLAY_LIMIT;
  return Math.max(DEFAULT_CONVERSATION_DISPLAY_LIMIT, numeric);
};

export const conversationDisplayWindow = (messages = [], { limit = DEFAULT_CONVERSATION_DISPLAY_LIMIT } = {}) => {
  const source = Array.isArray(messages) ? messages : [];
  const effectiveLimit = normalizedLimit(limit);
  let startIndex = Math.max(0, source.length - effectiveLimit);
  // Do not open a visible page with an orphaned answer when its user turn is
  // immediately before the boundary.
  if (startIndex > 0 && source[startIndex]?.role === "assistant" && source[startIndex - 1]?.role === "user") {
    startIndex -= 1;
  }
  return {
    messages: source.slice(startIndex),
    startIndex,
    omittedCount: startIndex,
    hasOlder: startIndex > 0,
    visibleCount: source.length - startIndex,
    nextLimit: Math.min(source.length, effectiveLimit + CONVERSATION_DISPLAY_BATCH),
  };
};
