import { planConversationImageBatch, planConversationVideoBatch } from "./conversation-media-batch.js?v=1.0.18-image-repeat-parameters";
import { decideConversationMediaRoute } from "./conversation-media-routing.js?v=1.0.20-explicit-media-intent";

export const CONVERSATION_IMAGE_BATCH_MAX_ITEMS = 64;
export const CONVERSATION_VIDEO_BATCH_MAX_ITEMS = 32;

const normalizedBatchItem = (item = {}, index = 0, kind = "image") => {
  const mediaLabel = kind === "video" ? "视频" : "图片";
  return {
  code: String(item.code || `${kind === "video" ? "VID" : "IMG"}${String(index + 1).padStart(2, "0")}`).slice(0, 96),
  title: String(item.title || `${mediaLabel} ${index + 1}`).slice(0, 160),
  label: String(item.label || item.title || `${mediaLabel} ${index + 1}`).slice(0, 240),
  prompt: String(item.prompt || "").trim().slice(0, 14_000),
  ...(item.missingContext === true ? { missingContext: true } : {}),
  ...(item.sourceMessageId ? { sourceMessageId: String(item.sourceMessageId) } : {}),
  };
};

export const normalizeConversationMediaDispatchContract = (value = null) => {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "composite" && Array.isArray(value.steps) && value.steps.length > 1) {
    const steps = value.steps.slice(0, 32).map((step, index) => {
      const kind = step?.kind === "video" ? "video" : step?.kind === "image" ? "image" : "text";
      const instruction = String(step?.instruction || "").trim().slice(0, 64_000);
      if (!instruction) return null;
      const plannedBatch = (kind === "image" || kind === "video") && Array.isArray(step.plannedBatch)
        ? step.plannedBatch.slice(0, kind === "video" ? CONVERSATION_VIDEO_BATCH_MAX_ITEMS : CONVERSATION_IMAGE_BATCH_MAX_ITEMS).map((item, itemIndex) => normalizedBatchItem(item, itemIndex, kind))
        : [];
      return {
        id: String(step.id || `step-${index + 1}`).slice(0, 96),
        kind,
        channel: kind === "image" || kind === "video" ? kind : "",
        instruction,
        label: String(step.label || (kind === "text" ? "文字任务" : `${kind === "video" ? "视频" : "图片"}生成`)).slice(0, 160),
        plannedBatch,
        ...(step.profileId ? { profileId: String(step.profileId).slice(0, 160) } : {}),
        ...(step.model ? { model: String(step.model).slice(0, 240) } : {}),
        ...(kind === "image" && step.aspectRatio ? { aspectRatio: String(step.aspectRatio).slice(0, 24) } : {}),
        ...(kind === "image" && step.quality ? { quality: String(step.quality).slice(0, 24) } : {}),
        ...(kind === "image" && step.reuseLastSuccessfulParameters === true ? { reuseLastSuccessfulParameters: true } : {}),
      };
    }).filter(Boolean);
    if (steps.length > 1) return {
      version: 2,
      kind: "composite",
      reason: String(value.reason || "复合任务已拆分并锁定执行顺序").slice(0, 320),
      steps,
    };
  }
  const channel = value.channel === "video" ? "video" : value.channel === "image" ? "image" : "";
  if (!channel) return null;
  const plannedBatch = (channel === "image" || channel === "video") && Array.isArray(value.plannedBatch)
    ? value.plannedBatch
      .slice(0, channel === "video" ? CONVERSATION_VIDEO_BATCH_MAX_ITEMS : CONVERSATION_IMAGE_BATCH_MAX_ITEMS)
      .map((item, itemIndex) => normalizedBatchItem(item, itemIndex, channel))
    : [];
  return {
    version: 1,
    kind: "media",
    channel,
    reason: String(value.reason || "已在发送时锁定直接媒体执行意图").slice(0, 320),
    plannedBatch,
    ...(value.profileId ? { profileId: String(value.profileId).slice(0, 160) } : {}),
    ...(value.model ? { model: String(value.model).slice(0, 240) } : {}),
    ...(channel === "image" && value.aspectRatio ? { aspectRatio: String(value.aspectRatio).slice(0, 24) } : {}),
    ...(channel === "image" && value.quality ? { quality: String(value.quality).slice(0, 24) } : {}),
    ...(channel === "image" && value.reuseLastSuccessfulParameters === true ? { reuseLastSuccessfulParameters: true } : {}),
  };
};

export const createConversationMediaDispatchContract = ({
  text = "",
  messages = [],
  inlineEdit = false,
  channel = "",
  profileId = "",
  model = "",
  aspectRatio = "",
  quality = "",
  reuseLastSuccessfulParameters = false,
} = {}) => {
  const forcedChannel = channel === "video" ? "video" : channel === "image" ? "image" : "";
  const route = forcedChannel
    ? { kind: "media", directMediaChannel: forcedChannel, reason: `已按当前明确选择的${forcedChannel === "video" ? "视频" : "图片"}配置锁定本轮生成` }
    : decideConversationMediaRoute({ text, inlineEdit });
  if (route.kind === "composite") {
    return normalizeConversationMediaDispatchContract({
      version: 2,
      kind: "composite",
      reason: route.reason,
      steps: route.capabilitySteps.map((step) => ({
        ...step,
        ...(profileId && step.kind === forcedChannel ? { profileId } : {}),
        ...(model && step.kind === forcedChannel ? { model } : {}),
        ...(aspectRatio && step.kind === "image" ? { aspectRatio } : {}),
        ...(quality && step.kind === "image" ? { quality } : {}),
        ...(reuseLastSuccessfulParameters && step.kind === "image" ? { reuseLastSuccessfulParameters: true } : {}),
        plannedBatch: step.kind === "image"
          ? planConversationImageBatch({ instruction: step.instruction, messages, maxItems: CONVERSATION_IMAGE_BATCH_MAX_ITEMS })
          : step.kind === "video"
            ? planConversationVideoBatch({ instruction: step.instruction, messages, maxItems: CONVERSATION_VIDEO_BATCH_MAX_ITEMS })
            : [],
      })),
    });
  }
  if (!route.directMediaChannel) return null;
  const plannedBatch = route.directMediaChannel === "image"
    ? planConversationImageBatch({ instruction: text, messages, maxItems: CONVERSATION_IMAGE_BATCH_MAX_ITEMS })
    : route.directMediaChannel === "video"
      ? planConversationVideoBatch({ instruction: text, messages, maxItems: CONVERSATION_VIDEO_BATCH_MAX_ITEMS })
      : [];
  return normalizeConversationMediaDispatchContract({
    channel: route.directMediaChannel,
    reason: route.reason,
    plannedBatch,
    profileId,
    model,
    aspectRatio,
    quality,
    reuseLastSuccessfulParameters,
  });
};
