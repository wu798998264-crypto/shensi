import { arbitrateConversationIntent } from "./conversation-intent-policy.js";
import { isImageGenerationIntent } from "./image-generation-intent.js?v=1.0.20-explicit-media-intent";
import { isVideoGenerationIntent } from "./video-generation-intent.js?v=1.0.20-explicit-media-intent";

const EXPLICIT_IMAGE_OUTPUT = /(?:图片|图像|插画|海报|封面|头像|壁纸|照片|画面|角色图|场景图|视觉图|视觉资产(?:图)?|成品图|效果图|logo|标志|生图|出图)/i;
const EXPLICIT_VIDEO_OUTPUT = /(?:视频|短片|动画|动态影像|镜头片段|出视频)/i;

export const decideConversationMediaRoute = ({ text = "", inlineEdit = false } = {}) => {
  const prompt = String(text || "").trim();
  let imageIntent = !inlineEdit && isImageGenerationIntent(prompt);
  let videoIntent = !inlineEdit && isVideoGenerationIntent(prompt);
  if (imageIntent && videoIntent) {
    const explicitlyNamesImage = EXPLICIT_IMAGE_OUTPUT.test(prompt);
    const explicitlyNamesVideo = EXPLICIT_VIDEO_OUTPUT.test(prompt);
    if (explicitlyNamesImage && !explicitlyNamesVideo) videoIntent = false;
    if (explicitlyNamesVideo && !explicitlyNamesImage) imageIntent = false;
  }
  return arbitrateConversationIntent({
    text: prompt,
    imageIntent,
    videoIntent,
  });
};

export const agentRequestUsesConversationMedia = (text = "") => (
  Boolean(decideConversationMediaRoute({ text }).directMediaChannel)
);
