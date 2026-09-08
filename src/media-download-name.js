const MEDIA_PREFIX = Object.freeze({
  image: "神思图片",
  video: "神思视频",
  audio: "神思音频",
});

const MIME_EXTENSION = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
});

const INTERNAL_MEDIA_STEM = /^(?:(?:神思|白板|历史|生成)(?:生图|图片|视频|音频)|(?:provider-result|generation|image-generation|video-generation|audio-generation))(?:[-_ ]+(?:generation[-_])?[a-z\d-]{6,})?$/iu;
const MEDIA_PROMPT_STEM_LIMIT = 16;

const unicodeSlice = (value, limit) => Array.from(String(value || "")).slice(0, Math.max(1, Number(limit) || 1)).join("");

export const sanitizeDownloadFileName = (value, fallback = "神思媒体") => unicodeSlice(String(value || fallback)
  .normalize("NFC")
  .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
  .replace(/\s+/g, " ")
  .replace(/[. ]+$/g, "")
  .trim() || fallback, 120);

const extensionFrom = ({ name = "", relativePath = "", mimeType = "", kind = "" } = {}) => {
  const sourceExtension = String(name || relativePath).match(/\.[a-z\d]{1,10}$/i)?.[0]?.toLowerCase();
  if (sourceExtension) return sourceExtension;
  const normalizedMimeType = String(mimeType || "").toLowerCase().split(";", 1)[0];
  return MIME_EXTENSION[normalizedMimeType] || (kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".png");
};

const meaningfulOriginalStem = (value = "") => {
  const stem = String(value || "").split(/[\\/]/).at(-1)?.replace(/\.[a-z\d]{1,10}$/i, "").trim() || "";
  return stem && !INTERNAL_MEDIA_STEM.test(stem) ? stem : "";
};

export const mediaDownloadFileName = ({
  kind = "image",
  nodeName = "",
  prompt = "",
  name = "",
  relativePath = "",
  mimeType = "",
} = {}) => {
  const normalizedKind = ["image", "video", "audio"].includes(kind) ? kind : "image";
  const prefix = MEDIA_PREFIX[normalizedKind];
  const normalizedNodeName = sanitizeDownloadFileName(nodeName, "").replace(/[. ]+$/g, "");
  if (normalizedNodeName) return `${normalizedNodeName}${extensionFrom({ name, relativePath, mimeType, kind: normalizedKind })}`;
  const promptText = String(prompt || "")
    .replace(new RegExp(`^${prefix}[\\s:：_-]*`, "u"), "")
    .replace(/\s+/g, " ")
    .trim();
  const sourceLabel = promptText || meaningfulOriginalStem(name) || meaningfulOriginalStem(relativePath) || "未记录提示词";
  const labelLimit = promptText ? MEDIA_PROMPT_STEM_LIMIT : 72;
  const promptLabel = unicodeSlice(sanitizeDownloadFileName(sourceLabel, "未记录提示词"), labelLimit).replace(/[. ]+$/g, "") || "未记录提示词";
  return `${prefix}-${promptLabel}${extensionFrom({ name, relativePath, mimeType, kind: normalizedKind })}`;
};
