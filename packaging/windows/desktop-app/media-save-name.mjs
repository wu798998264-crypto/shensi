import { basename, join } from "node:path";

const MEDIA_FILE_NAME_LIMIT = 160;
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export const sanitizeSuggestedMediaName = (value = "神思媒体") => {
  const leafName = basename(String(value || "神思媒体").replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim() || "神思媒体";
  const safeName = WINDOWS_RESERVED_STEM.test(leafName) ? `_${leafName}` : leafName;
  return Array.from(safeName).slice(0, MEDIA_FILE_NAME_LIMIT).join("");
};

export const numberedMediaFileName = (suggestedName, duplicateIndex = 0) => {
  const safeName = sanitizeSuggestedMediaName(suggestedName);
  const extension = safeName.match(/\.[a-z\d]{1,10}$/iu)?.[0] || "";
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  const index = Math.max(0, Math.trunc(Number(duplicateIndex) || 0));
  return `${stem}${index ? `（${index}）` : ""}${extension}`;
};

export const nextAvailableMediaSavePath = async ({ directory, suggestedName, exists } = {}) => {
  if (typeof exists !== "function") throw new TypeError("媒体另存命名需要文件存在性检查器");
  const targetDirectory = String(directory || "").trim();
  if (!targetDirectory) throw new TypeError("媒体另存目录不能为空");
  for (let duplicateIndex = 0; duplicateIndex <= 9_999; duplicateIndex += 1) {
    const candidatePath = join(targetDirectory, numberedMediaFileName(suggestedName, duplicateIndex));
    if (!(await exists(candidatePath))) return candidatePath;
  }
  throw new Error("同名媒体文件过多，请更换保存目录或文件名");
};
