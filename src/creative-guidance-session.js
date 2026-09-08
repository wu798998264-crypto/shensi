const text = (value = "", max = 240) => String(value ?? "").trim().slice(0, max);

const objectState = (value) => (
  value && typeof value === "object" && !Array.isArray(value) ? value : null
);

export const creativeGuidanceSessionMessages = ({
  messages = [],
  sessionId = "",
  session = null,
} = {}) => {
  const source = Array.isArray(messages) ? messages : [];
  const id = text(sessionId || session?.sessionId, 160);
  if (!id) return [...source];
  const tagged = source.filter((message) => text(message?.guidanceSessionId, 160) === id);
  if (tagged.length) return tagged;
  if (text(session?.sessionId, 160) !== id) return [];
  const startIndex = Number(session?.startIndex);
  return Number.isInteger(startIndex) && startIndex >= 0
    ? source.slice(Math.min(startIndex, source.length))
    : [];
};

export const latestCreativeGuidanceSessionState = ({
  messages = [],
  sessionId = "",
  session = null,
} = {}) => {
  const selected = creativeGuidanceSessionMessages({ messages, sessionId, session });
  const messageState = [...selected].reverse().find((message) => (
    message?.role === "assistant" && objectState(message?.execution?.guidanceState)
  ))?.execution?.guidanceState;
  return objectState(messageState) || objectState(session?.guidanceState);
};

export const creativeGuidanceChoiceContinuation = ({
  pending = null,
  option = null,
  fallbackConversationId = "",
  fallbackSessionId = "",
} = {}) => {
  const content = text(option?.label || option?.value, 1200);
  const conversationId = text(pending?.conversationId || fallbackConversationId, 160);
  const guidanceSessionId = text(pending?.guidanceSessionId || fallbackSessionId, 160);
  if (!content || !conversationId) return null;
  return {
    content,
    conversationId,
    guidanceSessionId,
    guidanceDialog: Boolean(guidanceSessionId),
  };
};
