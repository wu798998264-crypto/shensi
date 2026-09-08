import { createHash } from "node:crypto";
import { hasAssertedMemoryFactOccurrence, retainVerifiedMemoryUpdateFacts } from "./memory-evidence.js";
import { memoryHealth } from "./memory-health.js";
import { memoryPlaceholderReason, memoryReviewMatchesCurrentSource, memorySourceRevision, memorySourceText } from "./memory-source.js";
import { stripInternalNarrativeScaffolding } from "./context-content-policy.js";

const MAX_SENTENCE_CHARACTERS = 112;
const MAX_REPRESENTATIVE_SENTENCES = 7;
const MAX_CATEGORY_ITEMS = 5;

const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const sectionAwareBackfillText = (documentState = {}) => {
  const source = String(documentState.markdown ?? documentState.html ?? "");
  if (!documentState.html || documentState.markdown) return source;
  return source
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, heading) => `\n${"#".repeat(Number(level))} ${String(heading).replace(/<[^>]+>/g, " ")}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");
};

// Backfill operates only on formal narrative evidence. Legacy files may still
// contain provenance, writing cards and editorial ending notes around the
// actual body; those management layers must never become continuity facts.
export const memoryBackfillSourceText = (documentState = {}) => memorySourceText({
  markdown: stripInternalNarrativeScaffolding(sectionAwareBackfillText(documentState)),
});

export const memoryBackfillSourceHash = (documentState = {}) => sha256(memoryBackfillSourceText(documentState));

const sentenceUnits = (value) => {
  const matches = String(value).match(/[^。！？!?；;\n]+(?:[。！？!?；;]+[”’」』"']*|(?=\n|$))/gu) ?? [];
  return matches
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 8)
    .map((item) => item.slice(0, MAX_SENTENCE_CHARACTERS).trim())
    .filter(Boolean);
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const representativeSentences = (sentences) => {
  if (!sentences.length) return [];
  const fractions = sentences.length >= 7
    ? [0, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6, 1]
    : sentences.length >= 5
      ? [0, 1 / 4, 1 / 2, 3 / 4, 1]
      : sentences.map((_, index) => index / Math.max(1, sentences.length - 1));
  return unique(fractions.map((fraction) => sentences[Math.round((sentences.length - 1) * fraction)]))
    .slice(0, MAX_REPRESENTATIVE_SENTENCES);
};

const stableEntryId = (category, sentence) => `${category}-${sha256(`${category}\u0000${sentence}`).slice(0, 16)}`;

const hasAssertedPatternOccurrence = (sentence, pattern, options = {}) => (
  hasAssertedMemoryFactOccurrence({ text: sentence, pattern, ...options })
);

const SUMMARY_ACTION_PATTERN = /发现|确认|得知|意识到|决定|抵达|到达|来到|进入|离开|返回|回到|拿到|得到|获得|取回|归还|恢复|修复|重新开始|失去|揭开|揭晓|救下|杀死|死亡|复活|背叛|相认|身份|真相|规则|线索|秘密|承诺|计划|必须/;
const summarySentenceScore = (sentence, index, total) => {
  const length = [...String(sentence)].length;
  const centered = total <= 1 ? 0 : 6 - Math.abs(index / (total - 1) - 0.5) * 8;
  const hasAction = SUMMARY_ACTION_PATTERN.test(sentence);
  return centered
    + (length >= 20 && length <= 88 ? 12 : length >= 14 ? 4 : -10)
    + (hasAction ? 14 : 0)
    - (hasAction && !hasAssertedPatternOccurrence(sentence, SUMMARY_ACTION_PATTERN) ? 36 : 0)
    + (/\[\[[^\]]+\]\]/.test(sentence) ? 6 : 0)
    - (/[？?]/.test(sentence) ? 18 : 0)
    - (/^(?:他|她|它|这|那|可|但|却|然后|随后|于是|没|没有|是的|不是)[，,。！？!?]?/.test(sentence) ? 7 : 0);
};

const representativeSummarySentence = (sentences) => sentences
  .map((sentence, index) => ({ sentence, index, score: summarySentenceScore(sentence, index, sentences.length) }))
  .sort((left, right) => right.score - left.score || Math.abs(left.index - ((sentences.length - 1) / 2)) - Math.abs(right.index - ((sentences.length - 1) / 2)))[0]?.sentence ?? "";

const categoryEntries = (category, sentences, pattern, { assertedOnly = false } = {}) => representativeSentences(unique(sentences.filter((sentence) => (
  pattern.test(sentence) && (!assertedOnly || hasAssertedPatternOccurrence(sentence, pattern))
))))
  .slice(0, MAX_CATEGORY_ITEMS)
  .map((sentence) => ({ id: stableEntryId(category, sentence), name: sentence }));

const STATE_PATTERN = /死亡|死去|身亡|活着|生还|苏醒|复活|受伤|负伤|流血|中毒|昏迷|失踪|缺勤|抵达|到达|来到|进入|离开|返回|身处|位于|住在|藏在|拿到|得到|获得|持有|拥有|丢失|遗失|归还|结婚|离婚|分手|相爱|背叛|决裂|和好|身份|真名|亲生|停在|移动|启动|运行|定位/;
const FORESHADOW_PATTERN = /伏笔|线索|谜团|秘密|悬念|承诺|约定|预言|失踪|血迹|血|停在\s*0?0[:：]17|定位.{0,24}(?:隧道|封闭区)|操作人.{0,12}(?:空白|空着)|(?:仍未|尚未)(?:解释|说明|解除|揭开|查明|找到|出现|兑现|回答)|没有解释|未解除|未揭开|下落不明|去向不明/;
const FIRST_APPEARANCE_PATTERN = /第一次|首次|初次|初见|登场|现身|首次出现|第一次出现/;
const INFORMATION_RELEASE_PATTERN = /发现|得知|知道|确认|揭晓|揭开|透露|承认|证明|识破|意识到|真相|显示|记录|检测|响应|错误码|空白|空着|停在|定位|血迹|失踪|缺勤|编号|耗电|启动|运行|移动/;
const READER_KNOWLEDGE_PATTERN = /读者|观众|众人都知道|所有人都知道|只有.+知道|并不知道|不知情/;
const PENDING_CANON_PATTERN = /原来|其实|身份|真名|亲生|规则是|真相是|证明了|确认了/;
const NEXT_CONTEXT_PATTERN = /仍未|尚未|没有解释|未解除|未揭开|下落不明|去向不明|失踪|定位|报警|救援|进入|走向|决定|准备|计划|即将|将要|继续|必须|等待|承诺|约定/;

const exactSentenceValues = (sentences, pattern, excluded = new Set()) => unique(sentences
  .filter((sentence) => pattern.test(sentence) && !excluded.has(sentence)))
  .slice(-MAX_CATEGORY_ITEMS);

const assertedSentenceValues = (sentences, pattern, options = {}) => representativeSentences(unique(sentences
  .filter((sentence) => pattern.test(sentence) && hasAssertedPatternOccurrence(sentence, pattern, options))))
  .slice(0, MAX_CATEGORY_ITEMS);

const buildMemoryUpdate = (sentences) => {
  const representatives = representativeSentences(sentences);
  // Prefer an informative, central verbatim sentence over boilerplate or an
  // isolated dialogue question. It remains an auditable quote, not an inferred
  // semantic summary.
  const chapterSummary = representativeSummarySentence(sentences) || sentences[0] || "";
  const excluded = new Set([chapterSummary]);
  const explicitCarryover = exactSentenceValues(sentences, NEXT_CONTEXT_PATTERN, excluded);
  const fallbackCarryover = unique([
    representatives.at(-1),
    representatives.at(-2),
  ].filter((sentence) => sentence && sentence !== chapterSummary));
  // Always reserve carryover capacity for the closing lines. A chapter can
  // contain many earlier “计划/决定/等待” sentences; allowing those to fill
  // the list drops the actual chapter hook and silently weakens long-form
  // continuation memory.
  const nextContext = unique([...fallbackCarryover, ...explicitCarryover]).slice(0, MAX_CATEGORY_ITEMS);
  const stateChanges = categoryEntries("state", sentences, STATE_PATTERN, { assertedOnly: true });
  const foreshadowing = categoryEntries("foreshadow", sentences, FORESHADOW_PATTERN);
  const firstAppearances = categoryEntries("appearance", sentences, FIRST_APPEARANCE_PATTERN, { assertedOnly: true });
  const informationRelease = categoryEntries("release", sentences, INFORMATION_RELEASE_PATTERN, { assertedOnly: true });
  const readerKnowledge = categoryEntries("reader", sentences, READER_KNOWLEDGE_PATTERN);
  const pendingCanon = assertedSentenceValues(sentences, PENDING_CANON_PATTERN, { allowFormer: true });
  const assertions = unique([
    chapterSummary,
    ...nextContext,
    ...stateChanges.map(({ name }) => name),
    ...foreshadowing.map(({ name }) => name),
    ...firstAppearances.map(({ name }) => name),
    ...informationRelease.map(({ name }) => name),
    ...readerKnowledge.map(({ name }) => name),
    ...pendingCanon,
  ]);
  // Representative evidence is retained even when a sampled sentence did not
  // match a conservative category. This exposes middle-of-chapter coverage to a
  // reviewer without inventing a synthesized fact.
  const evidence = unique([...assertions, ...representatives]).map((claim) => ({ claim, quote: claim }));
  return {
    chapterSummary,
    nextContext,
    stateChanges,
    foreshadowing,
    firstAppearances,
    informationRelease,
    readerKnowledge,
    pendingCanon,
    evidence,
  };
};

export const memoryBackfillCandidateId = ({ documentId = "", sourceHash = "", memoryUpdate = {} } = {}) => (
  `memory-backfill-${sha256(`${documentId}\u0000${sourceHash}\u0000${canonicalJson(memoryUpdate)}`).slice(0, 24)}`
);

export const createMemoryBackfillCandidate = ({ documentId, documentState = {} } = {}) => {
  const text = memoryBackfillSourceText(documentState);
  const placeholderReason = memoryPlaceholderReason(documentState);
  if (placeholderReason) return { documentId, title: documentState.title ?? documentId, status: "unwritten", reason: placeholderReason };
  if (documentState.memoryBackfillPolicy?.excluded === true) {
    return { documentId, title: documentState.title ?? documentId, status: "excluded", reason: documentState.memoryBackfillPolicy.reason || "作者已排除记忆扫描" };
  }
  if (memoryReviewMatchesCurrentSource(documentState)) {
    return { documentId, title: documentState.title ?? documentId, status: "ignored", reason: documentState.memoryBackfillReview.reason || "作者已忽略当前版本" };
  }
  const sentences = sentenceUnits(text);
  if (!text || !sentences.length) return { documentId, status: "blocked", reason: "正文没有可提取内容" };
  const sourceHash = sha256(text);
  const draftMemoryUpdate = buildMemoryUpdate(sentences);
  const retained = retainVerifiedMemoryUpdateFacts({ memoryUpdate: draftMemoryUpdate, candidate: text });
  if (!retained.ok) return { documentId, status: "blocked", reason: retained.reason || "正文没有可安全采用的确定性证据" };
  const memoryUpdate = retained.memoryUpdate;
  return {
    schemaVersion: 2,
    candidateId: memoryBackfillCandidateId({ documentId, sourceHash, memoryUpdate }),
    documentId,
    title: documentState.title ?? documentId,
    status: "proposal",
    sourceHash,
    sourceRevision: memorySourceRevision(documentState),
    sourceCharacters: text.length,
    sampledSentenceCount: Math.min(MAX_REPRESENTATIVE_SENTENCES, representativeSentences(sentences).length),
    generatedBy: "deterministic-evidence-backfill-v2",
    confidence: "needs_review",
    evidenceCoverage: retained.coverage,
    memoryUpdate,
  };
};

export const prepareEditedMemoryBackfillCandidate = ({ documentId, documentState = {}, chapterSummary = "" } = {}) => {
  const candidate = createMemoryBackfillCandidate({ documentId, documentState });
  if (candidate.status !== "proposal") return candidate;
  const summary = String(chapterSummary || "").replace(/\s+/g, " ").trim().slice(0, MAX_SENTENCE_CHARACTERS);
  const evidenceQuotes = new Set((candidate.memoryUpdate.evidence ?? []).map((item) => String(item.quote || "").replace(/\s+/g, " ").trim()));
  if (!summary || !evidenceQuotes.has(summary)) {
    return { documentId, title: candidate.title, status: "blocked", reason: "编辑后的摘要必须完整使用一条已展示的正文原句" };
  }
  const memoryUpdate = { ...candidate.memoryUpdate, chapterSummary: summary };
  const retained = retainVerifiedMemoryUpdateFacts({ memoryUpdate, candidate: memoryBackfillSourceText(documentState) });
  if (!retained.ok) return { documentId, title: candidate.title, status: "blocked", reason: retained.reason || "编辑后的摘要没有通过证据验证" };
  return {
    ...candidate,
    candidateId: memoryBackfillCandidateId({ documentId, sourceHash: candidate.sourceHash, memoryUpdate: retained.memoryUpdate }),
    generatedBy: "author-edited-evidence-backfill-v1",
    memoryUpdate: retained.memoryUpdate,
  };
};

export const buildMemoryBackfillPlan = ({ moduleItems = {}, documents = {}, limit = 200 } = {}) => {
  const health = memoryHealth({ moduleItems, documents });
  const queue = health.backfillQueue.slice(0, Math.max(1, Math.min(1_000, Number(limit) || 200)));
  const candidates = queue.map(({ documentId, reason, priority }) => reason === "conflict"
    ? ({
      documentId,
      title: documents[documentId]?.title || documentId,
      status: "blocked",
      reason: "当前正文与资料、大纲、设定或记忆存在已核实冲突，请先在索引的待确认事项中确定最终口径",
      priority,
    })
    : ({
      reason,
      priority,
      ...createMemoryBackfillCandidate({ documentId, documentState: documents[documentId] }),
    }));
  const queuedIds = new Set(queue.map(({ documentId }) => documentId));
  for (const row of health.rows.filter((item) => !queuedIds.has(item.id) && (item.placeholderReason || item.ignored || item.excluded))) {
    candidates.push({
      documentId: row.id,
      title: row.title,
      status: row.excluded ? "excluded" : row.ignored ? "ignored" : "unwritten",
      reason: row.excluded
        ? documents[row.id]?.memoryBackfillPolicy?.reason || "作者已排除记忆扫描"
        : row.ignored
          ? documents[row.id]?.memoryBackfillReview?.reason || "作者已忽略当前版本"
          : row.placeholderReason,
    });
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: "proposal_only",
    health,
    requested: candidates.length,
    proposed: candidates.filter((candidate) => candidate.status === "proposal").length,
    blocked: candidates.filter((candidate) => candidate.status === "blocked").length,
    ignored: candidates.filter((candidate) => candidate.status === "ignored").length,
    excluded: candidates.filter((candidate) => candidate.status === "excluded").length,
    candidates,
  };
};
