const text = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n").trim();

const EXPLICIT_ARCHIVE_PATTERN = /(?:把|将|请把|请将)?(?:以下|下面|这份|这些|这段|本段|上述)?(?:原始)?(?:内容|素材|资料|原文|设定|故事|大纲).{0,18}(?:存入|保存到|归档到|放入|收入)(?:当前作品的)?资料库|(?:存入|保存到|归档到|放入|收入)(?:当前作品的)?资料库.{0,18}(?:以下|下面|这份|这些|这段|本段|上述)?(?:原始)?(?:内容|素材|资料|原文|设定|故事|大纲)/u;
const CREATIVE_BASIS_PATTERN = /(?:根据|基于|使用|采用|以)(?:以下|下面|下述|这份|这些|这段|本段|上述|此)?(?:的)?(?:内容|素材|资料|原文|设定|故事|大纲).{0,24}(?:为基础|作为基础|创作|续写|改写|写作|生成)|(?:以下|下面|下述)(?:是|为|提供)?(?:我)?(?:构建好|整理好|写好|准备好)?(?:的)?(?:内容|素材|资料|原文|设定|故事|大纲).{0,30}(?:为基础|作为基础|进行创作|创作|续写|改写|写作|生成)/u;
const META_QUESTION_PATTERN = /^(?:请问|我想知道|帮我分析)?[^。！!？?\n]{0,40}(?:能否|是否|会不会|可不可以|为什么|为何|怎么|如何|什么情况下)[^。！!？?\n]{0,80}(?:素材|资料|原文|资料库)|^(?:请问|我想知道|帮我分析)?[^。！!？?\n]{0,40}(?:素材|资料|原文|资料库)[^。！!？?\n]{0,80}(?:能否|是否|会不会|可不可以|为什么|为何|怎么|如何|什么情况下)/u;

const hasSubstantialPayload = (source, minimumCharacters) => {
  const newline = source.indexOf("\n");
  if (newline < 0) return false;
  return source.slice(newline + 1).replace(/\s+/gu, "").length >= minimumCharacters;
};

export const inlineSourceArchiveCandidate = ({ value = "", minimumCreativeCharacters = 500 } = {}) => {
  const source = text(value);
  if (!source || META_QUESTION_PATTERN.test(source)) return null;
  const explicitArchive = EXPLICIT_ARCHIVE_PATTERN.test(source);
  const creativeBasis = CREATIVE_BASIS_PATTERN.test(source);
  if (!explicitArchive && !creativeBasis) return null;
  const minimumCharacters = explicitArchive ? 80 : Math.max(200, Number(minimumCreativeCharacters) || 500);
  if (!hasSubstantialPayload(source, minimumCharacters)) return null;
  return {
    kind: "inline_original_source",
    authority: "reference_untrusted",
    exactText: source,
    reason: explicitArchive ? "explicit_library_archive" : "explicit_creative_basis",
  };
};
