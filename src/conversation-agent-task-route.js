const text = (value) => String(value ?? "").trim();

export const CONVERSATION_AGENT_TASK_LABELS = Object.freeze({
  creative_guidance: "创作引导",
  formal_creation: "正式创作",
  writing: "正式创作",
  content_generation: "正式创作",
  general_qa: "普通问答",
  discussion: "普通问答",
  quality_review: "内容质检",
  diagnosis: "内容质检",
  software_operation: "软件操作",
  operation: "软件操作",
  image_generation: "图片生成",
  video_generation: "视频生成",
  multi_step: "复合任务",
});

const mediaTaskType = (channel) => channel === "video" ? "video_generation" : channel === "image" ? "image_generation" : "";

export const agentTaskRouteFromMediaDispatch = (dispatch = null) => {
  if (!dispatch || typeof dispatch !== "object") return null;
  if (dispatch.kind === "media") {
    const taskKind = mediaTaskType(dispatch.channel);
    return taskKind ? { mode: "media", taskKind, direct: true } : null;
  }
  if (dispatch.kind !== "composite" || !Array.isArray(dispatch.steps)) return null;
  const taskKinds = [...new Set(dispatch.steps.map((step) => mediaTaskType(step?.channel || step?.kind)).filter(Boolean))];
  if (!taskKinds.length) return null;
  return {
    mode: "agent",
    taskKind: taskKinds.length === 1 ? taskKinds[0] : "multi_step",
    direct: true,
  };
};

export const agentTaskRouteFromDelivery = (payload = {}) => {
  const mode = text(payload.mode);
  const mediaChannels = Array.isArray(payload.mediaChannels) ? payload.mediaChannels.map(text).filter(Boolean) : [];
  const explicitTaskType = text(payload.taskType);
  const inferredTaskType = mode === "media"
    ? mediaChannels.length === 1 ? mediaTaskType(mediaChannels[0]) : "multi_step"
    : "";
  const taskKind = explicitTaskType || inferredTaskType;
  if (!taskKind) return null;
  return {
    mode: taskKind === "creative_guidance" ? "creative_guidance" : mode || "agent",
    taskKind,
    direct: ["image_generation", "video_generation"].includes(taskKind),
  };
};

export const nativeAgentTaskWayLabel = ({ execution = {}, guided = false, qualityReview = false } = {}) => {
  if (guided) return "创作引导";
  if (qualityReview) return "内容质检";
  const route = execution.taskRoute && typeof execution.taskRoute === "object" ? execution.taskRoute : {};
  const taskKind = text(route.taskKind || route.taskType || route.intentEnvelope?.taskType);
  return CONVERSATION_AGENT_TASK_LABELS[taskKind]
    || (route.mode === "creative_guidance" || route.requestMode === "creative_guidance" ? "创作引导" : "Agent 执行");
};
