const CHANNEL_FIELDS = Object.freeze({
  text: [
    "executionSurface",
    "connectionId",
    "model",
    "reasoningEffort",
    "speedMode",
    "agentEngine",
    "agentConnectionId",
    "agentModel",
    "agentReasoningEffort",
    "agentSpeedMode",
  ],
  image: ["connectionId", "model"],
  video: ["connectionId", "model"],
  audio: ["connectionId", "model"],
});

const normalizedValue = (field, value) => {
  const current = String(value ?? "").trim().slice(0, 300);
  if (field === "executionSurface") return ["chat", "agent"].includes(current) ? current : "";
  if (["speedMode", "agentSpeedMode"].includes(field)) return ["default", "fast", "flex"].includes(current) ? current : "default";
  return current;
};

export const normalizeWhiteboardGenerationPreference = (channel, value = {}) => {
  const fields = CHANNEL_FIELDS[channel] ?? [];
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
    .map((field) => [field, normalizedValue(field, source[field])]));
};

export const normalizeWhiteboardGenerationPreferences = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Object.keys(CHANNEL_FIELDS)
    .map((channel) => [channel, normalizeWhiteboardGenerationPreference(channel, source[channel])]));
};

export const rememberWhiteboardGenerationPreference = (preferences = {}, channel, values = {}) => ({
  ...normalizeWhiteboardGenerationPreferences(preferences),
  ...(CHANNEL_FIELDS[channel] ? { [channel]: normalizeWhiteboardGenerationPreference(channel, values) } : {}),
});
