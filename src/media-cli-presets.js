export const OPENAI_IMAGE_CLI_ALIAS = "shensi-openai-image";
export const DREAMINA_IMAGE_CLI_ALIAS = "shensi-dreamina-image";
export const DREAMINA_VIDEO_CLI_ALIAS = "shensi-dreamina-video";
// LibTV is an installed official CLI. Keep the executable name in the
// profile so the server can route only image/video/audio work to it.
export const LIBTV_CLI_ALIAS = "libtv";
export const LIBTV_CLI_ARGS = "";

export const DREAMINA_CLI_PROFILES = Object.freeze([
  Object.freeze({ id: "default", remarkName: "柏物语" }),
  Object.freeze({ id: "xiaoyujie", remarkName: "小鱼姐" }),
  Object.freeze({ id: "guobazai", remarkName: "锅巴仔" }),
  Object.freeze({ id: "chenan", remarkName: "陈安" }),
  Object.freeze({ id: "tashuo-juyougeng", remarkName: "她说剧有梗" }),
  Object.freeze({ id: "duanju-zuiqianxian", remarkName: "短剧最前线" }),
  Object.freeze({ id: "yinou-shijie", remarkName: "银鸥师姐" }),
]);

export const normalizeDreaminaCliProfileId = (value = "") => {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : "";
};

export const validDreaminaCliProfileId = (value = "") => {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate);
};

export const OPENAI_IMAGE_CLI_ARGS = [
  "--prompt-file {promptFile}",
  "--reference-images-file {referenceImagesFile}",
  "--model {model}",
  "--aspect-ratio {aspectRatio}",
  "--quality {quality}",
  "--count {imageCount}",
  "--output {outputFile}",
].join(" ");

export const DREAMINA_IMAGE_CLI_ARGS = [
  "--prompt-file {promptFile}",
  "--reference-images-file {referenceImagesFile}",
  "--model {model}",
  "--aspect-ratio {aspectRatio}",
  "--resolution {quality}",
  "--count {imageCount}",
  "--output {outputFile}",
].join(" ");

export const DREAMINA_VIDEO_CLI_ARGS = [
  "--prompt-file {promptFile}",
  "--reference-images-file {referenceImagesFile}",
  "--transitions-file {transitionsFile}",
  "--model {model}",
  "--aspect-ratio {aspectRatio}",
  "--duration {duration}",
  "--resolution {resolution}",
  "--mode {mode}",
  "--output {outputFile}",
].join(" ");
