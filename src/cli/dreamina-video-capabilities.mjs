const RESOLUTION_ORDER = ["480p", "720p", "1080p", "4k"];
const DEFAULT_RESOLUTIONS = ["480p", "720p"];

const normalizeResolution = (value) => String(value || "").trim().toLowerCase();

const seedance25HelpSegment = (help = "") => {
  const source = String(help || "");
  const lines = source.split(/\r?\n/u).filter((line) => /seedance2\.5/iu.test(line));
  return lines.find((line) => /video_resolution|resolution|分辨率/iu.test(line)) || lines.join(" ");
};

const resolutionsFromHelp = (help = "") => {
  const segment = seedance25HelpSegment(help);
  const found = RESOLUTION_ORDER.filter((resolution) => new RegExp(`\\b${resolution}\\b`, "iu").test(segment));
  if (found.length) return found;
  // An unavailable help command is not evidence that a capability vanished;
  // retain the conservative legacy fallback only in that transport-failure
  // case. A real help response which omits Seedance 2.5 means this command
  // must not advertise a Seedance 2.5 resolution.
  return String(help || "").trim() ? [] : DEFAULT_RESOLUTIONS.slice();
};

export const seedance25CapabilitiesFromCommandHelp = (commandHelp = {}) => {
  const resolutionsByCommand = Object.fromEntries(
    Object.entries(commandHelp || {}).map(([command, help]) => [command, resolutionsFromHelp(help)]),
  );
  const fallback = resolutionsByCommand.text2video || DEFAULT_RESOLUTIONS.slice();
  const resolutionsByMode = {
    smart_params: resolutionsByCommand.text2video || fallback,
    first_last_frame: resolutionsByCommand.frames2video || fallback,
    smart_edit: resolutionsByCommand.multimodal2video || fallback,
    smart_multiframe: resolutionsByCommand.multiframe2video || fallback,
  };
  const resolutions = [...new Set(Object.values(resolutionsByCommand).flat())]
    .sort((left, right) => RESOLUTION_ORDER.indexOf(left) - RESOLUTION_ORDER.indexOf(right));
  return { resolutionsByCommand, resolutionsByMode, resolutions: resolutions.length ? resolutions : fallback };
};

export const dreaminaCommandForVideoRequest = ({ mode = "smart_params", imageCount = 0, videoCount = 0, audioCount = 0 } = {}) => {
  if (mode === "first_last_frame" && Number(imageCount) >= 2 && !Number(videoCount) && !Number(audioCount)) return "frames2video";
  if (mode === "smart_multiframe" && Number(imageCount) >= 2) return "multiframe2video";
  if (mode === "smart_edit" || Number(videoCount) > 0 || Number(audioCount) > 0 || (mode === "smart_params" && Number(imageCount) > 0)) return "multimodal2video";
  if (Number(imageCount) === 1) return "image2video";
  return "text2video";
};

export const validateSeedance25Resolution = ({ resolution, command, capabilities } = {}) => {
  const requested = normalizeResolution(resolution);
  if (!requested) return;
  const supported = capabilities?.resolutionsByCommand?.[command]
    || capabilities?.resolutionsByMode?.[command]
    || DEFAULT_RESOLUTIONS;
  if (!supported.map(normalizeResolution).includes(requested)) {
    throw new Error(`Seedance 2.5 当前命令 ${command || "当前模式"} 不支持 ${requested} 分辨率`);
  }
};
