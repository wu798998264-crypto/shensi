const normalize = (value = "") => String(value || "").trim();

const DEFAULT_ACTION = /(?:设置|设定|设为|改为|改成|更换|切换|修改|调整|更新|指定|使用)/u;
const DEFAULT_WORD = /默认/u;
const IMAGE_WORD = /(?:图片|图像|生图)/u;
const VIDEO_WORD = /视频/u;

export const conversationMediaDefaultIntent = (instruction = "") => {
  const text = normalize(instruction);
  const futureDefault = /(?:以后|后续|接下来|后面).{0,24}(?:都用|都使用|统一使用|固定使用|默认使用|沿用)/u.test(text);
  if (!text || (!futureDefault && (!DEFAULT_WORD.test(text) || !DEFAULT_ACTION.test(text)))) return null;
  const imageIndex = text.search(IMAGE_WORD);
  const videoIndex = text.search(VIDEO_WORD);
  const channel = videoIndex >= 0 && (imageIndex < 0 || videoIndex < imageIndex) ? "video"
    : imageIndex >= 0 ? "image" : "";
  if (!channel) return null;
  return { channel, instruction: text };
};

export const explicitConversationVideoDuration = (instruction = "") => {
  const match = normalize(instruction).match(/(?:时长|持续|生成)?\s*(\d{1,3})\s*秒/u);
  return match ? Number(match[1]) || 0 : 0;
};

export const normalizeConversationMediaDefaults = (value = null) => {
  const source = value && typeof value === "object" ? value : {};
  const image = source.image && typeof source.image === "object" ? source.image : {};
  const video = source.video && typeof source.video === "object" ? source.video : {};
  return {
    image: {
      profileId: normalize(image.profileId),
      model: normalize(image.model),
      aspectRatio: normalize(image.aspectRatio),
      quality: normalize(image.quality).toLowerCase(),
    },
    video: {
      profileId: normalize(video.profileId),
      model: normalize(video.model),
      aspectRatio: normalize(video.aspectRatio),
      resolution: normalize(video.resolution).toLowerCase(),
    },
  };
};

export const conversationMediaEffectiveSelection = ({ defaults = null, successful = null, channel = "image" } = {}) => {
  const normalized = normalizeConversationMediaDefaults(defaults);
  const preferred = channel === "video" ? normalized.video : normalized.image;
  const fallback = successful && typeof successful === "object" ? successful : {};
  return {
    ...fallback,
    ...Object.fromEntries(Object.entries(preferred).filter(([, value]) => normalize(value))),
  };
};
