import { isImageGenerationIntent } from "./image-generation-intent.js";

const PROMPT_EDITING_INTENT = /(?:生成|写|撰写|制作|创作|输出|整理|优化|改写|润色|完善|调整|修改|继续编辑|扩写|精简|翻译)[^。！？!?\n]{0,24}(?:图片|图像|生图|绘画|视觉)?(?:提示词|prompt)|(?:提示词|prompt)[^。！？!?\n]{0,18}(?:优化|改写|润色|完善|调整|修改|继续编辑|扩写|精简|翻译)/iu;

export const conversationImagePromptKind = (value = "") => {
  const text = String(value ?? "").trim();
  if (!text) return "text";
  if (isImageGenerationIntent(text)) return "explicit_image";
  if (PROMPT_EDITING_INTENT.test(text)) return "prompt_edit";
  return "text";
};

export const conversationImagePromptNeedsChoice = () => false;
