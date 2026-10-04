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
  image: ["connectionId", "model", "aspectRatio"],
  video: ["connectionId", "model", "aspectRatio"],
  audio: ["connectionId", "model"],
});

export const DEFAULT_WHITEBOARD_MEDIA_ASPECT_RATIO = "16:9";
export const WHITEBOARD_MEDIA_ASPECT_RATIOS = Object.freeze([
  "21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16", "9:21",
]);

const normalizedAspectRatio = (value) => {
  const current = String(value ?? "").trim();
  if (current === "auto") return current;
  return WHITEBOARD_MEDIA_ASPECT_RATIOS.includes(current) ? current : "";
};

const normalizedValue = (field, value) => {
  const current = String(value ?? "").trim().slice(0, 300);
  if (field === "executionSurface") return ["chat", "agent"].includes(current) ? current : "";
  if (["speedMode", "agentSpeedMode"].includes(field)) return ["default", "fast", "flex"].includes(current) ? current : "default";
  if (field === "aspectRatio") return normalizedAspectRatio(current);
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
  const image = normalizeWhiteboardGenerationPreference("image", source.image);
  const video = normalizeWhiteboardGenerationPreference("video", source.video);
  const lastMediaAspectRatio = normalizedAspectRatio(source.lastMediaAspectRatio)
    || image.aspectRatio
    || video.aspectRatio
    || DEFAULT_WHITEBOARD_MEDIA_ASPECT_RATIO;
  return {
    ...Object.fromEntries(Object.keys(CHANNEL_FIELDS)
      .filter((channel) => !["image", "video"].includes(channel))
      .map((channel) => [channel, normalizeWhiteboardGenerationPreference(channel, source[channel])])),
    image,
    video,
    lastMediaAspectRatio,
  };
};

export const rememberWhiteboardGenerationPreference = (preferences = {}, channel, values = {}) => {
  const current = normalizeWhiteboardGenerationPreferences(preferences);
  const incoming = normalizeWhiteboardGenerationPreference(channel, values);
  const next = {
    ...current,
    ...(CHANNEL_FIELDS[channel] ? { [channel]: { ...current[channel], ...incoming } } : {}),
  };
  if (["image", "video"].includes(channel) && Object.hasOwn(incoming, "aspectRatio") && incoming.aspectRatio) {
    next.lastMediaAspectRatio = incoming.aspectRatio;
  }
  return next;
};
