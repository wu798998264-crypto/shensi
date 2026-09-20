import { sanitizeConversationOutput, sanitizeUserFacingError } from "./conversation-output-guard.js";
const text = (value) => String(value ?? "").trim();

const uniqueText = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .map(text)
  .filter(Boolean))];

const terminalIssueLabel = (status = "") => ({
  failed: "任务失败",
  interrupted: "任务已中断",
  cancelled: "任务已取消",
  canceled: "任务已取消",
}[text(status).toLowerCase()] || "任务未完成");

export const nativeAgentTerminalPresentation = ({
  status = "",
  text: finalText = "",
  error = "",
  partialText = "",
  pendingWarnings = [],
  resultWarnings = [],
} = {}) => {
  const normalizedStatus = text(status).toLowerCase();
  const warnings = uniqueText([...pendingWarnings, ...resultWarnings]
    .map((warning) => sanitizeConversationOutput(warning)));
  const partial = text(partialText);
  if (normalizedStatus === "completed") {
    const visibleFinalText = sanitizeConversationOutput(finalText) || sanitizeConversationOutput(partial) || "Agent 已完成任务。";
    return {
      status: warnings.length ? "soft_warning" : "complete",
      content: visibleFinalText,
      error: "",
      result: warnings.length ? "结果已交付；部分验收项未完成" : "Agent 执行完成",
      warnings,
    };
  }
  const issue = sanitizeUserFacingError(text(error) || text(finalText) || "Agent 未返回具体失败原因", { fallback: "Agent 未返回具体失败原因" });
  const label = terminalIssueLabel(normalizedStatus);
  const issueLine = `${label}：${issue}`;
  const visiblePartial = sanitizeConversationOutput(partial);
  return {
    status: normalizedStatus || "failed",
    content: visiblePartial && !visiblePartial.includes(issue) ? `${visiblePartial}\n\n${issueLine}` : visiblePartial || issueLine,
    error: issue,
    result: issueLine,
    warnings,
  };
};

export const nativeAgentLifecycleStageLabel = ({ status = "", fallback = "任务结束" } = {}) => ({
  failed: "任务失败",
  interrupted: "任务已中断",
  cancelled: "任务已取消",
  canceled: "任务已取消",
}[text(status).toLowerCase()] || fallback);

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
  capability_inspection: "路由检查",
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

export const agentTaskRouteFromDelivery = (payload = {}, currentRoute = {}) => {
  const mode = text(payload.mode);
  const mediaChannels = Array.isArray(payload.mediaChannels) ? payload.mediaChannels.map(text).filter(Boolean) : [];
  const explicitTaskType = text(payload.taskType);
  const structuredTaskType = text(currentRoute?.taskKind || currentRoute?.taskType || currentRoute?.intentEnvelope?.taskType);
  const inferredTaskType = mode === "media"
    ? mediaChannels.length === 1 ? mediaTaskType(mediaChannels[0]) : "multi_step"
    : "";
  const taskKind = currentRoute?.capabilityInspectionOnly === true
    ? "capability_inspection"
    : structuredTaskType || explicitTaskType || inferredTaskType;
  if (!taskKind) return null;
  return {
    mode: taskKind === "creative_guidance" ? "creative_guidance" : mode || "agent",
    taskKind,
    direct: ["image_generation", "video_generation"].includes(taskKind),
    ...(["formal_creation", "writing", "content_generation", "multi_step"].includes(taskKind)
      ? { diagnosisIntent: false }
      : taskKind === "quality_review" ? { diagnosisIntent: true } : {}),
  };
};

export const nativeAgentTaskWayLabel = ({ execution = {}, guided = false, qualityReview = false } = {}) => {
  const route = execution.taskRoute && typeof execution.taskRoute === "object" ? execution.taskRoute : {};
  const taskKind = text(route.taskKind || route.taskType || route.intentEnvelope?.taskType);
  const explicitLabel = CONVERSATION_AGENT_TASK_LABELS[taskKind];
  if (explicitLabel) return explicitLabel;
  if (guided) return "创作引导";
  if (qualityReview) return "内容质检";
  if (route.formalArtifactExpected === true && ["creative", "quick_revision", "visual_prompt"].includes(route.mode)) return "正式创作";
  return route.mode === "creative_guidance" || route.requestMode === "creative_guidance" ? "创作引导" : "Agent 执行";
};
