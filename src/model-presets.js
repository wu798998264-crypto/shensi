import { DREAMINA_IMAGE_CLI_ALIAS, DREAMINA_IMAGE_CLI_ARGS, DREAMINA_VIDEO_CLI_ALIAS, DREAMINA_VIDEO_CLI_ARGS, LIBTV_CLI_ALIAS, LIBTV_CLI_ARGS } from "./media-cli-presets.js";
import {
  LONG_VIDEO_MAX_DURATION_SECONDS,
  LONG_VIDEO_MIN_DURATION_SECONDS,
  SMART_EDIT_MAX_ADDITIONAL_REFERENCES,
  SMART_EDIT_MAX_VIDEO_DURATION_SECONDS,
  seedanceGenerationModesForModel,
  seedanceModelFamily,
} from "./video-generation-sequence.js";

export const DEEPSEEK_OPENCODE_CLI_ALIAS = "shensi-deepseek-opencode";
export const DEEPSEEK_OPENCODE_CLI_ARGS = "--model {model}";

const speedTier = (id, name) => ({ id, name, description: "" });
const PRIORITY = speedTier("priority", "快速");
const FLEX = speedTier("flex", "灵活");

// Unknown providers use a context-aware budget; this value is only the
// conservative fallback when a model publishes no context/capability data.
export const DEFAULT_MODEL_MEDIA_REFERENCES = 32;
export const DEFAULT_WHITEBOARD_UPSTREAM_REFERENCES = 24;
// Process safety ceiling. Product limits are resolved per model below and are
// shared by the composer, preflight validator and request pipeline.
export const MAX_MODEL_MEDIA_REFERENCES = 256;
export const MAX_WHITEBOARD_UPSTREAM_REFERENCES = 50;
export const SEEDANCE_20_MAX_MEDIA_REFERENCES = 11;

const model = (slug, label, {
  reasoningLevels = [],
  defaultReasoningLevel = "",
  speedTiers = [],
  capabilities = [],
  inputCapabilities = [],
  durationSeconds = [],
  durationDerivedFromReference = false,
  resolutions = [],
  aspectRatios = [],
  generationModes = [],
  longVideoDurationSeconds = [],
  unavailableGenerationModes = [],
  adapters = [],
  maxMediaReferences,
  maxUpstreamReferences = DEFAULT_WHITEBOARD_UPSTREAM_REFERENCES,
  maxImageAttachments = 0,
  maxFileAttachments = 0,
  maxAttachmentBytes = 0,
  maxTotalAttachmentBytes = 0,
  available = true,
  availabilityNote = "",
  selectable = true,
  contextWindowTokens = 0,
  maxOutputTokens = 0,
} = {}) => ({ slug, label, reasoningLevels, defaultReasoningLevel, speedTiers, capabilities, inputCapabilities, durationSeconds, durationDerivedFromReference, resolutions, aspectRatios, generationModes, longVideoDurationSeconds, unavailableGenerationModes, adapters, maxMediaReferences, maxUpstreamReferences, maxImageAttachments, maxFileAttachments, maxAttachmentBytes, maxTotalAttachmentBytes, available, availabilityNote, selectable, contextWindowTokens, maxOutputTokens });

// Official GPT-6 API controls. Codex may additionally report account-specific
// options through its live catalog; do not assume those are valid API efforts.
const GPT6_ASTRA_MODEL = model("gpt-6-astra", "GPT-6 Astra", {
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  defaultReasoningLevel: "medium",
  speedTiers: [PRIORITY],
  contextWindowTokens: 1_050_000,
  maxOutputTokens: 128_000,
});

export const isGpt6AstraModel = (slug = "") => /^(?:openai\/)?gpt-6-astra$/iu.test(String(slug).trim());

export const OPENAI_MODEL_OPTIONS = [
  GPT6_ASTRA_MODEL,
  model("gpt-5.6-sol", "GPT-5.6 Sol", { reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5.6-terra", "GPT-5.6 Terra", { reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5.6-luna", "GPT-5.6 Luna", { reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5.5", "GPT-5.5", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5.4", "GPT-5.4", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5.4-mini", "GPT-5.4 Mini", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }),
  model("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }),
  model("gpt-5.1", "GPT-5.1", { reasoningLevels: ["none", "low", "medium", "high"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5.1-codex", "GPT-5.1 Codex", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }),
  model("gpt-5.1-codex-max", "GPT-5.1 Codex Max", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "high" }),
  model("gpt-5.1-codex-mini", "GPT-5.1 Codex Mini", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }),
  model("gpt-5", "GPT-5", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "medium", speedTiers: [PRIORITY] }),
  model("gpt-5-pro", "GPT-5 Pro", { reasoningLevels: ["high"], defaultReasoningLevel: "high" }),
  model("gpt-5-mini", "GPT-5 Mini", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "medium" }),
  model("gpt-5-nano", "GPT-5 Nano", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "low" }),
  model("gpt-5-codex", "GPT-5 Codex", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }),
  model("gpt-4.1", "GPT-4.1"),
  model("gpt-4.1-mini", "GPT-4.1 Mini"),
  model("gpt-4.1-nano", "GPT-4.1 Nano"),
  model("gpt-4o", "GPT-4o"),
  model("gpt-4o-mini", "GPT-4o Mini"),
  model("gpt-image-2", "GPT Image 2.0", { capabilities: ["image_generation"] }),
  model("gpt-image-1.5", "GPT Image 1.5", { capabilities: ["image_generation"] }),
  model("gpt-image-1", "GPT Image 1", { capabilities: ["image_generation"] }),
  model("sora-2", "Sora 2", {
    capabilities: ["video_generation"],
    durationSeconds: [4, 8, 12],
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    generationModes: ["smart_params"],
  }),
  model("sora-2-pro", "Sora 2 Pro", {
    capabilities: ["video_generation"],
    durationSeconds: [4, 8, 12],
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    generationModes: ["smart_params"],
  }),
  model("o3-pro", "o3 Pro", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "high" }),
  model("o3", "o3", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }),
  model("o4-mini", "o4 Mini", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }),
];

// LibTV models are addressed by their stable modelKey in ShenSi, while the
// official CLI receives the corresponding modelName. These entries expose
// the currently published catalog without coupling the text model registry.
export const LIBTV_IMAGE_MODEL_OPTIONS = [
  model("lib-image-2", "Lib Image", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("nebula-ultra", "General image Pro", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("nebula-2-flash", "General image V2", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("doubao-seedream-5-0-pro", "Seedream 5.0 Pro", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("qwen-image-3", "Qwen image 3.0", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("mj-v8.2", "Style Image V8.2", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("mj-v8.1", "Style Image V8.1", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("mj-v7", "Style Image V7", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("mj-niji7", "Style Image Niji 7", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("jimeng-4.6", "Seedream 4.6", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("seedream-5", "Seedream 5.0 Lite", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("seedream-4.5", "Seedream 4.5", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("z-image", "Z-image Turbo", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("nebula-core", "General image", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("qwen", "Qwen Image", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("qwen-edit", "Qwen Edit", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
  model("seedream-4", "Seedream 4.0", { capabilities: ["image_generation"], inputCapabilities: ["image_input"] }),
];

export const LIBTV_VIDEO_MODEL_OPTIONS = [
  model("star-video2.5", "Seedance 2.5", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 27 }, (_, index) => index + 4), resolutions: ["480p", "720p"] }),
  model("star-video2", "Seedance 2.0 VIP", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p", "1080p"] }),
  model("MiniMax-Hailuo-H3-Max", "Minimax H3 Max", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 11 }, (_, index) => index + 5), resolutions: ["768P", "2K"] }),
  model("MiniMax-Hailuo-H3", "Minimax H3", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 11 }, (_, index) => index + 5), resolutions: ["768P", "2K"] }),
  model("star-video2-fast", "Seedance 2.0 Fast VIP", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p", "1080p"] }),
  model("star-video2-mini", "Seedance 2.0 Mini", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p", "1080p"] }),
  model("wanx3.0-prime", "Wan 3.0 Prime", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 29 }, (_, index) => index + 2), resolutions: ["720p", "1080p"] }),
  model("wanx3.0", "Wan 3.0", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 29 }, (_, index) => index + 2), resolutions: ["720p", "1080p"] }),
  model("happy-horse-1.1", "Happy Horse 1.1", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
  model("happy-horse-1", "Happy Horse 1.0", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
  model("kling-v3-omni", "Kling O3", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["1080p", "4k"] }),
  model("kling-v3-turbo", "Kling 3.0 Turbo", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["1080p"] }),
  model("kling-video-o3", "Kling 3.0", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 11 }, (_, index) => index + 5), resolutions: ["1080p"] }),
  model("wanx2.7-video", "Wan 2.7", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 9 }, (_, index) => index + 2), resolutions: ["720p", "1080p"] }),
  model("kling-video-o1", "Kling O1", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: [5, 10], resolutions: ["1080p"] }),
  model("wanxiang-v2-6", "Wan 2.6", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
  model("MiniMax-Hailuo-2.3-Fast", "Hailuo 2.3 Fast", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [6, 10], resolutions: ["768P", "2K"] }),
  model("MiniMax-Hailuo-2.3", "Hailuo 2.3", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [6, 10], resolutions: ["768P", "2K"] }),
  model("seedance-1.5-pro", "Seedance1.5 Pro", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["720p"] }),
  model("doubao-seedance-pro", "Seedance 1.0 Pro", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
  model("doubao-seedance-lite", "Seedance 1.0 Lite", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["720p"] }),
  model("kling-v2-6", "Kling 2.6", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["1080p"] }),
  model("kling-v3-motion-control", "Kling3.0 动作迁移", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input"], durationSeconds: [], durationDerivedFromReference: true, resolutions: ["1080p"] }),
  model("midjourney-video", "Style Video", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5], resolutions: ["720p"] }),
  model("MiniMax-Hailuo-o2", "Hailuo 02", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [6, 10], resolutions: ["720p"] }),
  model("viduq2", "Vidu Q2", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: Array.from({ length: 8 }, (_, index) => index + 1), resolutions: ["1080p"] }),
  model("viduq2-pro", "Vidu Q2 Pro", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: Array.from({ length: 8 }, (_, index) => index + 1), resolutions: ["1080p"] }),
  model("viduq2-turbo", "Vidu Q2 Turbo", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: Array.from({ length: 8 }, (_, index) => index + 1), resolutions: ["1080p"] }),
  model("viduq3-pro", "Vidu Q3 Pro", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: Array.from({ length: 16 }, (_, index) => index + 1), resolutions: ["1080p"] }),
  model("omnihuman-1.5", "OmniHuman 1.5", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "audio_input"], durationSeconds: [], durationDerivedFromReference: true, resolutions: ["1080p"] }),
  model("kling-v2-5-turbo-pro", "Kling 2.5", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
  model("kling-2.1", "Kling 2.1", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
  model("wanxiang-plus", "Wan 2.2", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5], resolutions: ["720p"] }),
  model("wanxiang-preview", "Wan 2.5", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 10], resolutions: ["720p"] }),
  model("pixverse-v5.5", "Pixverse V5.5", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 8, 10], resolutions: ["720p"] }),
  model("pixverse-v5", "Pixverse V5", { capabilities: ["video_generation"], inputCapabilities: ["image_input"], durationSeconds: [5, 8], resolutions: ["720p"] }),
];

export const LIBTV_AUDIO_MODEL_OPTIONS = [
  model("seed-audio-1.0", "Seed Audio 1.0", { capabilities: ["audio_generation"], inputCapabilities: ["audio_input"] }),
  model("speech-2.8-hd", "Minimax-speech-2.8-hd", { capabilities: ["audio_generation"] }),
  model("speech-2.8-turbo", "Minimax-speech-2.8-turbo", { capabilities: ["audio_generation"] }),
  model("vocal-v3", "Eleven V3", { capabilities: ["audio_generation"] }),
  model("vocal-music", "Eleven Music V3", { capabilities: ["audio_generation"] }),
  model("mureka-8", "Mureka V8", { capabilities: ["audio_generation"] }),
];

export const PROVIDER_MODEL_OPTIONS = {
  OpenAI: OPENAI_MODEL_OPTIONS,
  Kimi: [
    model("kimi-k3", "Kimi K3", {
      reasoningLevels: ["low", "high", "max"],
      defaultReasoningLevel: "max",
      inputCapabilities: ["image_input"],
    }),
    model("kimi-k2.5", "Kimi K2.5", {
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
      inputCapabilities: ["image_input"],
    }),
  ],
  DeepSeek: [
    model("deepseek-v4-pro", "DeepSeek V4 Pro（质量优先）", { reasoningLevels: ["none", "high", "max"], defaultReasoningLevel: "high", contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 }),
    model("deepseek-v4-flash", "DeepSeek V4 Flash 0731（最新·速度优先）", { reasoningLevels: ["none", "high", "max"], defaultReasoningLevel: "high", contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 }),
    model("deepseek-chat", "DeepSeek Chat（已退役别名）", { reasoningLevels: ["none"], defaultReasoningLevel: "none", selectable: false, available: false, availabilityNote: "官方已于 2026-07-24 停止该别名" }),
    model("deepseek-reasoner", "DeepSeek Reasoner（已退役别名）", { reasoningLevels: ["high", "max"], defaultReasoningLevel: "high", selectable: false, available: false, availabilityNote: "官方已于 2026-07-24 停止该别名" }),
  ],
  Grok: [
    model("grok-imagine-image-quality", "Grok Imagine Image Quality", { capabilities: ["image_generation"] }),
    model("grok-imagine-image", "Grok Imagine Image", { capabilities: ["image_generation"] }),
    model("grok-4.5", "Grok 4.5", { reasoningLevels: ["none", "low", "medium", "high"], defaultReasoningLevel: "low" }),
    model("grok-4.3", "Grok 4.3", { reasoningLevels: ["none", "low", "medium", "high"], defaultReasoningLevel: "low" }),
    model("grok-4.20-0309-reasoning", "Grok 4.20 Reasoning", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }),
    model("grok-4.20-0309-non-reasoning", "Grok 4.20 Non-Reasoning"),
    model("grok-4.20-multi-agent-0309", "Grok 4.20 Multi-Agent", { reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }),
    model("grok-build-0.1", "Grok Build 0.1"),
  ],
  Gemini: [
    model("gemini-3.1-flash-image", "Nano Banana 2（Gemini 3.1 Flash Image）", { capabilities: ["image_generation"] }),
    model("gemini-3-pro-image", "Nano Banana Pro（Gemini 3 Pro Image）", { capabilities: ["image_generation"] }),
    model("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite（Gemini 3.1 Flash Lite Image）", { capabilities: ["image_generation"] }),
    model("gemini-2.5-flash-image", "Gemini 2.5 Flash Image", { capabilities: ["image_generation"] }),
    model("gemini-3.5-flash", "Gemini 3.5 Flash", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "medium" }),
    model("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", { reasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "high" }),
    model("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "minimal" }),
    model("gemini-3-flash", "Gemini 3 Flash", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "high" }),
    model("gemini-3-flash-preview", "Gemini 3 Flash Preview", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "high" }),
    model("gemini-2.5-pro", "Gemini 2.5 Pro", { reasoningLevels: ["minimal", "low", "medium", "high"], defaultReasoningLevel: "high" }),
    model("gemini-2.5-flash", "Gemini 2.5 Flash", { reasoningLevels: ["none", "minimal", "low", "medium", "high"], defaultReasoningLevel: "medium" }),
    model("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", { reasoningLevels: ["none", "minimal", "low", "medium", "high"], defaultReasoningLevel: "low" }),
  ],
  Claude: [
    model("claude-fable-5", "Claude Fable 5", { reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "high" }),
    model("claude-opus-4-8", "Claude Opus 4.8", { reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "high" }),
    model("claude-sonnet-5", "Claude Sonnet 5", { reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "high" }),
    model("claude-haiku-4-5", "Claude Haiku 4.5"),
    model("claude-sonnet-4-6", "Claude Sonnet 4.6", { reasoningLevels: ["low", "medium", "high", "max"], defaultReasoningLevel: "high" }),
  ],
  LibTV: [
    ...LIBTV_IMAGE_MODEL_OPTIONS,
    ...LIBTV_VIDEO_MODEL_OPTIONS,
    ...LIBTV_AUDIO_MODEL_OPTIONS,
  ],
  "智谱 GLM": [
    model("cogview-4-250304", "CogView 4", { capabilities: ["image_generation"] }),
    model("cogview-3-flash", "CogView 3 Flash", { capabilities: ["image_generation"] }),
    model("glm-5.2", "GLM-5.2", { reasoningLevels: ["none", "max"], defaultReasoningLevel: "max" }),
    model("glm-5.1", "GLM-5.1", { reasoningLevels: ["none"], defaultReasoningLevel: "" }),
    model("glm-5", "GLM-5", { reasoningLevels: ["none"], defaultReasoningLevel: "" }),
    model("glm-5-turbo", "GLM-5 Turbo"),
    model("glm-4.7", "GLM-4.7", { reasoningLevels: ["none"], defaultReasoningLevel: "" }),
    model("glm-4.7-flashx", "GLM-4.7 FlashX", { reasoningLevels: ["none"] }),
    model("glm-4.7-flash", "GLM-4.7 Flash", { reasoningLevels: ["none"] }),
    model("glm-4.6", "GLM-4.6", { reasoningLevels: ["none"] }),
    model("glm-4.5-air", "GLM-4.5 Air", { reasoningLevels: ["none"] }),
    model("glm-4.5-airx", "GLM-4.5 AirX", { reasoningLevels: ["none"] }),
    model("glm-4-long", "GLM-4 Long"),
    model("glm-4-flashx-250414", "GLM-4 FlashX 250414"),
    model("glm-4-flash-250414", "GLM-4 Flash 250414"),
  ],
  "即梦": [
    model("doubao-seedream-5-0-260128", "即梦图片 5.0（Seedream 5.0）", { capabilities: ["image_generation"], adapters: ["api"] }),
    model("doubao-seedream-5-0-lite-260128", "即梦图片 5.0 Lite（Seedream 5.0 Lite）", { capabilities: ["image_generation"], adapters: ["api"] }),
    model("jimeng-image-5.0-pro", "即梦图片 5.0 Pro", { capabilities: ["image_generation"], adapters: ["api"], available: false, availabilityNote: "当前公开 API 未提供该型号，请改用即梦 CLI" }),
    model("t2i_v40_jimeng", "即梦图片 4.0", { capabilities: ["image_generation"], adapters: ["api"] }),
    model("5.0Pro", "即梦图片 5.0 Pro（即梦 CLI）", {
      capabilities: ["image_generation"], inputCapabilities: ["image_input"], adapters: ["cli"],
      resolutions: ["1.5k", "2k", "4k"], aspectRatios: ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],
    }),
    ...["5.0", "4.7", "4.6", "4.5", "4.1", "4.0"].map((version) => model(version, `即梦图片 ${version}（即梦 CLI）`, {
      capabilities: ["image_generation"], inputCapabilities: ["image_input"], adapters: ["cli"],
      resolutions: ["2k", "4k"], aspectRatios: ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],
    })),
    ...["3.1", "3.0"].map((version) => model(version, `即梦图片 ${version}（即梦 CLI）`, {
      capabilities: ["image_generation"], adapters: ["cli"],
      resolutions: ["1k", "2k"], aspectRatios: ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],
    })),
    model("jimeng-video-3.0-pro", "即梦视频 3.0 Pro", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16", "1:1"], generationModes: seedanceGenerationModesForModel("seedance2.0"), adapters: ["api"],
    }),
    model("jimeng-video-3.0", "即梦视频 3.0", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1"], generationModes: seedanceGenerationModesForModel("seedance2.0"), adapters: ["api"],
    }),
    model("jimeng-video-s2.0-pro", "即梦视频 S2.0 Pro", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16", "1:1"], generationModes: seedanceGenerationModesForModel("seedance2.0"), adapters: ["api"],
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("doubao-seedance-2-0-260128", "即梦视频 2.0（Seedance 2.0）", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16", "1:1"], generationModes: seedanceGenerationModesForModel("seedance2.0"), adapters: ["api"],
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("doubao-seedance-2-0-fast-260128", "即梦视频 2.0 Fast（Seedance 2.0 Fast）", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16", "1:1"], generationModes: seedanceGenerationModesForModel("seedance2.0fast"), adapters: ["api"],
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("doubao-seedance-1-5-pro-251215", "即梦视频 1.5 Pro（Seedance 1.5 Pro）", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16", "1:1"], generationModes: seedanceGenerationModesForModel("seedance1.5pro"), adapters: ["api"],
    }),
    model("jimeng-video-1.5", "即梦视频 1.5", {
      capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p"],
      adapters: ["api"],
      available: false, availabilityNote: "火山方舟未公开独立的 Seedance 1.5 非 Pro API ID，请使用 Seedance 1.5 Pro",
    }),
    model("seedance2.0fast", "Seedance 2.0 Fast（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input", "native_video_input", "audio_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance2.0fast"),
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("seedance2.0", "Seedance 2.0（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input", "native_video_input", "audio_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance2.0"),
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("seedance2.0_vip", "Seedance 2.0 VIP（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input", "native_video_input", "audio_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p", "1080p", "4k"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance2.0_vip"),
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("seedance2.0fast_vip", "Seedance 2.0 Fast VIP（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input", "native_video_input", "audio_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance2.0fast_vip"),
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("seedance2.0mini", "Seedance 2.0 Mini（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input", "native_video_input", "audio_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 12 }, (_, index) => index + 4), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance2.0mini"),
      maxMediaReferences: SEEDANCE_20_MAX_MEDIA_REFERENCES,
    }),
    model("seedance2.5", "Seedance 2.5（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input", "native_video_input", "audio_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 27 }, (_, index) => index + 4), resolutions: ["480p", "720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance2.5"),
      longVideoDurationSeconds: Array.from({ length: LONG_VIDEO_MAX_DURATION_SECONDS - LONG_VIDEO_MIN_DURATION_SECONDS + 1 }, (_, index) => LONG_VIDEO_MIN_DURATION_SECONDS + index),
      maxMediaReferences: 50, maxUpstreamReferences: 50,
    }),
    model("seedance1.5pro", "Seedance 1.5 Pro（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 9 }, (_, index) => index + 4), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance1.5pro"),
    }),
    model("seedance1.0fast", "Seedance 1.0 Fast（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 8 }, (_, index) => index + 3), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance1.0fast"),
      maxMediaReferences: 20,
    }),
    model("seedance1.0", "Seedance 1.0（即梦 CLI）", {
      capabilities: ["video_generation"], inputCapabilities: ["image_input"], adapters: ["cli"],
      durationSeconds: Array.from({ length: 8 }, (_, index) => index + 3), resolutions: ["720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], generationModes: seedanceGenerationModesForModel("seedance1.0"),
    }),
  ],
  "可灵": [
    model("kling-video-3.0-omni", "可灵视频 3.0 Omni", { capabilities: ["video_generation"], durationSeconds: [5, 10, 15], resolutions: ["1080p", "4k"] }),
    model("kling-video-3.0", "可灵视频 3.0", { capabilities: ["video_generation"], durationSeconds: [5, 10, 15], resolutions: ["1080p", "4k"] }),
    model("kling-video-o1", "可灵视频 O1", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["1080p"] }),
    model("kling-video-2.6", "可灵视频 2.6", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["1080p"] }),
    model("kling-video-2.5-turbo", "可灵视频 2.5 Turbo", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
    model("kling-video-2.1", "可灵视频 2.1", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
    model("kling-video-2.0", "可灵视频 2.0", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
    model("kling-video-1.6", "可灵视频 1.6", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p", "1080p"] }),
    model("kling-video-1.5", "可灵视频 1.5", { capabilities: ["video_generation"], durationSeconds: [5, 10], resolutions: ["720p"] }),
  ],
  "阿里云百炼": [
    model("wan2.7-t2v-2026-04-25", "Wan 2.7 · 文生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 14 }, (_, index) => index + 2), resolutions: ["720p", "1080p"] }),
    model("wan2.7-i2v-2026-04-25", "Wan 2.7 · 首尾帧/续写视频", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input", "audio_input"], durationSeconds: Array.from({ length: 14 }, (_, index) => index + 2), resolutions: ["720p", "1080p"] }),
    model("wan2.7-r2v-2026-06-12", "Wan 2.7 · 参考生视频", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("wan2.7-videoedit", "Wan 2.7 · 视频编辑", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "video_input"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p"] }),
    model("wan2.6-t2v", "Wan 2.6 · 文生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 14 }, (_, index) => index + 2), resolutions: ["480p", "720p", "1080p"] }),
    model("wan2.6-i2v-flash", "Wan 2.6 · 首帧生视频", { capabilities: ["video_generation"], inputCapabilities: ["image_input", "audio_input"], durationSeconds: Array.from({ length: 14 }, (_, index) => index + 2), resolutions: ["480p", "720p", "1080p"] }),
    model("happyhorse-1.1-t2v", "HappyHorse 1.1 · 文生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("happyhorse-1.1-i2v", "HappyHorse 1.1 · 首帧生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("happyhorse-1.1-r2v", "HappyHorse 1.1 · 参考生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("happyhorse-1.0-t2v", "HappyHorse 1.0 · 文生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("happyhorse-1.0-i2v", "HappyHorse 1.0 · 首帧生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("happyhorse-1.0-r2v", "HappyHorse 1.0 · 参考生视频", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
    model("happyhorse-1.0-video-edit", "HappyHorse 1.0 · 视频编辑", { capabilities: ["video_generation"], durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3), resolutions: ["720p", "1080p"] }),
  ],
  "免费模型": [
    // The public Kilo gateway is intentionally only a small offline fallback.
    // Refreshing the connection replaces this with its live /models catalog.
    model("poolside/laguna-s-2.1:free", "Laguna S 2.1", { contextWindowTokens: 262_144 }),
    model("kilo-auto/free", "Auto", { contextWindowTokens: 256_000, maxOutputTokens: 10_000 }),
    model("stepfun/step-3.7-flash:free", "Step 3.7 Flash", { contextWindowTokens: 262_144 }),
    model("tencent/hy3:free", "Hy3", { contextWindowTokens: 262_144 }),
    model("meituan/longcat-2.0-free", "LongCat 2.0", { contextWindowTokens: 1_048_756 }),
  ],
  "自定义兼容接口": [GPT6_ASTRA_MODEL],
};

const currentProviderId = (provider) => provider === "公益模型" ? "免费模型" : provider;

export const getProviderModelOptions = (provider) => PROVIDER_MODEL_OPTIONS[currentProviderId(provider)] ?? [];

export const getProviderImageModelOptions = (provider, adapter = "") => {
  // "自定义兼容接口" 的图片通道遵循 OpenAI Images 兼容协议。提供
  // 标准 GPT Image 目录，但仍允许调用方保留服务端发现的自定义模型。
  const models = currentProviderId(provider) === "自定义兼容接口"
    ? OPENAI_MODEL_OPTIONS
    : getProviderModelOptions(provider);
  return models.filter((item) => item.capabilities?.includes("image_generation") && (!adapter || !item.adapters?.length || item.adapters.includes(adapter)));
};

export const getProviderVideoModelOptions = (provider, adapter = "") => getProviderModelOptions(provider)
  .filter((item) => item.capabilities?.includes("video_generation") && (!adapter || !item.adapters?.length || item.adapters.includes(adapter)));

export const getProviderAudioModelOptions = (provider, adapter = "") => getProviderModelOptions(provider)
  .filter((item) => item.capabilities?.includes("audio_generation") && (!adapter || !item.adapters?.length || item.adapters.includes(adapter)));

export const getModelOption = (provider, slug, dynamicModels = []) => {
  const dynamic = dynamicModels.find((item) => item.slug === slug);
  const preset = getProviderModelOptions(provider).find((item) => item.slug === slug)
    ?? (["OpenAI", "自定义兼容接口"].includes(provider) && isGpt6AstraModel(slug) ? GPT6_ASTRA_MODEL : null);
  if (!dynamic) return preset;
  return { ...preset, ...dynamic };
};

// Shared capability contract for composer UI, preflight validation and model
// adapters. Unknown provider limits use the context budget, never a legacy
// fixed attachment count.
export const modelAttachmentCapabilities = (settings = {}, dynamicModels = []) => {
  const option = getModelOption(settings.provider, settings.model, dynamicModels) ?? {};
  const input = new Set(option.inputCapabilities ?? []);
  const contextWindowTokens = Number(option.contextWindowTokens || 0);
  const adaptiveCount = contextWindowTokens >= 200_000 ? 128 : contextWindowTokens >= 100_000 ? 64 : 32;
  const declaredTotal = settings.maxMediaReferences ?? option.maxMediaReferences;
  const requestedTotal = Number(declaredTotal);
  const maxTotal = Math.min(
    MAX_MODEL_MEDIA_REFERENCES,
    declaredTotal != null && declaredTotal !== "" && Number.isFinite(requestedTotal) && requestedTotal >= 0
      ? Math.floor(requestedTotal)
      : adaptiveCount,
  );
  const declaredMultimodal = multimodalInputCapabilities(settings, dynamicModels);
  const imageInput = declaredMultimodal.imageInput !== false && (input.has("image_input") || option.multimodal === true || declaredMultimodal.imageInput !== false);
  const fileInput = option.fileInput !== false;
  return {
    imageInput,
    fileInput,
    maxImages: imageInput ? Math.min(maxTotal, Number(option.maxImageAttachments || option.maxImages || 0) || maxTotal) : 0,
    maxFiles: fileInput ? Math.min(maxTotal, Number(option.maxFileAttachments || option.maxFiles || 0) || maxTotal) : 0,
    maxTotal,
    maxFileBytes: Number(option.maxAttachmentBytes || option.maxFileBytes || 0) || 25 * 1024 * 1024,
    maxTotalBytes: Number(option.maxTotalAttachmentBytes || option.maxTotalBytes || 0) || adaptiveCount * 25 * 1024 * 1024,
    contextWindowTokens,
    source: option.slug ? "model" : "adaptive-provider",
  };
};

const declaredInputCapabilities = (settings, option) => {
  const values = [
    ...(Array.isArray(settings?.inputCapabilities) ? settings.inputCapabilities : []),
    ...(Array.isArray(option?.inputCapabilities) ? option.inputCapabilities : []),
    ...(Array.isArray(option?.capabilities) ? option.capabilities : []),
  ];
  return new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
};

export const multimodalInputCapabilities = (settings = {}, dynamicModels = []) => {
  const provider = String(settings.provider ?? "");
  const slug = String(settings.model ?? "").toLowerCase();
  const option = getModelOption(provider, settings.model, dynamicModels);
  const declared = declaredInputCapabilities(settings, option);
  if (declared.has("text_only") || declared.has("no_multimodal_input")) {
    return { imageInput: false, nativeVideoInput: false, videoInput: false, audioInput: false, multimodal: false, exact: true };
  }
  const explicitImage = declared.has("image_input") || declared.has("vision_input");
  const explicitVideo = declared.has("video_input");
  const explicitNativeVideo = declared.has("native_video_input");
  const explicitAudio = declared.has("audio_input");
  if (explicitImage || explicitVideo || explicitNativeVideo || explicitAudio) {
    return {
      imageInput: explicitImage,
      nativeVideoInput: explicitNativeVideo,
      videoInput: explicitNativeVideo || explicitVideo || explicitImage,
      audioInput: explicitAudio,
      multimodal: true,
      exact: true,
    };
  }
  if (declared.has("image_generation") || declared.has("video_generation")) {
    return { imageInput: true, nativeVideoInput: false, videoInput: true, audioInput: false, multimodal: true, exact: true };
  }
  if (settings.adapter === "cli" && provider === "OpenAI") {
    return { imageInput: true, nativeVideoInput: false, videoInput: true, audioInput: false, multimodal: true, exact: true };
  }
  if (!slug) {
    return { imageInput: null, nativeVideoInput: null, videoInput: null, audioInput: null, multimodal: null, exact: false };
  }
  if (provider === "DeepSeek") {
    return { imageInput: false, nativeVideoInput: false, videoInput: false, audioInput: false, multimodal: false, exact: true };
  }
  if (provider === "智谱 GLM") {
    const vision = /(?:vision|\bvl\b|\d+v(?:-|$))/i.test(slug);
    return { imageInput: vision, nativeVideoInput: false, videoInput: vision, audioInput: false, multimodal: vision, exact: true };
  }
  if (provider === "OpenAI" && /^(?:gpt-|o\d)/i.test(slug)) {
    return { imageInput: true, nativeVideoInput: false, videoInput: true, audioInput: /(?:audio|realtime|gpt-4o)/i.test(slug), multimodal: true, exact: true };
  }
  if (["Gemini", "Claude", "Grok"].includes(provider) && slug) {
    return { imageInput: true, nativeVideoInput: provider === "Gemini" && settings.adapter === "api", videoInput: true, audioInput: provider === "Gemini" && settings.adapter === "api", multimodal: true, exact: true };
  }
  return { imageInput: null, nativeVideoInput: null, videoInput: null, audioInput: null, multimodal: null, exact: false };
};

const boundedReferenceLimit = (value, fallback, maximum, { allowZero = false } = {}) => {
  const numeric = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isFinite(numeric) || numeric < minimum) return fallback;
  return Math.min(maximum, Math.floor(numeric));
};

export const modelReferenceLimits = (settings = {}, { channel = "", dynamicModels = [] } = {}) => {
  const option = getModelOption(settings?.provider, settings?.model, dynamicModels);
  const maxUpstreamReferences = boundedReferenceLimit(
    settings?.maxUpstreamReferences ?? option?.maxUpstreamReferences,
    DEFAULT_WHITEBOARD_UPSTREAM_REFERENCES,
    MAX_WHITEBOARD_UPSTREAM_REFERENCES,
  );
  let maxMediaReferences = boundedReferenceLimit(
    settings?.maxMediaReferences ?? option?.maxMediaReferences,
    DEFAULT_MODEL_MEDIA_REFERENCES,
    MAX_MODEL_MEDIA_REFERENCES,
    { allowZero: true },
  );
  if (channel === "text" && multimodalInputCapabilities(settings, dynamicModels).multimodal === false) {
    maxMediaReferences = 0;
  }
  return {
    maxUpstreamReferences,
    maxMediaReferences,
    exact: Boolean(option || settings?.maxUpstreamReferences != null || settings?.maxMediaReferences != null),
  };
};

export const whiteboardConnectionReferenceLimits = (settings = null, options = {}) => {
  const hasResolvedModel = Boolean(
    settings
    && typeof settings === "object"
    && (settings.model || settings.maxUpstreamReferences != null || settings.maxMediaReferences != null)
  );
  if (hasResolvedModel) return { ...modelReferenceLimits(settings, options), structural: false };
  return {
    maxUpstreamReferences: MAX_WHITEBOARD_UPSTREAM_REFERENCES,
    maxMediaReferences: MAX_MODEL_MEDIA_REFERENCES,
    exact: false,
    structural: true,
  };
};

const videoReferencePolicyResult = ({ image = 0, video = 0, audio = 0, maxTotal = 0, exactImageCount = null, exact = true } = {}) => ({
  acceptedTypes: [
    ...(image > 0 ? ["image"] : []),
    ...(video > 0 ? ["video"] : []),
    ...(audio > 0 ? ["audio"] : []),
  ],
  maxByType: { image, video, audio },
  maxTotal,
  exactImageCount,
  exact,
});

// Reference acceptance must mirror the concrete provider driver instead of
// guessing that every video model is a one-image i2v endpoint. Unknown custom
// endpoints are only enabled when their input capabilities are declared.
export const videoReferencePolicy = (settings = {}, { generationMode = "smart_params", dynamicModels = [] } = {}) => {
  const provider = String(settings?.provider || "");
  const adapter = String(settings?.adapter || "").toLowerCase();
  const slug = String(settings?.model || "").toLowerCase();
  const option = getModelOption(provider, settings?.model, dynamicModels);
  const maxTotal = boundedReferenceLimit(
    settings?.maxMediaReferences ?? option?.maxMediaReferences,
    DEFAULT_MODEL_MEDIA_REFERENCES,
    MAX_MODEL_MEDIA_REFERENCES,
    { allowZero: true },
  );
  const mode = String(generationMode || "smart_params");

  if (provider === "OpenAI" && adapter === "api" && /sora/.test(slug)) {
    return videoReferencePolicyResult({ image: 1, maxTotal: 1 });
  }
  if (provider === "即梦" && adapter === "cli" && /seedance2\.5/.test(slug)) {
    if (mode === "first_last_frame") return videoReferencePolicyResult({ image: 2, maxTotal: 2, exactImageCount: 2 });
    if (mode === "smart_edit") return {
      ...videoReferencePolicyResult({
        image: SMART_EDIT_MAX_ADDITIONAL_REFERENCES,
        video: SMART_EDIT_MAX_ADDITIONAL_REFERENCES + 1,
        audio: SMART_EDIT_MAX_ADDITIONAL_REFERENCES,
        maxTotal: SMART_EDIT_MAX_ADDITIONAL_REFERENCES + 1,
      }),
      minByType: { image: 0, video: 1, audio: 0 },
      maxAdditionalReferences: SMART_EDIT_MAX_ADDITIONAL_REFERENCES,
      maxVideoDurationSeconds: SMART_EDIT_MAX_VIDEO_DURATION_SECONDS,
    };
    // Composite long video is orchestrated by Shensi as native-length segments.
    // References are retained and prioritized per segment instead of being
    // silently discarded as if the provider exposed a single native 300s job.
    if (mode === "long_video") return videoReferencePolicyResult({
      image: Math.min(30, maxTotal),
      video: Math.min(10, maxTotal),
      audio: Math.min(10, maxTotal),
      maxTotal,
    });
    return videoReferencePolicyResult({
      image: Math.min(30, maxTotal),
      video: Math.min(10, maxTotal),
      audio: Math.min(10, maxTotal),
      maxTotal,
    });
  }
  if (provider === "即梦" && adapter === "cli" && /seedance2\.0/.test(slug)) {
    if (mode === "first_last_frame") return videoReferencePolicyResult({ image: 2, maxTotal: 2, exactImageCount: 2 });
    return videoReferencePolicyResult({ image: maxTotal, video: Math.min(3, maxTotal), audio: Math.min(3, maxTotal), maxTotal });
  }
  if (provider === "即梦" && adapter === "cli" && /seedance1\.5/.test(slug)) {
    return videoReferencePolicyResult({ image: 2, maxTotal: 2, exactImageCount: 2 });
  }
  if (provider === "即梦" && adapter === "cli" && /seedance1\.0/.test(slug)) {
    if (mode === "smart_multiframe" && /seedance1\.0fast/.test(slug)) return {
      ...videoReferencePolicyResult({ image: Math.min(20, maxTotal), maxTotal: Math.min(20, maxTotal) }),
      minByType: { image: 2, video: 0, audio: 0 },
    };
    return videoReferencePolicyResult({ image: 2, maxTotal: 2, exactImageCount: 2 });
  }
  if (provider === "即梦" && adapter === "api") {
    return mode === "first_last_frame"
      ? videoReferencePolicyResult({ image: 2, maxTotal: 2, exactImageCount: 2 })
      : videoReferencePolicyResult({ image: maxTotal, maxTotal });
  }
  if (provider === "阿里云百炼") {
    if (/(?:^|-)t2v(?:-|$)/.test(slug)) return videoReferencePolicyResult({ exact: true });
    if (/2\.7-i2v/.test(slug)) {
      return videoReferencePolicyResult({ image: 2, video: 1, audio: 1, maxTotal, exactImageCount: mode === "first_last_frame" ? 2 : null });
    }
    if (/(?:r2v|videoedit)/.test(slug)) {
      return videoReferencePolicyResult({ image: maxTotal, video: Math.min(3, maxTotal), maxTotal });
    }
    if (/2\.6-i2v/.test(slug)) return videoReferencePolicyResult({ image: 1, audio: 1, maxTotal: Math.min(2, maxTotal) });
    if (/(?:^|-)i2v(?:-|$)/.test(slug)) {
      return mode === "first_last_frame"
        ? videoReferencePolicyResult({ image: 2, maxTotal: 2, exactImageCount: 2 })
        : videoReferencePolicyResult({ image: 1, maxTotal: 1 });
    }
  }
  if (provider === "可灵") return videoReferencePolicyResult({ image: 1, maxTotal: 1 });

  const declared = declaredInputCapabilities(settings, option);
  const explicitImage = declared.has("image_input") || declared.has("vision_input");
  const explicitVideo = declared.has("video_input") || declared.has("native_video_input");
  const explicitAudio = declared.has("audio_input");
  if (explicitImage || explicitVideo || explicitAudio) {
    return videoReferencePolicyResult({
      image: explicitImage ? maxTotal : 0,
      video: explicitVideo ? maxTotal : 0,
      audio: explicitAudio ? maxTotal : 0,
      maxTotal,
      exactImageCount: mode === "first_last_frame" && explicitImage ? 2 : null,
      exact: true,
    });
  }
  return videoReferencePolicyResult({ exact: false });
};

export const supportedSpeedModes = (modelOption) => {
  const tierIds = new Set((modelOption?.speedTiers ?? []).map((tier) => typeof tier === "string" ? tier : tier.id));
  return [
    ...(tierIds.has("priority") ? ["fast"] : []),
    ...(tierIds.has("flex") ? ["flex"] : []),
  ];
};

export const imageGenerationMode = (settings = {}, dynamicModels = []) => {
  if (settings.adapter === "cli") return settings.cliPath ? "media_cli" : "";
  if (settings.adapter !== "api") return "";
  if (settings.imageChannel === true || settings.imageChannel === "true") return "images_api";
  const slug = String(settings.model ?? "").toLowerCase();
  const option = getModelOption(settings.provider, settings.model, dynamicModels);
  if (option?.capabilities?.includes("image_generation") || /(?:image|imagen|cogview|nano[-_ ]?banana)/i.test(slug)) return "images_api";
  if (settings.provider === "OpenAI" && settings.protocol === "responses" && /^(?:gpt-5|gpt-4\.1|gpt-4o)/i.test(slug)) return "responses_tool";
  return "";
};

export const resolveImageGenerationSettings = (settings = {}, dynamicModels = []) => {
  const imageModel = String(settings.imageModel ?? "").trim();
  if (imageModel) {
    const imageProvider = String(settings.imageProvider || "OpenAI");
    const preset = getProviderPreset(imageProvider);
    const mayReusePrimaryKey = settings.adapter === "api" && settings.provider === imageProvider;
    return {
      ...settings,
      adapter: settings.imageAdapter === "cli" ? "cli" : "api",
      provider: imageProvider,
      protocol: "chat_completions",
      baseUrl: String(settings.imageBaseUrl || preset.api.baseUrl || "").trim(),
      model: imageModel,
      apiKey: String(settings.imageApiKey || (mayReusePrimaryKey ? settings.apiKey : "")).trim(),
      cliPath: String(settings.imageCliPath || "").trim(),
      cliArgs: String(settings.imageCliArgs || "").trim(),
      imageChannel: true,
    };
  }
  return imageGenerationMode(settings, dynamicModels) ? { ...settings } : null;
};

export const videoGenerationMode = (settings = {}, dynamicModels = []) => {
  if (settings.adapter === "cli") return settings.cliPath ? "media_cli" : "";
  if (settings.adapter !== "api") return "";
  const option = getModelOption(settings.provider, settings.model, dynamicModels);
  const slug = String(settings.model ?? "").toLowerCase();
  return option?.capabilities?.includes("video_generation") || /(?:sora|video|veo|kling|hailuo|seedance|wan[-_]?video)/i.test(slug)
    ? "videos_api"
    : "";
};

export const resolveVideoGenerationSettings = (settings = {}, dynamicModels = []) => {
  const model = String(settings.videoModel ?? "").trim();
  if (!model) return null;
  const provider = String(settings.videoProvider || "OpenAI");
  const preset = getProviderPreset(provider);
  const mayReusePrimaryKey = settings.adapter === "api" && settings.provider === provider;
  const resolved = {
    ...settings,
    adapter: settings.videoAdapter === "cli" ? "cli" : "api",
    provider,
    protocol: String(settings.videoProtocol || "videos"),
    baseUrl: String(settings.videoBaseUrl || preset.api.baseUrl || "").trim(),
    model,
    apiKey: String(settings.videoApiKey || (mayReusePrimaryKey ? settings.apiKey : "")).trim(),
    cliPath: String(settings.videoCliPath || "").trim(),
    cliArgs: String(settings.videoCliArgs || "").trim(),
    timeoutMs: String(settings.videoTimeoutMs || settings.timeoutMs || "900000"),
    videoChannel: true,
  };
  return videoGenerationMode(resolved, dynamicModels) ? resolved : null;
};

export const videoModelCapabilities = (provider, slug, dynamicModels = []) => {
  const option = getModelOption(provider, slug, dynamicModels);
  const builtIn = getProviderModelOptions(provider).find((item) => item.slug === slug) ?? null;
  const family = seedanceModelFamily(slug);
  const exactGenerationModes = family ? seedanceGenerationModesForModel(slug) : [];
  const durationDerivedFromReference = option?.durationDerivedFromReference === true || builtIn?.durationDerivedFromReference === true;
  const valueList = (key, fallback) => option?.[key]?.length
    ? option[key]
    : builtIn?.[key]?.length
      ? builtIn[key]
      : fallback;
  return {
    durationSeconds: durationDerivedFromReference ? [] : valueList("durationSeconds", Array.from({ length: 15 }, (_, index) => index + 1)),
    durationDerivedFromReference,
    resolutions: valueList("resolutions", ["480p", "720p", "1080p", "4k"]),
    aspectRatios: valueList("aspectRatios", ["16:9", "9:16", "1:1", "4:3", "3:4"]),
    // Remote /v1/models-style lists commonly expose only IDs. A sparse
    // dynamic record must never widen a known Seedance family's modes.
    generationModes: exactGenerationModes.length
      ? exactGenerationModes
      : valueList("generationModes", ["smart_params", "first_last_frame", "smart_multiframe"]),
    longVideoDurationSeconds: valueList("longVideoDurationSeconds", []),
    unavailableGenerationModes: Array.isArray(option?.unavailableGenerationModes) && option.unavailableGenerationModes.length
      ? option.unavailableGenerationModes
      : Array.isArray(builtIn?.unavailableGenerationModes) ? builtIn.unavailableGenerationModes : [],
    exact: Boolean(option || builtIn),
  };
};

export const imageModelCapabilities = (provider, slug, dynamicModels = []) => {
  const option = getModelOption(provider, slug, dynamicModels);
  return {
    resolutions: option?.resolutions?.length ? option.resolutions : ["standard", "high"],
    aspectRatios: option?.aspectRatios?.length ? option.aspectRatios : ["1:1", "16:9", "9:16", "4:3", "3:4"],
    exact: Boolean(option),
  };
};

export const webSearchMode = (settings = {}) => {
  if (settings.adapter === "cli") {
    if (settings.provider !== "OpenAI") return "";
    const executable = String(settings.cliPath ?? "")
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      .replace(/\.(?:exe|cmd|bat)$/i, "")
      .toLowerCase();
    return executable === "codex" || /@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(settings.cliArgs ?? "")
      ? "codex_cli"
      : "";
  }
  if (settings.adapter !== "api") return "";
  if (settings.provider === "Claude") return "anthropic_tool";
  if (["OpenAI", "Grok"].includes(settings.provider) && settings.protocol === "responses") return "responses_tool";
  return "";
};

export const isImageGenerationRequest = (text, settings = {}, dynamicModels = []) => {
  if (!imageGenerationMode(settings, dynamicModels)) return false;
  const slug = String(settings.model ?? "").toLowerCase();
  const option = getModelOption(settings.provider, settings.model, dynamicModels);
  const imageOnlyModel = option?.capabilities?.includes("image_generation")
    || /(?:^|[-_])(image|imagen|cogview)(?:[-_]|$)|nano[-_ ]?banana/i.test(slug);
  if (imageOnlyModel) return true;
  const prompt = String(text ?? "").trim();
  if (!prompt) return false;
  if (/(?:如何|怎么|为什么|能否|可不可以|是否).{0,16}(?:生成|绘制|画|制作|创建).{0,10}(?:图片|图像|插画|封面|海报|头像|logo|标志)/i.test(prompt)) return false;
  return /(?:^|[，。！？\s])(?:请|帮我|给我|直接|现在|按照|根据|参考|把|将|用)?[^，。！？\n]{0,24}(?:生成|绘制|画出|制作|创建|设计)(?:一|这|几|多)?(?:张|幅|个)?(?:图片|图像|插画|封面|海报|角色图|场景图|视觉图|头像|logo|标志)|(?:^|[，。！？\s])(?:请|帮我|给我|直接)?生图/i.test(prompt);
};

export const sanitizeModelControls = (settings = {}, dynamicModels = []) => {
  const modelOption = getModelOption(settings.provider, settings.model, dynamicModels);
  const reasoningLevels = new Set(modelOption?.reasoningLevels ?? []);
  const speedModes = new Set(supportedSpeedModes(modelOption));
  return {
    ...settings,
    reasoningEffort: reasoningLevels.has(settings.reasoningEffort) ? settings.reasoningEffort : "",
    speedMode: speedModes.has(settings.speedMode) ? settings.speedMode : "default",
  };
};

export const PROVIDER_PRESETS = [
  {
    id: "OpenAI",
    label: "OpenAI",
    api: { protocol: "responses", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
    cli: { path: "codex", args: "exec --sandbox read-only --skip-git-repo-check --ephemeral --color never -", testArgs: ["--version"], apiKeyEnv: "OPENAI_API_KEY", workspaceAgent: true },
  },
  {
    id: "Kimi",
    label: "Kimi (Moonshot AI)",
    api: { protocol: "chat_completions", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k3" },
    cli: { path: "", args: "", testArgs: ["--version"], apiKeyEnv: "MOONSHOT_API_KEY" },
  },
  {
    id: "DeepSeek",
    label: "DeepSeek",
    api: { protocol: "chat_completions", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
    cli: { path: DEEPSEEK_OPENCODE_CLI_ALIAS, args: DEEPSEEK_OPENCODE_CLI_ARGS, testArgs: ["--version"], apiKeyEnv: "DEEPSEEK_API_KEY" },
  },
  {
    id: "Grok",
    label: "Grok（xAI）",
    api: { protocol: "responses", baseUrl: "https://api.x.ai/v1", model: "grok-4.5" },
    cli: {
      path: "grok",
      args: "--no-auto-update --single \"@{promptFile}\" --output-format plain --model {model}",
      testArgs: ["version"],
      apiKeyEnv: "XAI_API_KEY",
    },
  },
  {
    id: "Gemini",
    label: "Gemini（Google）",
    api: {
      protocol: "chat_completions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.5-flash",
    },
    cli: { path: "gemini", args: "--model {model}", testArgs: ["--version"], apiKeyEnv: "GEMINI_API_KEY", workspaceAgent: true },
  },
  {
    id: "Claude",
    label: "Claude（Anthropic）",
    api: { protocol: "chat_completions", baseUrl: "https://api.anthropic.com/v1", model: "claude-fable-5" },
    cli: {
      path: "claude",
      args: "-p --model {model} --output-format text --no-session-persistence",
      testArgs: ["--version"],
      apiKeyEnv: "ANTHROPIC_API_KEY",
      workspaceAgent: true,
    },
  },
  {
    id: "Trae Work",
    label: "Trae Work",
    api: { protocol: "chat_completions", baseUrl: "", model: "" },
    cli: { path: "trae", args: "{promptFile}", testArgs: ["--version"], apiKeyEnv: "", workspaceAgent: true },
    custom: true,
  },
  {
    id: "WorkBuddy",
    label: "WorkBuddy",
    api: { protocol: "chat_completions", baseUrl: "", model: "" },
    cli: { path: "workbuddy", args: "{promptFile}", testArgs: ["--version"], apiKeyEnv: "", workspaceAgent: true },
    custom: true,
  },
  {
    id: "智谱 GLM",
    label: "GLM（智谱 AI）",
    api: { protocol: "chat_completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2" },
    cli: {
      path: "claude",
      args: "-p --model {model} --output-format text --no-session-persistence",
      testArgs: ["--version"],
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic" },
      workspaceAgent: true,
    },
  },
  {
    id: "即梦",
    label: "即梦（火山引擎）",
    api: { protocol: "media", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedance-1-5-pro-251215" },
    imageCli: { path: DREAMINA_IMAGE_CLI_ALIAS, args: DREAMINA_IMAGE_CLI_ARGS, testArgs: ["--check"], apiKeyEnv: "" },
    cli: { path: DREAMINA_VIDEO_CLI_ALIAS, args: DREAMINA_VIDEO_CLI_ARGS, testArgs: ["--version"], apiKeyEnv: "" },
  },
  {
    id: "LibTV",
    label: "LibTV",
    api: { protocol: "media", baseUrl: "", model: "lib-image-2" },
    cli: { path: LIBTV_CLI_ALIAS, args: LIBTV_CLI_ARGS, testArgs: ["--version"], apiKeyEnv: "" },
    mediaCli: true,
  },
  {
    id: "可灵",
    label: "可灵（快手）",
    api: { protocol: "media", baseUrl: "https://api-singapore.klingai.com", model: "kling-video-3.0" },
    cli: { path: "", args: "", testArgs: ["--version"], apiKeyEnv: "KLING_API_KEY" },
  },
  {
    id: "阿里云百炼",
    label: "阿里云百炼",
    api: { protocol: "media", baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "happyhorse-1.1-t2v" },
    cli: { path: "", args: "", testArgs: ["--version"], apiKeyEnv: "DASHSCOPE_API_KEY" },
  },
  {
    id: "自定义兼容接口",
    label: "自定义兼容接口",
    api: { protocol: "chat_completions", baseUrl: "", model: "" },
    cli: { path: "", args: "", testArgs: ["--version"], apiKeyEnv: "" },
    custom: true,
  },
  {
    id: "免费模型",
    label: "限免模型",
    api: { protocol: "chat_completions", baseUrl: "https://api.kilo.ai/api/openrouter", model: "poolside/laguna-s-2.1:free" },
    cli: { path: "", args: "", testArgs: ["--version"], apiKeyEnv: "" },
    public: true,
    availabilityNote: "无需 Key；服务可能限流、变更或记录提示词",
  },
];

export const PROVIDER_PRESET_MAP = Object.fromEntries(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
PROVIDER_PRESET_MAP["公益模型"] = PROVIDER_PRESET_MAP["免费模型"];

export const getProviderPreset = (provider) => PROVIDER_PRESET_MAP[provider] ?? PROVIDER_PRESET_MAP["自定义兼容接口"];

const WORKSPACE_AGENT_COMMANDS = new Set(["codex", "claude", "gemini", "opencode"]);

export const isWorkspaceAgentSettings = (settings = {}) => {
  if (settings.adapter !== "cli") return false;
  const preset = getProviderPreset(settings.provider);
  const executable = String(settings.cliPath || preset.cli.path || "").replaceAll("\\", "/").split("/").at(-1).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return WORKSPACE_AGENT_COMMANDS.has(executable)
    || preset.cli.workspaceAgent === true && /@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(settings.cliArgs ?? "");
};
