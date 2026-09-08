const EPISODE_HEADING = /^第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*集(?:\s|$)/;
const SCENE_HEADING = /^(\d+)\s*[-—]\s*(\d+)\s*[、.]\s*[^，,\n]+[，,]\s*(?:内|外|内\/外|外\/内)[，,]\s*\S+/;
const CHARACTER_LINE = /^人物\s*[：:]\s*\S+/;
const ACTION_LINE = /^△\s*\S+/;
const DIALOGUE_LINE = /^(?!人物\s*[：:])(?!字幕\s*[：:])[^：:\s]{1,20}(?:\s*(?:VO|OS))?\s*[：:]\s*\S+/i;
const TRAILER_INTENT = /预告片|预告视频|先导片|宣传片|片花/;
const TRAILER_VISUAL_LINE = /^(?:画面|镜头|景别|动作|视觉|转场|字幕)\s*[：:]|^△\s*\S+/;
const TRAILER_AUDIO_LINE = /^(?:旁白|台词|对白|音效|音乐|声音|VO|OS)\s*[：:]|^[^：:\s]{1,20}(?:\s*(?:VO|OS))?\s*[：:]\s*\S+/i;
const PLACEHOLDER_PATTERN = /\[(?:作品名|角色名|人物名|场景名|待补|待定)\]|【(?:待补|待定)】|\b(?:TBD|TODO|XXX)\b/i;

const clockSeconds = (value = "") => {
  const parts = String(value).split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
};

const trailerRanges = (source = "") => {
  const ranges = [];
  for (const match of String(source).matchAll(/(?:^|\n)\s*\[?\s*(\d{1,2}:\d{2}|\d{1,3})\s*(?:-|—|–|~|～|至|到)\s*(\d{1,2}:\d{2}|\d{1,3})\s*(?:秒)?\s*\]?/g)) {
    const start = clockSeconds(match[1]);
    const end = clockSeconds(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end });
  }
  return ranges;
};

const requestedTrailerDuration = (prompt = "") => {
  const match = String(prompt).match(/(?:时长|总长|控制在|约)?\s*(\d{1,3})\s*秒/);
  return match ? Number(match[1]) : 0;
};

const expectedKind = ({ targetDocumentId = "", prompt = "" } = {}) => {
  if (TRAILER_INTENT.test(prompt)) return "trailer";
  if (/^script-episode-/.test(targetDocumentId)) return "screenplay";
  if (/^script-outline-/.test(targetDocumentId)) return "outline";
  if (/(?:剧本|脚本|场次|场景|正式剧集正文)/.test(prompt)) return "screenplay";
  if (/(?:全集大纲|整季大纲|剧集大纲|分集大纲|集纲)/.test(prompt)) return "outline";
  return "screenplay";
};

export const validateShortDramaFormat = ({ text = "", targetDocumentId = "", prompt = "", deliverableType = "" } = {}) => {
  // Short-video scripts deliberately remain format-flexible: their delivery
  // shape may be dialogue, oral copy, shot list, advert, vlog or mixed media.
  // An explicit short-video classification therefore outranks a script-like
  // target id and must never be forced through the Shensi screenplay gate.
  if (deliverableType === "short_video_script") {
    return { applicable: false, pass: true, kind: "short_video_flexible", issues: [] };
  }
  if (deliverableType !== "short_drama_script" && !/^script-(?:episode|outline)-/.test(targetDocumentId)) {
    return { applicable: false, pass: true, kind: "none", issues: [] };
  }
  const source = String(text).replace(/\r/g, "").trim();
  const kind = expectedKind({ targetDocumentId, prompt });
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  const issues = [];
  if (kind === "trailer") {
    const ranges = trailerRanges(source);
    if (ranges.length < 3) issues.push({ code: "TRAILER_TIMELINE", message: "预告片脚本至少需要 3 个可解析的时间轴段落" });
    if (ranges.some((range) => range.end <= range.start)) issues.push({ code: "TRAILER_TIME_ORDER", message: "预告片时间轴存在结束时间不晚于开始时间的段落" });
    if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) issues.push({ code: "TRAILER_TIME_OVERLAP", message: "预告片时间轴存在重叠段落" });
    if (lines.filter((line) => TRAILER_VISUAL_LINE.test(line)).length < 2) issues.push({ code: "TRAILER_VISUAL_ACTION", message: "预告片缺少可执行的画面、镜头或动作描述" });
    if (!lines.some((line) => TRAILER_AUDIO_LINE.test(line))) issues.push({ code: "TRAILER_AUDIO", message: "预告片缺少旁白、对白、音乐或音效设计" });
    if (PLACEHOLDER_PATTERN.test(source)) issues.push({ code: "TRAILER_PLACEHOLDER", message: "预告片仍包含未替换的占位内容" });
    const requestedDuration = requestedTrailerDuration(prompt);
    const actualDuration = ranges.length ? ranges.at(-1).end : 0;
    if (requestedDuration && actualDuration && Math.abs(actualDuration - requestedDuration) > 1) {
      issues.push({ code: "TRAILER_DURATION", message: `预告片时间轴为 ${actualDuration} 秒，与用户要求的 ${requestedDuration} 秒不一致` });
    }
    return { applicable: true, pass: issues.length === 0, kind, duration: actualDuration, issues };
  }
  if (!lines.some((line) => EPISODE_HEADING.test(line))) issues.push({ code: "SCRIPT_EPISODE_HEADING", message: "缺少“第X集”集标题" });
  if (kind === "outline") {
    const structuredFields = lines.filter((line) => /^[^：:\n]{2,24}[：:]\s*\S+/.test(line));
    if (structuredFields.length < 3) issues.push({ code: "SCRIPT_OUTLINE_FIELDS", message: "剧集大纲缺少可解析的结构字段" });
    return { applicable: true, pass: issues.length === 0, kind, issues };
  }
  const sceneIndexes = lines.map((line, index) => SCENE_HEADING.test(line) ? index : -1).filter((index) => index >= 0);
  if (!sceneIndexes.length) issues.push({ code: "SCRIPT_SCENE_HEADING", message: "缺少“集数-场次、时段，内/外，地点”场景标题" });
  let dialogueCount = 0;
  for (let index = 0; index < sceneIndexes.length; index += 1) {
    const start = sceneIndexes[index] + 1;
    const end = sceneIndexes[index + 1] ?? lines.length;
    const sceneLines = lines.slice(start, end);
    const sceneLabel = lines[sceneIndexes[index]].match(SCENE_HEADING)?.slice(1, 3).join("-") ?? `场次${index + 1}`;
    if (!sceneLines.some((line) => CHARACTER_LINE.test(line))) issues.push({ code: "SCRIPT_CHARACTER_LINE", message: `${sceneLabel}缺少人物行` });
    if (!sceneLines.some((line) => ACTION_LINE.test(line))) issues.push({ code: "SCRIPT_ACTION_LINE", message: `${sceneLabel}缺少以△开头的动作行` });
    dialogueCount += sceneLines.filter((line) => DIALOGUE_LINE.test(line)).length;
  }
  if (!dialogueCount) issues.push({ code: "SCRIPT_DIALOGUE_LINE", message: "缺少“人物名：台词”格式的对白" });
  return { applicable: true, pass: issues.length === 0, kind, issues };
};
