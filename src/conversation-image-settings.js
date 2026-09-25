export const DEFAULT_IMAGE_GENERATION_MODEL = "gpt-image-2.5";
export const DEFAULT_IMAGE_GENERATION_QUALITY = "high";
export const DEFAULT_IMAGE_GENERATION_ASPECT_RATIO = "auto";

const ASPECT_RATIO_PATTERN = /(?:^|\D)(21:9|9:21|16:9|9:16|3:2|2:3|4:3|3:4|1:1)(?:\D|$)/u;
const REPEAT_IMAGE_PATTERN = /(?:^|[，,。！？!?；;\s])(?:请|麻烦|帮我|给我)?(?:按照|按|沿用)?[^，,。！？!?；;\n]{0,16}(?:再|重新)(?:来|生成|出|画|绘制|制作)(?:一|1)张(?:同样|一样|相同)?(?:的)?(?:图片|图像|图)?(?:[，,。！？!?；;\s]|$)/u;

export const explicitConversationImageAspectRatio = (prompt = "") => (
  String(prompt || "").match(ASPECT_RATIO_PATTERN)?.[1] || ""
);

export const explicitConversationImageQuality = (prompt = "") => {
  const source = String(prompt || "");
  return /(?:标准|standard)/iu.test(source)
    ? "standard"
    : /(?:高清|高画质|high)/iu.test(source)
      ? "high"
      : /(?:4k)/iu.test(source)
        ? "4k"
        : /(?:2k)/iu.test(source)
          ? "2k"
          : /(?:1k)/iu.test(source)
            ? "1k"
            : "";
};

export const conversationImageRepeatRequest = (prompt = "") => REPEAT_IMAGE_PATTERN.test(String(prompt || "").trim());

export const mergeConversationImageRepeatParameters = ({
  remembered = {},
  prompt = "",
  aspectRatio = "",
  quality = "",
} = {}) => ({
  aspectRatio: String(aspectRatio || explicitConversationImageAspectRatio(prompt) || remembered.aspectRatio || "").trim(),
  quality: String(quality || explicitConversationImageQuality(prompt) || remembered.quality || "").trim().toLowerCase(),
});

export const requestedConversationImageOptions = ({
  prompt = "",
  supportedAspectRatios = [],
  supportedQualities = [],
} = {}) => {
  const source = String(prompt || "");
  const ratios = new Set((Array.isArray(supportedAspectRatios) ? supportedAspectRatios : []).map(String));
  const qualities = (Array.isArray(supportedQualities) ? supportedQualities : []).map(String);
  const explicitRatio = explicitConversationImageAspectRatio(source);
  const explicitQuality = explicitConversationImageQuality(source);
  return {
    aspectRatio: explicitRatio && ratios.has(explicitRatio)
      ? explicitRatio
      : DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
    quality: explicitQuality && qualities.includes(explicitQuality)
      ? explicitQuality
      : qualities.includes(DEFAULT_IMAGE_GENERATION_QUALITY)
        ? DEFAULT_IMAGE_GENERATION_QUALITY
        : qualities[0] || DEFAULT_IMAGE_GENERATION_QUALITY,
    explicitAspectRatio: explicitRatio,
    explicitQuality,
  };
};
