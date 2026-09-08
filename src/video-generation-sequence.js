export const SMART_MULTIFRAME_MODEL_ID = "seedance1.0fast";
export const SMART_MULTIFRAME_MIN_FRAMES = 2;
export const SMART_MULTIFRAME_MAX_FRAMES = 20;
export const SMART_MULTIFRAME_MIN_DURATION = 1;
export const SMART_MULTIFRAME_MAX_DURATION = 8;
export const SMART_MULTIFRAME_MIN_TOTAL_DURATION = 2;
export const SMART_EDIT_MAX_ADDITIONAL_REFERENCES = 5;
export const SMART_EDIT_MAX_VIDEO_DURATION_SECONDS = 10;
export const LONG_VIDEO_MIN_DURATION_SECONDS = 31;
export const LONG_VIDEO_MAX_DURATION_SECONDS = 300;
export const COMPOSITE_LONG_VIDEO_MODE = "composite_long_video";
export const LONG_VIDEO_SEGMENT_MAX_DURATION_SECONDS = 30;

const normalizedLongVideoReferenceKind = (item = {}) => {
  const explicit = String(item.kind || "").trim().toLowerCase();
  if (["continuity_frame", "identity", "scene", "wardrobe", "prop", "style", "image", "video", "audio"].includes(explicit)) return explicit;
  const mimeType = String(item.mimeType || "").toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "unknown";
};

const longVideoReferencePriority = (item = {}) => ({
  continuity_frame: 0, identity: 1, wardrobe: 2, scene: 3, prop: 4,
  style: 5, image: 6, video: 7, audio: 8, unknown: 9,
}[normalizedLongVideoReferenceKind(item)] ?? 9);

export const prioritizeLongVideoReferences = (items = [], { limit = 50, continuityFrame = null } = {}) => {
  const source = [
    ...(continuityFrame ? [{ ...continuityFrame, kind: "continuity_frame", continuityFrame: true }] : []),
    ...(Array.isArray(items) ? items : []),
  ];
  const seen = new Set();
  return source
    .map((item, index) => ({ ...item, _index: index, _priority: longVideoReferencePriority(item) }))
    .filter((item) => {
      const key = String(item.relativePath || item.absolutePath || item.id || `${item._priority}:${item._index}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left._priority - right._priority || left._index - right._index)
    .slice(0, Math.max(1, Number(limit) || 50))
    .map(({ _index, _priority, ...item }) => item);
};

const explicitLongVideoSections = (prompt = "") => String(prompt)
  .replace(/\r\n?/g, "\n")
  .split(/(?:^|\n)\s*(?:第\s*[一二两三四五六七八九十百千万\d]+\s*(?:段|幕|部分|镜头)|片段\s*[一二两三四五六七八九十百千万\d]+)\s*[：:]?/u)
  .map((item) => item.trim())
  .filter(Boolean);

const distributedSegmentDurations = (total, requestedCount = 0) => {
  const minimumCount = Math.ceil(total / LONG_VIDEO_SEGMENT_MAX_DURATION_SECONDS);
  const count = Math.max(minimumCount, Math.min(total, Number(requestedCount) || minimumCount));
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
};

const longVideoPromptUnits = (prompt = "", explicitSections = []) => {
  if (explicitSections.length > 1) return explicitSections;
  const paragraphs = String(prompt).split(/\n+/).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const sentences = String(prompt).match(/[^。！？!?；;]+[。！？!?；;]?/gu)?.map((item) => item.trim()).filter(Boolean) || [];
  return sentences.length ? sentences : [String(prompt).trim()];
};

const segmentLocalPrompts = (prompt, count, explicitSections = []) => {
  let units = longVideoPromptUnits(prompt, explicitSections);
  if (units.length < count && String(prompt).length >= count) {
    const characters = [...String(prompt).trim()];
    units = Array.from({ length: count }, (_, index) => characters
      .slice(Math.floor(index * characters.length / count), Math.floor((index + 1) * characters.length / count))
      .join("")
      .trim())
      .filter(Boolean);
  }
  if (units.length < count) return Array.from({ length: count }, () => String(prompt).trim());
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * units.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * units.length / count));
    return units.slice(start, end).join("\n").trim();
  });
};

const segmentContinuityPrompt = ({ total, index, count, duration, globalBible, localPrompt }) => [
  globalBible ? `【全片统一约束】\n${globalBible}` : "",
  `【第 ${index + 1}/${count} 段｜${duration} 秒】`,
  localPrompt,
  index > 0 ? "从上一段提供的稳定尾帧继续；保持人物身份、服装、道具、场景空间、光线、色彩、镜头方向与动作动势一致。" : "建立全片人物、场景、光线、色彩和镜头方向的连续性基线。",
  index < count - 1 ? "本段结尾停在稳定、可辨认且动作可继续的画面状态，为下一段保留明确承接点。" : "完成全片结尾动作，不额外引入未定义的人物、服装、场景或道具。",
  `本片总时长 ${total} 秒。本段不得复述其他片段已经完成的动作。`,
].filter(Boolean).join("\n\n");

export const planCompositeLongVideo = ({ duration = 0, prompt = "", globalBible = "", references = [] } = {}) => {
  const total = Number(duration);
  if (!Number.isInteger(total) || total < LONG_VIDEO_MIN_DURATION_SECONDS || total > LONG_VIDEO_MAX_DURATION_SECONDS) {
    throw new Error(`超长视频总时长必须是 ${LONG_VIDEO_MIN_DURATION_SECONDS}—${LONG_VIDEO_MAX_DURATION_SECONDS} 秒的整数`);
  }
  const sourcePrompt = String(prompt).trim();
  if (!sourcePrompt) throw new Error("超长视频提示词不能为空");
  const sections = explicitLongVideoSections(sourcePrompt);
  const durations = distributedSegmentDurations(total, sections.length);
  const count = durations.length;
  const localPrompts = segmentLocalPrompts(sourcePrompt, count, sections);
  return durations.map((segmentDuration, index) => {
    const localPrompt = localPrompts[index] || sourcePrompt;
    return {
      index,
      segmentId: `segment-${String(index + 1).padStart(2, "0")}`,
      duration: segmentDuration,
      localPrompt,
      prompt: segmentContinuityPrompt({ total, index, count, duration: segmentDuration, globalBible: String(globalBible || "").trim(), localPrompt }),
      sourceReferences: prioritizeLongVideoReferences(references),
      effectiveReferences: index === 0 ? prioritizeLongVideoReferences(references) : [],
      continuityFrame: null,
      providerTaskId: "",
      childJobId: "",
      status: "planned",
      attempt: 0,
      estimatedCredits: null,
      actualCredits: null,
      output: null,
      error: "",
      downstreamContinuityStale: false,
    };
  });
};

export const createCompositeLongVideoManifest = ({ id = "", cardId = "", duration, prompt, globalBible = "", references = [], settings = {}, providerPromptReferenceTokens = [] } = {}) => ({
  schemaVersion: 2,
  id: String(id || `long-video-${Date.now()}`),
  strategy: "sequential_tail_frame_concat",
  mode: COMPOSITE_LONG_VIDEO_MODE,
  cardId: String(cardId || ""),
  totalDuration: Number(duration),
  prompt: String(prompt || "").trim(),
  globalBible: String(globalBible || "").trim(),
  providerPromptReferenceTokens: [...new Set((Array.isArray(providerPromptReferenceTokens) ? providerPromptReferenceTokens : [])
    .map(String)
    .filter(Boolean))].slice(0, 300),
  settings: { ...settings },
  sourceReferences: prioritizeLongVideoReferences(references),
  status: "planned",
  completedSegments: 0,
  activeSegmentIndex: 0,
  automaticPaidRetry: false,
  estimatedCredits: null,
  actualCredits: 0,
  combinedOutput: null,
  segments: planCompositeLongVideo({ duration, prompt, globalBible, references }),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const updatedCompositeManifest = (manifest, patch = {}) => ({ ...manifest, ...patch, updatedAt: new Date().toISOString() });

export const prepareCompositeLongVideoSegment = (manifest = {}, segmentIndex = 0, { continuityFrame = null, referenceLimit = 50 } = {}) => {
  const segments = (manifest.segments || []).map((segment) => ({ ...segment }));
  const segment = segments[segmentIndex];
  if (!segment) throw new Error("超长视频分段不存在");
  if (!["planned", "awaiting_manual_retry"].includes(segment.status)) throw new Error("当前分段状态不能提交生成");
  segment.continuityFrame = continuityFrame || segment.continuityFrame || null;
  segment.effectiveReferences = prioritizeLongVideoReferences(manifest.sourceReferences || segment.sourceReferences, { limit: referenceLimit, continuityFrame: segment.continuityFrame });
  segment.status = "ready";
  segment.error = "";
  segments[segmentIndex] = segment;
  return updatedCompositeManifest(manifest, { segments, status: "ready", activeSegmentIndex: segmentIndex });
};

export const markCompositeLongVideoSegmentSubmitted = (manifest = {}, segmentIndex = 0, { childJobId = "", providerTaskId = "" } = {}) => {
  const segments = (manifest.segments || []).map((segment) => ({ ...segment }));
  const segment = segments[segmentIndex];
  if (!segment || !["ready", "submitted"].includes(segment.status)) throw new Error("当前分段尚未准备好，不能标记为已提交");
  const newSubmission = String(childJobId || "") && segment.childJobId !== String(childJobId);
  segment.status = "submitted";
  segment.childJobId = String(childJobId || segment.childJobId || "");
  segment.providerTaskId = String(providerTaskId || segment.providerTaskId || "");
  segment.attempt = Math.max(1, Number(segment.attempt) + (newSubmission ? 1 : 0));
  segments[segmentIndex] = segment;
  return updatedCompositeManifest(manifest, { segments, status: "running", activeSegmentIndex: segmentIndex });
};

export const markCompositeLongVideoSegmentCompleted = (manifest = {}, segmentIndex = 0, { output, continuityFrame = null, actualCredits = null } = {}) => {
  const segments = (manifest.segments || []).map((segment) => ({ ...segment }));
  const segment = segments[segmentIndex];
  if (!segment || !["submitted", "running", "completed"].includes(segment.status)) throw new Error("当前分段状态不能标记为完成");
  segment.status = "completed";
  segment.output = output || segment.output;
  segment.continuityFrame = continuityFrame || segment.continuityFrame;
  segment.actualCredits = Number.isFinite(Number(actualCredits)) ? Number(actualCredits) : segment.actualCredits;
  segment.error = "";
  segments[segmentIndex] = segment;
  const completedSegments = segments.filter((item) => item.status === "completed").length;
  const complete = completedSegments === segments.length;
  return updatedCompositeManifest(manifest, {
    segments,
    completedSegments,
    activeSegmentIndex: complete ? segmentIndex : segmentIndex + 1,
    status: complete ? "ready_to_concat" : "awaiting_next_segment",
    actualCredits: segments.reduce((sum, item) => sum + (Number(item.actualCredits) || 0), 0),
  });
};

export const markCompositeLongVideoSegmentFailed = (manifest = {}, segmentIndex = 0, error = "") => {
  const segments = (manifest.segments || []).map((segment) => ({ ...segment }));
  const segment = segments[segmentIndex];
  if (!segment) throw new Error("超长视频分段不存在");
  segment.status = "awaiting_manual_retry";
  segment.error = String(error || "分段生成失败").slice(0, 2000);
  segments[segmentIndex] = segment;
  return updatedCompositeManifest(manifest, { segments, status: "paused_manual_action_required", activeSegmentIndex: segmentIndex, automaticPaidRetry: false });
};

export const requestCompositeLongVideoManualRetry = (manifest = {}, segmentIndex = 0) => {
  const segments = (manifest.segments || []).map((segment) => ({ ...segment }));
  const segment = segments[segmentIndex];
  if (!segment || segment.status !== "awaiting_manual_retry") throw new Error("只有等待人工处理的失败分段可以重新生成");
  segment.status = "planned";
  segment.childJobId = "";
  segment.providerTaskId = "";
  segment.output = null;
  segment.error = "";
  for (let index = segmentIndex + 1; index < segments.length; index += 1) {
    if (segments[index].status === "completed") segments[index].downstreamContinuityStale = true;
  }
  return updatedCompositeManifest(manifest, { segments, status: "planned", activeSegmentIndex: segmentIndex });
};

export const planSegmentedLongVideo = ({ duration = 0, prompt = "" } = {}) => {
  return planCompositeLongVideo({ duration, prompt });
};

const SEEDANCE_GENERATION_MODE_MATRIX = Object.freeze({
  "seedance1.0": Object.freeze(["first_last_frame"]),
  "seedance1.0fast": Object.freeze(["first_last_frame", "smart_multiframe"]),
  "seedance1.5pro": Object.freeze(["first_last_frame"]),
  "seedance2.0": Object.freeze(["smart_params", "first_last_frame"]),
  "seedance2.5": Object.freeze(["smart_params", "first_last_frame", "smart_edit", "long_video"]),
});

export const seedanceModelFamily = (value = "") => {
  const model = String(value || "").trim().toLowerCase();
  if (!model) return "";
  if (/seedance[-_.]?1[-_.]?0.*fast|seedance1\.0fast/.test(model)) return "seedance1.0fast";
  if (/seedance[-_.]?1[-_.]?0|seedance1\.0/.test(model)) return "seedance1.0";
  if (/seedance[-_.]?1[-_.]?5.*pro|seedance1\.5pro/.test(model)) return "seedance1.5pro";
  if (/seedance[-_.]?2[-_.]?5|seedance2\.5/.test(model)) return "seedance2.5";
  if (/seedance[-_.]?2[-_.]?0|seedance2\.0|jimeng-video-s2\.0/.test(model)) return "seedance2.0";
  return "";
};

export const seedanceGenerationModesForModel = (value = "") => (
  [...(SEEDANCE_GENERATION_MODE_MATRIX[seedanceModelFamily(value)] || [])]
);

export const seedanceGenerationModeSupported = (model, mode) => {
  const family = seedanceModelFamily(model);
  return !family || seedanceGenerationModesForModel(family).includes(String(mode || "smart_params"));
};

const cleanPrompt = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 1_000);

const cleanDuration = (value, fallback = 4, minimum = SMART_MULTIFRAME_MIN_DURATION) => {
  const numeric = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : 4;
  const bounded = Number.isFinite(numeric) ? numeric : safeFallback;
  return Math.round(Math.min(SMART_MULTIFRAME_MAX_DURATION, Math.max(minimum, bounded)) * 2) / 2;
};

const parsedTransitions = (value) => {
  if (Array.isArray(value)) return value;
  if (!String(value ?? "").trim()) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const smartMultiframeTransitionCount = (frameCount) => Math.max(
  0,
  Math.min(SMART_MULTIFRAME_MAX_FRAMES, Math.max(0, Number(frameCount) || 0)) - 1,
);

export const normalizeSmartMultiframeTransitions = (value, {
  frameCount = 0,
  defaultDuration = 4,
} = {}) => {
  const source = parsedTransitions(value);
  const transitionCount = smartMultiframeTransitionCount(frameCount);
  const minimumDuration = transitionCount === 1 ? SMART_MULTIFRAME_MIN_TOTAL_DURATION : SMART_MULTIFRAME_MIN_DURATION;
  return Array.from({ length: transitionCount }, (_, index) => ({
    index,
    prompt: cleanPrompt(source[index]?.prompt),
    duration: cleanDuration(source[index]?.duration, defaultDuration, minimumDuration),
  }));
};

export const serializeSmartMultiframeTransitions = (value, options = {}) => JSON.stringify(
  normalizeSmartMultiframeTransitions(value, options),
);

export const defaultSmartMultiframeTransitionPrompt = (index = 0) => (
  `保持主体、构图和空间关系连续，从第 ${Number(index) + 1} 帧自然过渡到第 ${Number(index) + 2} 帧。`
);

export const compileSmartMultiframePrompt = (value, {
  frameCount = 0,
  defaultDuration = 4,
} = {}) => {
  const transitions = normalizeSmartMultiframeTransitions(value, { frameCount, defaultDuration });
  if (!transitions.length) return "";
  return [
    "按以下固定帧顺序生成连续视频；不得交换帧位或跳过中间帧：",
    ...transitions.map((item) => (
      `【第 ${item.index + 1} 帧 → 第 ${item.index + 2} 帧｜${item.duration} 秒】${item.prompt || defaultSmartMultiframeTransitionPrompt(item.index)}`
    )),
  ].join("\n");
};

const imageReference = (item = {}) => item.kind === "image" || String(item.mimeType || "").startsWith("image/");
const videoReference = (item = {}) => item.kind === "video" || String(item.mimeType || "").startsWith("video/");

export const smartEditOrderedReferences = (items = []) => {
  const references = Array.isArray(items) ? items : [];
  const primaryIndex = references.findIndex(videoReference);
  if (primaryIndex < 0) return references.slice(0, SMART_EDIT_MAX_ADDITIONAL_REFERENCES + 1);
  return [
    references[primaryIndex],
    ...references.filter((_, index) => index !== primaryIndex).slice(0, SMART_EDIT_MAX_ADDITIONAL_REFERENCES),
  ];
};

const smartEditReferenceKind = (item = {}) => {
  const explicit = String(item.kind || "").toLowerCase();
  if (["image", "video", "audio"].includes(explicit)) return explicit;
  const mimeType = String(item.mimeType || "").toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "unknown";
};

const smartEditVideoDuration = (item = {}) => {
  const seconds = Number(item.durationSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const milliseconds = Number(item.durationMs);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : 0;
};

export const smartEditReferenceValidation = (items = [], { requireKnownVideoDuration = true } = {}) => {
  const references = Array.isArray(items) ? items : [];
  const kinds = references.map(smartEditReferenceKind);
  if (!references.length || kinds[0] !== "video") {
    return { ok: false, code: "primary_video_required", message: "智能编辑的第一个槽位必须是编辑视频" };
  }
  if (references.length - 1 > SMART_EDIT_MAX_ADDITIONAL_REFERENCES) {
    return { ok: false, code: "too_many_references", message: `智能编辑的参考内容最多 ${SMART_EDIT_MAX_ADDITIONAL_REFERENCES} 项` };
  }
  if (kinds.includes("unknown")) {
    return { ok: false, code: "unsupported_reference", message: "智能编辑参考中包含无法识别的媒体类型" };
  }
  for (let index = 0; index < references.length; index += 1) {
    if (kinds[index] !== "video") continue;
    const durationSeconds = smartEditVideoDuration(references[index]);
    if (!durationSeconds && requireKnownVideoDuration) {
      return { ok: false, code: "video_duration_unknown", message: "智能编辑参考视频无法确认时长，未开始生成" };
    }
    if (durationSeconds > SMART_EDIT_MAX_VIDEO_DURATION_SECONDS + 0.001) {
      return { ok: false, code: "video_too_long", message: `智能编辑的单个视频不能超过 ${SMART_EDIT_MAX_VIDEO_DURATION_SECONDS} 秒` };
    }
  }
  return {
    ok: true,
    primary: references[0],
    additional: references.slice(1),
    ordered: references,
  };
};

export const videoReferencesForGenerationMode = (items, mode = "smart_params") => {
  const references = Array.isArray(items) ? items : [];
  if (mode === "first_last_frame") return references.filter(imageReference).slice(0, 2);
  if (mode === "smart_multiframe") return references.filter(imageReference);
  if (mode === "smart_edit") return smartEditOrderedReferences(references);
  return references;
};

export const smartMultiframeDurationTotal = (value, options = {}) => normalizeSmartMultiframeTransitions(value, options)
  .reduce((total, item) => total + item.duration, 0);
