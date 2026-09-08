export const MESSAGE_COLLAPSE_LIMITS = Object.freeze({
  user: Object.freeze({ characters: 420, lines: 8 }),
  assistant: Object.freeze({ characters: 900, lines: 12 }),
});

const text = (value = "") => String(value ?? "").trim();

export const conversationMessageCollapseSource = (message = {}) => {
  if (message?.role === "user") return text(message.content);
  const candidateDocuments = Array.isArray(message?.candidateDocuments)
    ? message.candidateDocuments.map((document) => text(document?.content)).filter(Boolean)
    : [];
  const landedDocuments = Array.isArray(message?.landedDocuments)
    ? message.landedDocuments.map((document) => text(document?.content)).filter(Boolean)
    : [];
  return [
    text(message?.content),
    text(message?.candidate),
    ...candidateDocuments,
    ...landedDocuments,
  ].filter(Boolean).join("\n\n");
};

export const conversationMessageNeedsCollapse = (message = {}) => {
  const role = message?.role === "user" ? "user" : "assistant";
  const source = conversationMessageCollapseSource({ ...message, role });
  const limits = MESSAGE_COLLAPSE_LIMITS[role];
  return source.length > limits.characters
    || source.split(/\r?\n/u).length > limits.lines;
};
