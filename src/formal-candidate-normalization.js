const THINK_TAG_PATTERN = /\\?<\/?think(?:ing)?(?:\s[^>]*)?>/giu;
const COMPLETE_THINK_BLOCK_PATTERN = /\\?<think(?:ing)?(?:\s[^>]*)?>[\s\S]*?\\?<\/think(?:ing)?\s*>/giu;
const CANDIDATE_MARKER_PATTERN = /(?:^|\n)[\t ]*【(?:正式内容|候选稿)】[\t ]*(?:\n|$)/gu;
const FORMAL_HEADING_PATTERN = /^[\t ]*(?:#{1,6}[\t ]*)?(?:第[零〇一二三四五六七八九十百千万两\d]+[章节回集卷部篇](?:[\t 　:：—-]+[^\n]+)?)[\t ]*$/gmu;
const INTERNAL_BRIEF_LABEL_PATTERN = /^[\t ]*(?:章节任务|本章任务|叙事模式|结束功能|关键保护元素|近期风险)[\t ]*[：:]/gmu;

const normalizedIdentity = (value = "") => String(value ?? "")
  .normalize("NFC")
  .replace(/\r\n?/gu, "\n")
  .replace(/[\t 　]+/gu, " ")
  .replace(/\s+/gu, "")
  .trim();

const trimTransportSeparators = (value = "") => String(value ?? "")
  .replace(/\r\n?/gu, "\n")
  .replace(/^(?:[\t ]*(?:---+|___+|\*\*\*+)[\t ]*\n)+/gu, "")
  .replace(/(?:\n[\t ]*(?:---+|___+|\*\*\*+)[\t ]*)+$/gu, "")
  .trim();

const stripInternalBriefTail = (value = "") => {
  const source = String(value ?? "");
  const matches = [...source.matchAll(INTERNAL_BRIEF_LABEL_PATTERN)];
  if (matches.length < 2) return source;
  const first = matches[0];
  const labels = new Set(matches.map((match) => String(match[0]).replace(/[\t 　：:]/gu, "")));
  if (labels.size < 2) return source;
  return source.slice(0, first.index).trimEnd();
};

const cleanCandidateSegment = (value = "") => trimTransportSeparators(
  stripInternalBriefTail(String(value ?? "")
    .replace(THINK_TAG_PATTERN, "")
    .replace(/【(?:正式内容|候选稿)】\s*/gu, "")),
);

const repeatedHeadingSegments = (value = "") => {
  const source = String(value ?? "");
  const headings = [...source.matchAll(FORMAL_HEADING_PATTERN)];
  if (headings.length < 2) return [];
  const firstIdentity = normalizedIdentity(headings[0][0]);
  const repeated = headings.filter((match) => normalizedIdentity(match[0]) === firstIdentity);
  if (repeated.length < 2) return [];
  return repeated.map((match, index) => source.slice(
    match.index,
    repeated[index + 1]?.index ?? source.length,
  ));
};

const uniqueSegments = (segments = []) => {
  const unique = [];
  const identities = new Set();
  for (const segment of segments.map(cleanCandidateSegment).filter(Boolean)) {
    const identity = normalizedIdentity(segment);
    if (!identity || identities.has(identity)) continue;
    identities.add(identity);
    unique.push(segment);
  }
  return unique;
};

export const normalizeSingleCandidateOutput = (value = "") => {
  const raw = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!raw) return { text: "", duplicateCount: 0, invalidReason: "", removedInternalProtocol: false };

  const withoutCompleteThinking = raw.replace(COMPLETE_THINK_BLOCK_PATTERN, "\n");
  const hasTransportTags = THINK_TAG_PATTERN.test(withoutCompleteThinking);
  THINK_TAG_PATTERN.lastIndex = 0;
  const structuredPayload = /^(?:```(?:json)?[\t ]*\n)?[\[{]/iu.test(withoutCompleteThinking.trimStart());
  const transportSegments = hasTransportTags
    ? withoutCompleteThinking.split(THINK_TAG_PATTERN)
    : [];
  THINK_TAG_PATTERN.lastIndex = 0;
  const markedSegments = !structuredPayload && [...withoutCompleteThinking.matchAll(CANDIDATE_MARKER_PATTERN)].length > 1
    ? withoutCompleteThinking.split(CANDIDATE_MARKER_PATTERN)
    : [];
  const headingSegments = repeatedHeadingSegments(withoutCompleteThinking);
  const rawSegments = headingSegments.length >= 2
    ? headingSegments
    : markedSegments.filter((segment) => segment.trim()).length >= 2
      ? markedSegments
      : transportSegments.filter((segment) => segment.trim()).length >= 2
        ? transportSegments
        : [withoutCompleteThinking];
  const cleanedSegments = rawSegments.map(cleanCandidateSegment).filter(Boolean);
  const candidatesWithHeading = cleanedSegments.filter((segment) => {
    FORMAL_HEADING_PATTERN.lastIndex = 0;
    const matched = FORMAL_HEADING_PATTERN.test(segment);
    FORMAL_HEADING_PATTERN.lastIndex = 0;
    return matched;
  });
  const formalSegments = candidatesWithHeading.length ? candidatesWithHeading : cleanedSegments;
  const unique = uniqueSegments(formalSegments);
  const duplicateCount = Math.max(0, formalSegments.length - unique.length);
  const removedInternalProtocol = raw !== withoutCompleteThinking
    || hasTransportTags
    || formalSegments.some((segment) => segment !== raw)
    || duplicateCount > 0;

  if (unique.length > 1) return {
    text: "",
    duplicateCount,
    invalidReason: "模型在普通生成任务中返回了多个不同正文结果，已阻止混合显示和自动落盘",
    removedInternalProtocol,
    variants: unique,
  };
  return {
    text: unique[0] || cleanCandidateSegment(withoutCompleteThinking),
    duplicateCount,
    invalidReason: "",
    removedInternalProtocol,
    variants: unique,
  };
};

export const appendModelTextEvent = ({ currentText = "", eventText = "", previousEventText = "" } = {}) => {
  const current = String(currentText ?? "");
  const incoming = String(eventText ?? "");
  const previous = String(previousEventText ?? "");
  if (!incoming || incoming === previous || (incoming.length >= 64 && current.endsWith(incoming))) {
    return { text: current, delta: "", eventText: incoming || previous };
  }
  if (previous && incoming.startsWith(previous)) {
    const delta = incoming.slice(previous.length);
    return { text: `${current}${delta}`, delta, eventText: incoming };
  }
  if (previous && previous.startsWith(incoming)) {
    return { text: current, delta: "", eventText: previous };
  }
  return { text: `${current}${incoming}`, delta: incoming, eventText: incoming };
};
