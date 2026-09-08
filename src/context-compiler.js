import { normalizeContextAuthority } from "./context-source-policy.js";

export const contextCompilationBudget = ({
  modelContextCharacters = 96_000,
  mode = "creative",
  selectedDocumentCount = 1,
} = {}) => {
  const modelBudget = Number.isFinite(Number(modelContextCharacters)) && Number(modelContextCharacters) > 0
    ? Number(modelContextCharacters)
    : 96_000;
  const share = mode === "general" ? 0.38 : 0.58;
  const floor = mode === "general" ? 32_000 : 56_000;
  const ceiling = mode === "general" ? 96_000 : 180_000;
  const maxCharacters = Math.min(ceiling, Math.max(floor, Math.floor(modelBudget * share)));
  const divisor = Math.max(4, Math.min(10, Number(selectedDocumentCount) || 1));
  const perDocumentLimit = Math.min(24_000, Math.max(6_000, Math.floor(maxCharacters / divisor)));
  return { maxCharacters, perDocumentLimit };
};

const normalize = (value) => String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

const queryTerms = (value) => Array.from(new Set(String(value ?? "")
  .toLowerCase()
  .match(/[\p{Script=Han}]{2,8}|[a-z0-9_-]{3,}/gu) ?? []))
  .flatMap((term) => /^[\p{Script=Han}]+$/u.test(term) && term.length > 3
    ? [term, ...Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))]
    : [term])
  .filter((term) => term.length >= 2)
  .slice(0, 80);

const searchTokens = (value) => {
  const source = String(value ?? "").toLowerCase();
  const tokens = [];
  for (const match of source.matchAll(/[\p{Script=Han}]+|[a-z0-9_-]{2,}/gu)) {
    const token = match[0];
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 4) tokens.push(token);
      for (let size = 2; size <= Math.min(3, token.length); size += 1) {
        for (let index = 0; index <= token.length - size; index += 1) tokens.push(token.slice(index, index + size));
      }
    } else {
      tokens.push(token);
    }
  }
  return tokens.slice(0, 20_000);
};

const frequencyMap = (tokens) => {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
};

export const rankRelevantDocuments = ({ ids = [], query = "", titleFor = () => "", contentFor = () => "", limit = 20 } = {}) => {
  const uniqueIds = [...new Set(ids)];
  const rawTerms = queryTerms(query).map(normalize).filter(Boolean);
  const terms = [...new Set([...rawTerms, ...searchTokens(query)])].slice(0, 120);
  if (!terms.length) return [];
  const corpus = uniqueIds.map((id, index) => {
    const title = String(titleFor(id) ?? "");
    const content = String(contentFor(id) ?? "");
    const titleTokens = searchTokens(title);
    const contentTokens = searchTokens(content);
    return {
      id,
      index,
      title,
      content,
      normalizedTitle: normalize(title),
      normalizedContent: normalize(content),
      titleFrequencies: frequencyMap(titleTokens),
      contentFrequencies: frequencyMap(contentTokens),
      length: Math.max(1, contentTokens.length),
    };
  });
  const averageLength = corpus.reduce((sum, item) => sum + item.length, 0) / Math.max(1, corpus.length);
  const documentFrequency = new Map(terms.map((term) => [term, corpus.filter((item) => (
    item.titleFrequencies.has(term) || item.contentFrequencies.has(term)
  )).length]));
  const normalizedQuery = normalize(query);
  return corpus.map((item) => {
    const matchedTerms = [];
    let score = 0;
    for (const term of terms) {
      const titleFrequency = item.titleFrequencies.get(term) ?? 0;
      const contentFrequency = item.contentFrequencies.get(term) ?? 0;
      if (!titleFrequency && !contentFrequency) continue;
      matchedTerms.push(term);
      const frequency = contentFrequency + titleFrequency * 3;
      const documentCount = corpus.length;
      const containing = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(1 + ((documentCount - containing + 0.5) / (containing + 0.5)));
      const normalization = frequency + 1.2 * (1 - 0.75 + 0.75 * (item.length / averageLength));
      score += inverseDocumentFrequency * ((frequency * 2.2) / Math.max(0.001, normalization));
    }
    if (normalizedQuery && item.normalizedTitle.includes(normalizedQuery)) score += 12;
    if (normalizedQuery && item.normalizedContent.includes(normalizedQuery)) score += 5;
    return { id: item.id, index: item.index, score, matchedTerms: [...new Set(matchedTerms)] };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit));
};

export const rankRelevantDocumentIds = ({ ids = [], query = "", titleFor = () => "", contentFor = () => "", limit = 20 }) => {
  const uniqueIds = [...new Set(ids)];
  const ranked = rankRelevantDocuments({ ids: uniqueIds, query, titleFor, contentFor, limit });
  const rankedIds = ranked.map(({ id }) => id);
  return [...rankedIds, ...uniqueIds.filter((id) => !rankedIds.includes(id))]
    .slice(0, Math.max(0, limit));
};

const relevantBlocks = (text, query) => {
  const terms = queryTerms(query).map(normalize);
  if (!terms.length) return [];
  const headingSections = text.split(/(?=^#{1,2}\s)/m);
  const blocks = headingSections.length > 1 ? headingSections : text.split(/\n{2,}/m);
  return blocks.map((block, index) => ({
    block: block.trim(),
    index,
    score: terms.reduce((total, term) => total + (normalize(block).includes(term) ? 10 + term.length : 0), 0)
      + (/\[(?:INFO|STATE):[^\]]+\]/.test(block) ? 2 : 0),
  })).filter(({ block, score }) => block && score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index);
};

const FOCUSED_QUERY_NOISE = new Set([
  "只读取", "只查看", "仅读取", "仅查看", "读取", "查看", "调用", "调取", "加载", "分析",
  "完整当前档案", "当前档案", "人物档案", "角色档案", "完整档案", "档案", "设定", "资料", "状态", "完整", "当前",
  "人物", "角色", "物品", "道具", "地点", "势力", "组织", "概念", "规则", "事件", "伏笔",
]);

const focusedHeadingSections = (text, query) => {
  const terms = queryTerms(query).map(normalize).filter((term) => !FOCUSED_QUERY_NOISE.has(term));
  if (!terms.length) return [];
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
    start: match.index,
    level: match[1].length,
    title: match[2],
    score: terms.reduce((total, term) => total + (normalize(match[2]).includes(term) ? 30 + term.length * 4 : 0), 0),
  }));
  const matched = headings.filter(({ score }) => score > 0);
  if (!matched.length) return [];
  const highest = Math.max(...matched.map(({ score }) => score));
  const strongest = matched.filter(({ score }) => score === highest);
  const deepest = Math.max(...strongest.map(({ level }) => level));
  return strongest.filter(({ level }) => level === deepest).map((heading) => {
    const next = headings.find((candidate) => candidate.start > heading.start && candidate.level <= heading.level);
    return text.slice(heading.start, next?.start ?? text.length).trim();
  }).filter(Boolean);
};

export const excerptContextContent = (value, limit = 6000, { query = "", preserveLatest = false, focused = false } = {}) => {
  const text = String(value ?? "").trim();
  const matches = relevantBlocks(text, query);
  if (focused) {
    const focusedSections = focusedHeadingSections(text, query);
    const focusedMatches = focusedSections.length ? focusedSections.map((block) => ({ block })) : matches;
    if (!focusedMatches.length) return { text: "", truncated: Boolean(text), matched: false, focused: true };
    const selected = [];
    let used = 0;
    for (const { block } of focusedMatches) {
      if (used + block.length + 2 > limit) continue;
      selected.push(block);
      used += block.length + 2;
      if (selected.length >= 8) break;
    }
    const result = selected.join("\n\n").slice(0, limit);
    return { text: result, truncated: result.length < text.length, matched: true, focused: true };
  }
  if (text.length <= limit) return { text, truncated: false };
  if (matches.length) {
    const marker = "\n\n……（已按本轮问题召回相关段落）……\n\n";
    const selected = [];
    let used = marker.length;
    for (const { block } of matches) {
      if (used + block.length > limit * 0.78) continue;
      selected.push(block);
      used += block.length + 2;
      if (selected.length >= 6) break;
    }
    const tailBudget = Math.max(0, limit - used);
    const tail = preserveLatest && tailBudget > 120 ? text.slice(-tailBudget) : "";
    const result = [selected.join("\n\n"), tail].filter(Boolean).join(marker);
    if (result) return { text: result.slice(0, limit), truncated: true, matched: true };
  }
  const marker = "\n\n……（中段已压缩，保留开头与最新结尾）……\n\n";
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining * 0.55);
  return { text: `${text.slice(0, head)}${marker}${text.slice(-(remaining - head))}`, truncated: true };
};

export const contextSourceSignature = (value = "") => {
  let hash = 2166136261;
  const source = String(value ?? "");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

// A full-read capsule is different from an ordinary excerpt: the service walks
// every source chunk and records its range/signature before selecting the
// prompt-sized representation. This keeps an overlong required source usable
// without pretending that every character can fit in one model turn.
export const compactFullyReadContextContent = (value, limit = 12_000, { query = "", label = "必读来源" } = {}) => {
  const source = String(value ?? "").trim();
  const safeLimit = Math.max(1_200, Number(limit) || 12_000);
  if (!source) return { text: "", fullText: false, compressed: false, sourceCharacters: 0, chunksRead: 0, sourceSignature: contextSourceSignature("") };
  const chunkSize = 16_000;
  const chunks = [];
  for (let start = 0; start < source.length; start += chunkSize) {
    const chunk = source.slice(start, start + chunkSize);
    chunks.push({
      index: chunks.length + 1,
      start,
      end: start + chunk.length,
      signature: contextSourceSignature(chunk),
      head: chunk.slice(0, 80).replace(/\s+/gu, " ").trim(),
      tail: chunk.slice(-80).replace(/\s+/gu, " ").trim(),
    });
  }
  if (source.length <= safeLimit) return {
    text: source,
    fullText: true,
    compressed: false,
    sourceCharacters: source.length,
    chunksRead: chunks.length,
    sourceSignature: contextSourceSignature(source),
    chunkReceipts: chunks,
  };

  const receiptLines = chunks.map((chunk) => (
    `- ${chunk.index}/${chunks.length} 字符 ${chunk.start}-${chunk.end} ${chunk.signature}｜${chunk.head}${chunk.tail && chunk.tail !== chunk.head ? ` … ${chunk.tail}` : ""}`
  ));
  const receiptBudget = Math.min(Math.floor(safeLimit * 0.38), 6_000);
  const receipts = receiptLines.join("\n").slice(0, receiptBudget);
  const contentBudget = Math.max(800, safeLimit - receipts.length - 240);
  const selected = excerptContextContent(source, contentBudget, { query, preserveLatest: true });
  const text = [
    `【全文读取压缩回执｜${label}】`,
    `源字符数：${source.length}；源签名：${contextSourceSignature(source)}；已读取分块：${chunks.length}/${chunks.length}。`,
    receipts,
    "【供本轮执行的压缩内容】",
    selected.text,
  ].filter(Boolean).join("\n").slice(0, safeLimit);
  return {
    text,
    fullText: true,
    compressed: true,
    sourceCharacters: source.length,
    chunksRead: chunks.length,
    sourceSignature: contextSourceSignature(source),
    chunkReceipts: chunks,
  };
};

export const compileContextSections = ({
  ids = [],
  requiredIds = [],
  fullDocumentIds = [],
  titleFor = () => "未命名",
  contentFor = () => "",
  maxCharacters = 60_000,
  perDocumentLimit = 6000,
  query = "",
  reasonFor = () => "相关资料",
  reasonsFor = null,
  authorityFor = () => "reference",
  preserveLatestFor = () => false,
  sourceMarkerFor = () => "",
  focused = false,
} = {}) => {
  const required = new Set(requiredIds.filter(Boolean));
  const fullTextRequired = new Set(fullDocumentIds.filter(Boolean));
  const ordered = [...new Set([...requiredIds, ...ids])].filter(Boolean);
  const includedIds = [];
  const omittedIds = [];
  const truncatedIds = [];
  const sections = [];
  const manifest = [];
  let used = 0;
  const requiredWithContent = ordered.filter((id) => required.has(id) && String(contentFor(id) ?? "").trim());
  for (const id of ordered) {
    const authority = normalizeContextAuthority(authorityFor(id));
    const raw = String(contentFor(id) ?? "").trim();
    if (!raw) {
      if (required.has(id)) omittedIds.push(id);
      manifest.push({ id, sourceId: `document:${id}:current`, required: required.has(id), included: false, truncated: false, reason: "文档为空或不存在", reasons: ["文档为空或不存在"], authority, characters: 0 });
      continue;
    }
    const minimum = required.has(id) ? 400 : 0;
    const remainingRequired = requiredWithContent.filter((requiredId) => !includedIds.includes(requiredId));
    const available = required.has(id)
      ? Math.floor((maxCharacters - used) / Math.max(1, remainingRequired.length)) - String(titleFor(id)).length - 10
      : maxCharacters - used - String(titleFor(id)).length - 8;
    if (available < minimum || available <= 120) {
      omittedIds.push(id);
      manifest.push({ id, sourceId: `document:${id}:current`, required: required.has(id), included: false, truncated: false, fullText: false, reason: "上下文预算不足", reasons: ["上下文预算不足"], authority, characters: 0 });
      continue;
    }
    const excerpt = fullTextRequired.has(id)
      ? compactFullyReadContextContent(raw, Math.max(1_200, available), { query, label: String(titleFor(id) || id) })
      : excerptContextContent(raw, Math.min(perDocumentLimit, available), { query, preserveLatest: preserveLatestFor(id), focused });
    if (focused && !excerpt.text) {
      manifest.push({ id, sourceId: `document:${id}:current`, required: required.has(id), included: false, truncated: false, reason: "未命中本轮单实体", reasons: ["未命中本轮单实体"], authority, characters: 0 });
      continue;
    }
    const sourceMetadata = JSON.stringify({ id, authority, required: required.has(id) });
    const executionMarker = String(sourceMarkerFor(id, excerpt.text, {
      fullText: fullTextRequired.has(id),
      sourceContent: raw,
      compressed: excerpt.compressed === true,
      sourceSignature: excerpt.sourceSignature,
    }) || "").trim();
    const section = `## ${titleFor(id)}\n<!-- shensi-context-source ${sourceMetadata} -->\n${executionMarker ? `${executionMarker}\n` : ""}${excerpt.text}`;
    sections.push(section);
    used += section.length + 2;
    includedIds.push(id);
    if (excerpt.truncated) truncatedIds.push(id);
    const reasons = [...new Set((typeof reasonsFor === "function" ? reasonsFor(id) : [reasonFor(id)]).filter(Boolean))];
    manifest.push({
      id,
      sourceId: `document:${id}:current`,
      required: required.has(id),
      included: true,
      truncated: excerpt.truncated,
      fullText: fullTextRequired.has(id) && excerpt.fullText === true,
      compressed: excerpt.compressed === true,
      sourceCharacters: excerpt.sourceCharacters ?? raw.length,
      sourceSignature: excerpt.sourceSignature ?? contextSourceSignature(raw),
      chunksRead: excerpt.chunksRead ?? 1,
      reason: reasons.join(" + ") || "相关资料",
      reasons,
      authority,
      characters: excerpt.text.length,
    });
  }
  return {
    text: sections.join("\n\n"),
    includedIds,
    omittedIds,
    missingRequiredIds: [...required].filter((id) => !includedIds.includes(id)),
    truncatedIds,
    manifest,
  };
};

export const STANDALONE_CREATIVE_CONTEXT_MODE = "standalone_creative_asset";

export const contextGateMarker = ({ status = "ready", missingRequiredIds = [], contextMode = "" } = {}) => (
  `<!-- shensi-context-gate ${JSON.stringify({
    status,
    missingRequiredIds: [...new Set(missingRequiredIds.filter(Boolean))],
    ...(contextMode === STANDALONE_CREATIVE_CONTEXT_MODE ? { contextMode } : {}),
  })} -->`
);

export const parseContextGate = (context = "") => {
  const match = String(context).match(/<!--\s*shensi-context-gate\s+({[^\n]*})\s*-->/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return {
      status: value.status === "blocked" ? "blocked" : "ready",
      missingRequiredIds: Array.isArray(value.missingRequiredIds) ? value.missingRequiredIds.map(String).filter(Boolean) : [],
      ...(value.contextMode === STANDALONE_CREATIVE_CONTEXT_MODE ? { contextMode: value.contextMode } : {}),
    };
  } catch {
    return { status: "blocked", missingRequiredIds: [], malformed: true };
  }
};
