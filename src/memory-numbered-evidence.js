import { verifyMemoryUpdateEvidence } from "./memory-evidence.js";

const clean = (value = "", max = 2_000) => String(value ?? "").trim().slice(0, max);
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const hashText = (value = "") => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const trimRange = (source, start, end) => {
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(source[from])) from += 1;
  while (to > from && /\s/u.test(source[to - 1])) to -= 1;
  return { start: from, end: to, text: source.slice(from, to) };
};

const sentenceRanges = (source, start, end) => {
  const paragraph = source.slice(start, end);
  const matches = [...paragraph.matchAll(/[^。！？!?；;\n]+(?:[。！？!?；;]+[”’」』"']*|(?=\n|$))/gu)];
  const ranges = matches.map((match) => trimRange(
    source,
    start + Number(match.index || 0),
    start + Number(match.index || 0) + String(match[0]).length,
  )).filter((item) => item.text);
  return ranges.length ? ranges : [trimRange(source, start, end)].filter((item) => item.text);
};

export const buildMemorySourceIndex = (value = "") => {
  const source = String(value ?? "").replace(/\r\n?/gu, "\n");
  const paragraphRanges = [];
  const boundary = /\n[ \t]*\n/gu;
  let start = 0;
  for (const match of source.matchAll(boundary)) {
    paragraphRanges.push(trimRange(source, start, Number(match.index || 0)));
    start = Number(match.index || 0) + String(match[0]).length;
  }
  paragraphRanges.push(trimRange(source, start, source.length));
  const paragraphs = paragraphRanges.filter((item) => item.text).map((paragraph, paragraphIndex) => {
    const paragraphRef = `P${String(paragraphIndex + 1).padStart(3, "0")}`;
    const sentences = sentenceRanges(source, paragraph.start, paragraph.end).map((sentence, sentenceIndex) => ({
      ...sentence,
      ref: `${paragraphRef}.S${String(sentenceIndex + 1).padStart(3, "0")}`,
      paragraph: paragraphIndex + 1,
      sentence: sentenceIndex + 1,
      hash: hashText(sentence.text),
    }));
    return {
      ...paragraph,
      ref: paragraphRef,
      paragraph: paragraphIndex + 1,
      hash: hashText(paragraph.text),
      sentences,
    };
  });
  const entries = Object.fromEntries(paragraphs.flatMap((paragraph) => [
    [paragraph.ref, paragraph],
    ...paragraph.sentences.map((sentence) => [sentence.ref, sentence]),
  ]));
  return {
    source,
    sourceHash: hashText(source),
    paragraphs,
    entries,
    numberedText: paragraphs.map((paragraph) => [
      `[${paragraph.ref}]`,
      ...paragraph.sentences.map((sentence) => `[${sentence.ref}] ${sentence.text}`),
    ].join("\n")).join("\n\n"),
  };
};

const parseJsonObject = (value = "") => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = String(value ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const TYPE_ALIASES = Object.freeze({
  chapter_summary: "chapter_summary",
  summary: "chapter_summary",
  state_change: "state_change",
  state: "state_change",
  foreshadowing: "foreshadowing",
  foreshadow: "foreshadowing",
  first_appearance: "first_appearance",
  information_release: "information_release",
  reader_knowledge: "reader_knowledge",
  next_context: "next_context",
  pending_canon: "pending_canon",
});

export const parseMemoryExtractionOutput = (value = "") => {
  const parsed = parseJsonObject(value);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  return {
    items: parsed.items.slice(0, 64).map((item, index) => ({
      repairKey: clean(item?.repairKey || `item-${index + 1}`, 120),
      type: TYPE_ALIASES[clean(item?.type, 80).toLowerCase()] || clean(item?.type, 80).toLowerCase(),
      name: clean(item?.name, 180),
      content: clean(item?.content || item?.memory || item?.detail || item?.summary, 1_200),
      state: clean(item?.state, 160),
      chapter: clean(item?.chapter, 180),
      allowedWriting: clean(item?.allowedWriting, 600),
      operation: clean(item?.operation || "upsert", 40) === "delete" ? "delete" : "upsert",
      sourceRefs: unique((Array.isArray(item?.sourceRefs) ? item.sourceRefs : [item?.sourceRef])
        .map((ref) => clean(ref, 40))
        .filter(Boolean)),
    })),
  };
};

const stableRecordId = (type, name) => {
  const family = ["first_appearance", "information_release", "reader_knowledge"].includes(type)
    ? "information"
    : type === "foreshadowing" ? "foreshadow" : "state";
  return `${family}-${hashText(`${family}\u0000${clean(name, 300).toLowerCase()}`)}`;
};

const sourceEvidenceFor = ({ item, sourceIndex, documentId, sourceRevision }) => {
  const entries = item.sourceRefs.map((ref) => sourceIndex.entries[ref]).filter(Boolean);
  if (!entries.length || entries.length !== item.sourceRefs.length) {
    return { ok: false, reason: "来源编号不存在或已失效" };
  }
  const ordered = [...entries].sort((left, right) => left.start - right.start);
  const start = ordered[0].start;
  const end = ordered.at(-1).end;
  const quote = sourceIndex.source.slice(start, end).trim();
  if (!quote) return { ok: false, reason: "来源编号没有可提取原文" };
  if (quote.length > 1_200) return { ok: false, reason: "来源范围超过 1200 字，请缩小到能证明该记忆的句子" };
  const sourceRefs = ordered.map((entry) => entry.ref);
  return {
    ok: true,
    evidence: {
      id: `evidence-${hashText(`${documentId}\u0000${sourceRevision}\u0000${sourceRefs.join(",")}\u0000${quote}`)}`,
      claim: item.content,
      quote,
      sourceRefs,
      sourceHash: hashText(quote),
      sourceStart: start,
      sourceEnd: end,
      paragraph: ordered[0].paragraph,
      sentence: ordered[0].sentence || 0,
    },
  };
};

const memoryUpdateForItem = ({ item, evidence }) => {
  const update = {
    chapterSummary: "",
    stateChanges: [],
    foreshadowing: [],
    firstAppearances: [],
    informationRelease: [],
    readerKnowledge: [],
    nextContext: [],
    pendingCanon: [],
    evidence: [evidence],
  };
  if (item.type === "chapter_summary") update.chapterSummary = item.content;
  else if (item.type === "next_context") update.nextContext = [item.content];
  else if (item.type === "pending_canon") update.pendingCanon = [item.content];
  else {
    if (!item.name) return { ok: false, reason: "结构化记忆缺少实体或信息名称" };
    const record = {
      id: stableRecordId(item.type, item.name),
      name: item.name,
      detail: item.content,
      state: item.state,
      chapter: item.chapter,
      allowedWriting: item.allowedWriting,
      operation: item.operation,
    };
    if (item.type === "state_change") update.stateChanges.push(record);
    else if (item.type === "foreshadowing") update.foreshadowing.push(record);
    else if (item.type === "first_appearance") update.firstAppearances.push(record);
    else if (item.type === "information_release") update.informationRelease.push(record);
    else if (item.type === "reader_knowledge") update.readerKnowledge.push(record);
    else return { ok: false, reason: `不支持的记忆类型：${item.type || "空"}` };
  }
  return { ok: true, update };
};

export const mergeCompiledMemoryUpdates = (updates = []) => {
  const result = {
    chapterSummary: "",
    stateChanges: [],
    foreshadowing: [],
    firstAppearances: [],
    informationRelease: [],
    readerKnowledge: [],
    nextContext: [],
    pendingCanon: [],
    evidence: [],
  };
  for (const update of updates.filter(Boolean)) {
    if (!result.chapterSummary && update.chapterSummary) result.chapterSummary = update.chapterSummary;
    for (const field of ["stateChanges", "foreshadowing", "firstAppearances", "informationRelease", "readerKnowledge", "nextContext", "pendingCanon", "evidence"]) {
      result[field].push(...(Array.isArray(update[field]) ? update[field] : []));
    }
  }
  result.nextContext = unique(result.nextContext).slice(0, 8);
  result.pendingCanon = unique(result.pendingCanon).slice(0, 8);
  result.evidence = [...new Map(result.evidence.map((item) => [item.id || `${item.claim}\u0000${item.quote}`, item])).values()];
  return result;
};

export const compileMemoryExtraction = ({
  items = [],
  sourceIndex,
  documentId = "",
  sourceRevision = "",
} = {}) => {
  const updates = [];
  const accepted = [];
  const failures = [];
  for (const item of items) {
    if (!item?.content) {
      failures.push({ item, reason: "记忆内容为空", stage: "normalize" });
      continue;
    }
    const source = sourceEvidenceFor({ item, sourceIndex, documentId, sourceRevision });
    if (!source.ok) {
      failures.push({ item, reason: source.reason, stage: "source_resolution" });
      continue;
    }
    const compiled = memoryUpdateForItem({ item, evidence: source.evidence });
    if (!compiled.ok) {
      failures.push({ item, reason: compiled.reason, stage: "compile" });
      continue;
    }
    const verification = verifyMemoryUpdateEvidence({ memoryUpdate: compiled.update, candidate: sourceIndex.source });
    if (!verification.ok) {
      failures.push({ item, reason: verification.reason, stage: "evidence_validation", evidence: source.evidence });
      continue;
    }
    accepted.push({ item, evidence: source.evidence });
    updates.push(compiled.update);
  }
  const memoryUpdate = mergeCompiledMemoryUpdates(updates);
  const hasUpdate = Boolean(memoryUpdate.chapterSummary
    || ["stateChanges", "foreshadowing", "firstAppearances", "informationRelease", "readerKnowledge", "nextContext", "pendingCanon"]
      .some((field) => memoryUpdate[field].length));
  return { accepted, failures, memoryUpdate: hasUpdate ? memoryUpdate : null };
};

export const memoryExtractionPrompt = ({ sourceIndex, pendingCandidates = [] } = {}) => [
  "只执行记忆提取，不执行正文自检、质量评价、修改或写入。",
  "正文已经由程序编号。你只返回需要长期记忆的内容、类型和来源编号；不要抄写原文引文，不要生成 ID。",
  "没有需要记忆的变化时返回 {\"items\":[]}。不得为了填满字段而制造记忆。",
  "允许的 type：chapter_summary、state_change、foreshadowing、first_appearance、information_release、reader_knowledge、next_context、pending_canon。",
  "每项格式：{\"repairKey\":\"item-1\",\"type\":\"state_change\",\"name\":\"实体或信息名称\",\"content\":\"需要记忆的事实\",\"state\":\"可选状态\",\"chapter\":\"可选来源单元\",\"allowedWriting\":\"可选后续边界\",\"operation\":\"upsert\",\"sourceRefs\":[\"P001.S001\"]}。",
  "content 必须是来源编号能够完整证明的单一事实。人物状态、设定、伏笔或信息释放没有实际变化时不要返回。",
  pendingCandidates.length ? `以下是此前未通过校验的章节暂存项。请结合当前正文重新解析；只有当前来源仍能证明时才重新返回：\n${JSON.stringify(pendingCandidates.slice(-24), null, 2)}` : "",
  "# 编号正文",
  sourceIndex.numberedText,
].filter(Boolean).join("\n\n");

export const memoryExtractionRepairPrompt = ({ sourceIndex, failures = [], round = 1 } = {}) => [
  `只修复下列 ${failures.length} 个记忆项，这是第 ${round} 次局部修复。已通过的记忆项不得重新输出。`,
  "保留每项 repairKey；根据失败原因修正 type、content 或 sourceRefs。不要生成引文和 ID。无法修复的项目可以省略。",
  JSON.stringify(failures.map(({ item, reason, stage }) => ({ item, reason, stage })), null, 2),
  "# 编号正文",
  sourceIndex.numberedText,
].join("\n\n");

export const deferredMemoryCandidates = ({
  failures = [],
  sourceIndex,
  documentId = "",
  sourceRevision = "",
  repairAttempts = 0,
  failureStage = "evidence_validation",
  createdAt = new Date().toISOString(),
} = {}) => failures.map((failure, index) => {
  const item = failure.item ?? {};
  const fallbackEntry = sourceIndex.paragraphs.at(-1) || sourceIndex.paragraphs[0] || null;
  const sourceRefs = item.sourceRefs?.length ? [...item.sourceRefs] : fallbackEntry ? [fallbackEntry.ref] : [];
  const stagedItem = {
    ...item,
    type: item.type === "unknown" && failure.stage === "protocol" ? "chapter_source_pending" : item.type,
    content: item.content || (failure.stage === "protocol" ? fallbackEntry?.text || "" : ""),
    sourceRefs,
  };
  const resolved = sourceEvidenceFor({ item: stagedItem, sourceIndex, documentId, sourceRevision });
  const fallbackSourceRefs = fallbackEntry ? [fallbackEntry.ref] : [];
  const fallbackResolved = resolved.ok || !fallbackEntry ? resolved : sourceEvidenceFor({
    item: { ...stagedItem, content: fallbackEntry.text, sourceRefs: fallbackSourceRefs },
    sourceIndex,
    documentId,
    sourceRevision,
  });
  const retainedSourceRefs = resolved.ok ? sourceRefs : fallbackSourceRefs;
  return {
    id: `pending-memory-${hashText(`${documentId}\u0000${sourceRevision}\u0000${stagedItem.repairKey || index}\u0000${stagedItem.type || "unknown"}\u0000${stagedItem.content || failure.reason}`)}`,
    documentId,
    sourceRevision,
    sourceHash: sourceIndex.sourceHash,
    repairKey: clean(stagedItem.repairKey || `deferred-${index + 1}`, 120),
    type: clean(stagedItem.type || "unknown", 80),
    name: clean(stagedItem.name, 180),
    content: clean(stagedItem.content, 1_200),
    sourceRefs: retainedSourceRefs,
    requestedSourceRefs: sourceRefs,
    evidence: fallbackResolved.ok ? fallbackResolved.evidence : null,
    status: "deferred",
    failureStage: failure.stage || failureStage,
    reason: clean(failure.reason || "记忆项校验失败", 600),
    repairAttempts,
    createdAt,
  };
});
