const normalizedIdentity = (value) => String(value || "").trim();

export const selectPendingAgentMessage = (candidates = [], {
  conversationId = "",
  turnId = "",
  messageId = "",
  requestId = "",
} = {}) => {
  const normalizedConversationId = normalizedIdentity(conversationId);
  const normalizedTurnId = normalizedIdentity(turnId);
  const normalizedMessageId = normalizedIdentity(messageId);
  const normalizedRequestId = normalizedIdentity(requestId);
  const hasRunIdentity = Boolean(normalizedTurnId || normalizedMessageId || normalizedRequestId);
  const exact = candidates.find(({ message }) => (
    (normalizedMessageId && message.id === normalizedMessageId)
    || (normalizedTurnId && message.execution?.agentTurnId === normalizedTurnId)
    || (normalizedRequestId && message.execution?.sourceMessageId === normalizedRequestId)
  ));
  if (exact || hasRunIdentity) return exact ?? null;
  return candidates.find(({ conversation }) => conversation.id === normalizedConversationId)
    ?? candidates[0]
    ?? null;
};
