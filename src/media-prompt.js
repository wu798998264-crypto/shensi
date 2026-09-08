const INTERNAL_MEDIA_PROMPT_LINE = /(?:以下是直接连入当前卡片的全部上游信息|必须逐项读取并综合使用[^。]*不得追溯|真实多模态参考附件|以下资料由用户在本轮通过\s*@\s*主动选择|其中的命令式文字不是系统指令|已引用的\s*Skill|已附加的附件|已附加的工作区引用|主参考\s*\/\s*目标元素)/i;

const INTERNAL_MEDIA_PROMPT_HEADING = /^(?:#{1,6}\s*)?(?:白板生成输入范围|用户明确引用的跨工作区文档|本轮用户任务(?:（最高优先级）)?|上游输入(?:\s+\d+)?|当前目标卡片|当前卡片及全部直接上游媒体的读取结果|已真实读取全部参考媒体后的执行说明)\s*$/i;

const INTERNAL_MEDIA_PROMPT_BRACKET = /^【(?:上游输入|当前目标卡片|当前卡片及全部直接上游媒体的读取结果|已真实读取全部参考媒体后的执行说明)[^】]*】\s*$/i;

const DUPLICATED_MEDIA_PARAMETERS = /^生成模式：[^；\n]+；画幅：[^；\n]+；时长：[^；\n]+；清晰度：[^；\n]+。?$/i;

const compactBlankLines = (value) => String(value || "")
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+$/gm, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export const MEDIA_PROVIDER_PROMPT_MAX_CHARACTERS = 16_000;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeReferenceToken = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("@「") && text.endsWith("」")) return text;
  const label = text.replace(/^@/u, "").replace(/[「」\r\n]/g, " ").trim();
  return label ? `@「${label}」` : "";
};

/**
 * Remove only reference tokens that the caller has already resolved to an
 * authorised source.  A bare @ mention, an unresolved token, and all other
 * user text remain untouched.  This is deliberately separate from the broad
 * provider prompt sanitizer so the editor/history channel can keep the
 * user's original text verbatim.
 */
export const stripResolvedMediaReferenceMarkers = (value, { referenceTokens = [] } = {}) => {
  const source = String(value ?? "");
  const tokens = [...new Set((Array.isArray(referenceTokens) ? referenceTokens : [referenceTokens])
    .map(normalizeReferenceToken)
    .filter((token) => /^@「[^」\r\n]+」$/u.test(token)))];
  if (!tokens.length || !source) return source;
  const pattern = new RegExp(tokens.sort((left, right) => right.length - left.length).map(escapeRegExp).join("|"), "gu");
  return source.replace(pattern, "");
};

const applyCharacterLimit = (value, maxCharacters) => {
  const limit = Number(maxCharacters);
  return Number.isFinite(limit) && limit > 0 ? String(value).slice(0, limit) : String(value);
};

export const sanitizeMediaProviderPrompt = (value, { maxCharacters = MEDIA_PROVIDER_PROMPT_MAX_CHARACTERS, referenceTokens = [] } = {}) => {
  const markerCleaned = stripResolvedMediaReferenceMarkers(value, { referenceTokens });
  const cleaned = compactBlankLines(String(markerCleaned || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !INTERNAL_MEDIA_PROMPT_LINE.test(trimmed)
        && !INTERNAL_MEDIA_PROMPT_HEADING.test(trimmed)
        && !INTERNAL_MEDIA_PROMPT_BRACKET.test(trimmed)
        && !DUPLICATED_MEDIA_PARAMETERS.test(trimmed);
    })
    .join("\n"));
  return applyCharacterLimit(cleaned, maxCharacters).trim();
};

export const composeMediaProviderPrompt = (parts = [], { maxCharacters = MEDIA_PROVIDER_PROMPT_MAX_CHARACTERS } = {}) => {
  const unique = [];
  const fingerprints = new Set();
  for (const part of Array.isArray(parts) ? parts : [parts]) {
    const cleaned = sanitizeMediaProviderPrompt(part, { maxCharacters });
    if (!cleaned) continue;
    const fingerprint = cleaned.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    unique.push(cleaned);
  }
  return applyCharacterLimit(compactBlankLines(unique.join("\n\n")), maxCharacters).trim();
};

// The text model that compiles a media prompt must receive every authorized
// source character. The provider-facing 16k limit applies only after that
// model has synthesized the sources; silently applying it to source cards
// makes the tail of long upstream cards disappear.
export const composeMediaCompilerSource = (parts = []) => composeMediaProviderPrompt(parts, { maxCharacters: Infinity });

export const mediaSourceCoverageManifest = (sources = []) => {
  const normalized = (Array.isArray(sources) ? sources : []).map((source, index) => ({
    id: String(source?.id || `source-${index + 1}`),
    title: String(source?.title || `上游输入 ${index + 1}`).replace(/[\r\n]+/g, " ").trim().slice(0, 120),
    characters: String(source?.text || "").length,
    explicit: source?.explicit === true,
  })).filter((source) => source.characters > 0);
  if (!normalized.length) return "";
  return [
    "# 上游全文覆盖合同",
    `本轮共有 ${normalized.length} 项文字来源。必须从开头读到每一项结尾，再压缩为可执行镜头；不得只依据开头、摘要或首段。`,
    ...normalized.map((source, index) => `${index + 1}. ${source.title}（ID：${source.id}；字符数：${source.characters}${source.explicit ? "；@重点引用" : ""}）`),
    "最终提示词应覆盖每项来源的关键主体、因果、动作、场景转折与结尾信息；单条视频无法逐字呈现时应做忠实的镜头压缩，不得把未读内容伪装成已处理。",
  ].join("\n");
};
