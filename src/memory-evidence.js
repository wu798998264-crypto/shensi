import { normalizeLedgerEntries } from "./information-ledger.js";
import { normalizeStateEntries } from "./memory-compiler.js";

const IGNORED_NORMALIZED_CHARACTER = /[\s\p{P}\p{S}]/u;

const normalizedWithMap = (value = "") => {
  const raw = String(value).toLowerCase();
  const characters = [];
  const rawIndexes = [];
  for (let index = 0; index < raw.length;) {
    const character = String.fromCodePoint(raw.codePointAt(index));
    if (!IGNORED_NORMALIZED_CHARACTER.test(character)) {
      characters.push(character);
      rawIndexes.push(index);
    }
    index += character.length;
  }
  return { raw, text: characters.join(""), rawIndexes };
};

const normalized = (value = "") => normalizedWithMap(value).text;

const SEMANTIC_GROUPS = [
  ["death", /死亡|死了|死去|身亡|断气|咽气|毙命|尸体|没有呼吸|停止呼吸|失去生命/],
  ["alive", /活着|生还|苏醒|复活|复生|恢复呼吸|还有呼吸|尚在人世/],
  ["injury", /受伤|负伤|伤口|流血|骨折|中毒|昏迷/],
  ["location", /位于|身处|抵达|到达|来到|进入|离开|返回|赶到|住在|藏在/],
  ["possession", /持有|拥有|拿到|得到|获得|交给|递给|夺走|抢走|丢失|遗失|归还/],
  ["knowledge", /知道|得知|发现|看见|听见|意识到|确认|揭晓|识破|不知情/],
  ["relationship", /结婚|离婚|分手|相爱|爱上|背叛|决裂|和好|父亲|母亲|兄弟|姐妹|恋人|夫妻/],
  ["identity", /身份|真名|冒充|假扮|其实是|原来是|亲生|养女|养子/],
];

const semanticLabels = (value) => new Set(SEMANTIC_GROUPS.filter(([, pattern]) => pattern.test(String(value))).map(([label]) => label));

const DIRECT_NEGATION = /没有|没能|未能|未曾|并未|不曾|并不|不是|不能|无法|不可能|尚未|从未|绝非/;
const DENIAL_SCOPE = /否认|否定|反驳|驳斥|不承认|拒绝承认|并非(?:事实|如此)|不属实|系谣言|纯属(?:误会|捏造|虚构)|假消息|假象|虚假|捏造|杜撰|没有发生|从未发生/;
const REPORTED_SCOPE = /声称|宣称|转述|援引|引用|据称|据说|据报道|据消息|听说|传闻|相传|谣传|误传|报道(?:称|说|指出)|消息称|有人说|表示|告诉|提到|谈及|写道|写着|记载|记录|预言|预测|谎称|(?:^|[^小])说(?:道|过|着)?/;
const CONDITIONAL_SCOPE = /如果|假如|倘若|倘使|若是|要是|一旦|除非|只要|只有|前提是|条件是|假设|设想|万一|的话/;
const UNCERTAIN_SCOPE = /可能|也许|或许|似乎|仿佛|看起来|看似|貌似|疑似|恐怕|大概|未必|不一定|差点|险些|几乎|担心|怀疑|猜测|推测|以为|梦见|梦中|假装|企图|试图|想要|[？?]/;
const FUTURE_SCOPE = /即将|将会|将要|将于|预计|预定|有望|终将|迟早|未来|明天|后天|下周|下月|下个月|来日|届时|计划|打算|准备|(?:将|会|要)(?:在[^，,。！？!?；;]{0,12})?(?:死亡|死去|身亡|离开|返回|抵达|到达|进入|获得|拿到|知道|发现|结婚|离婚|分手|背叛|复活|受伤)/;
const FORMER_SCOPE = /曾经|一度|过去|此前|原先|原本|当时|那时|昔日|先前|早先|昨天|前天|上周|上个月|去年|当年|(?:\d+|[一二三四五六七八九十两几]+)年(?:之)?前/;
const PREFIX_SCOPE_OPERATOR = /(?:否认|否定|反驳|驳斥|不承认|拒绝承认|声称|宣称|转述|援引|引用|据称|据说|据报道|据消息|听说|表示|告诉|提到|谈及|写道|记载|记录|预言|预测|谎称|如果|假如|倘若|倘使|若是|要是|假设|设想)(?:了|过|道|称)?\s*$/;
const TRAILING_ATTRIBUTION = /^(?:\s|[”"'’」』）》】])*(?:[，,；;：:]\s*)?(?:(?:警方|官方|当事人|记者|作者|他|她|对方|众人)[^，,。！？!?；;]{0,10})?(?:对此|随后|随即|又)?\s*(?:予以|加以|明确|公开|当场)?\s*(?:否认|否定|反驳|驳斥|不承认|转述|引用|援引|声称|宣称|表示|说道|说)/;
const TRAILING_DENIAL = /^(?:\s|[”"'’」』）》】])*(?:[，,；;：:]\s*)?(?:(?:这一|该|上述|有关)?(?:说法|消息|传闻|报道|结论)?\s*)?(?:是|为|属于|纯属|被|遭|受到)?\s*(?:不实|虚假|谣言|假消息|假象|误会|捏造|虚构|否认|否定|反驳|驳斥)/;
const CLAUSE_BOUNDARY = /[，,；;：:。！？!?\n]/u;
const SENTENCE_BOUNDARY = /[。！？!?\n]/u;
const SCOPE_KEYS = ["negated", "denied", "reported", "conditional", "uncertain", "future", "former", "superseded"];

const previousBoundaryIndex = (raw, fromIndex, pattern) => {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    if (pattern.test(raw[index])) return index;
  }
  return -1;
};

const nextBoundaryIndex = (raw, fromIndex, pattern) => {
  for (let index = fromIndex; index < raw.length; index += 1) {
    if (pattern.test(raw[index])) return index;
  }
  return raw.length;
};

const isInsideQuotation = (raw, start, end) => {
  const pairedQuotes = [["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["《", "》"]];
  if (pairedQuotes.some(([open, close]) => {
    const openIndex = raw.lastIndexOf(open, start);
    const closeBefore = raw.lastIndexOf(close, start);
    const closeAfter = raw.indexOf(close, end);
    return openIndex > closeBefore && closeAfter >= end;
  })) return true;
  const doubleQuotesBefore = (raw.slice(0, start).match(/"/g) ?? []).length;
  return doubleQuotesBefore % 2 === 1 && raw.indexOf('"', end) >= end;
};

const occurrenceContext = (raw, start, end) => {
  const clauseStartBoundary = previousBoundaryIndex(raw, start, CLAUSE_BOUNDARY);
  const clauseEndBoundary = nextBoundaryIndex(raw, end, CLAUSE_BOUNDARY);
  const sentenceEndBoundary = nextBoundaryIndex(raw, end, SENTENCE_BOUNDARY);
  const localClause = raw.slice(clauseStartBoundary + 1, clauseEndBoundary);
  const previousClauseStart = previousBoundaryIndex(raw, Math.max(0, clauseStartBoundary), CLAUSE_BOUNDARY);
  const previousClause = clauseStartBoundary >= 0 ? raw.slice(previousClauseStart + 1, clauseStartBoundary).trim() : "";
  const delimiter = clauseStartBoundary >= 0 ? raw[clauseStartBoundary] : "";
  const previousCarriesScope = previousClause && (
    (["：", ":"].includes(delimiter) && [DENIAL_SCOPE, REPORTED_SCOPE, CONDITIONAL_SCOPE, UNCERTAIN_SCOPE, FUTURE_SCOPE].some((pattern) => pattern.test(previousClause)))
    || (["，", ",", "；", ";"].includes(delimiter) && PREFIX_SCOPE_OPERATOR.test(previousClause))
  );
  const trailingText = raw.slice(end, Math.min(sentenceEndBoundary, end + 72));
  const trailingAttribution = trailingText.match(TRAILING_ATTRIBUTION)?.[0]
    ?? trailingText.match(TRAILING_DENIAL)?.[0]
    ?? "";
  return {
    text: [previousCarriesScope ? previousClause : "", localClause, trailingAttribution].filter(Boolean).join(" "),
    localClause,
    sentenceSuffix: raw.slice(end, sentenceEndBoundary),
    questioned: ["？", "?"].includes(raw[clauseEndBoundary]),
    quoted: isInsideQuotation(raw, start, end),
  };
};

const hasSupersedingState = ({ claimSemantics, sentenceSuffix }) => (
  claimSemantics.has("death") && /(?:但|不过|然而|随后|后来|现在|最终|很快)[^。！？!?\n]{0,36}(?:复活|复生|生还|苏醒|恢复呼吸|还有呼吸|尚在人世)/.test(sentenceSuffix)
) || (
  claimSemantics.has("alive") && /(?:但|不过|然而|随后|后来|现在|最终|很快)[^。！？!?\n]{0,36}(?:死亡|死去|身亡|断气|咽气|毙命|停止呼吸|失去生命)/.test(sentenceSuffix)
);

const factScope = ({ raw, start = 0, end = raw.length, claimSemantics = semanticLabels(raw) }) => {
  const context = occurrenceContext(raw, start, end);
  const immediateSuffix = raw.slice(end, Math.min(raw.length, end + 12));
  return {
    negated: DIRECT_NEGATION.test(context.text),
    denied: DENIAL_SCOPE.test(context.text),
    reported: context.quoted || REPORTED_SCOPE.test(context.text),
    conditional: CONDITIONAL_SCOPE.test(context.text),
    uncertain: context.questioned || UNCERTAIN_SCOPE.test(context.text),
    future: FUTURE_SCOPE.test(context.text) || /^\s*(?:前|之前|以前|的预言|的预测)/.test(immediateSuffix),
    former: FORMER_SCOPE.test(context.text),
    superseded: hasSupersedingState({ claimSemantics, sentenceSuffix: context.sentenceSuffix }),
  };
};

export const hasAssertedMemoryFactOccurrence = ({ text = "", pattern, allowFormer = false } = {}) => {
  if (!(pattern instanceof RegExp)) return false;
  const raw = String(text).toLowerCase();
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return [...raw.matchAll(matcher)].some((match) => {
    const start = Number(match.index) || 0;
    const scope = factScope({
      raw,
      start,
      end: start + match[0].length,
      claimSemantics: semanticLabels(match[0]),
    });
    return !scope.negated
      && !scope.denied
      && !scope.reported
      && !scope.conditional
      && !scope.uncertain
      && !scope.future
      && (allowFormer || !scope.former)
      && !scope.superseded;
  });
};

const orderedFactSpans = (claimText, quoteMap) => {
  const spans = [];
  const maximumSpan = Math.max(claimText.length + 6, Math.ceil(claimText.length * 2.5));
  for (let start = 0; start < quoteMap.text.length; start += 1) {
    if (quoteMap.text[start] !== claimText[0]) continue;
    let quoteIndex = start;
    let lastMatch = -1;
    for (const character of claimText) {
      const matchIndex = quoteMap.text.indexOf(character, quoteIndex);
      if (matchIndex < 0) {
        lastMatch = -1;
        break;
      }
      lastMatch = matchIndex;
      quoteIndex = matchIndex + character.length;
    }
    if (lastMatch < 0 || lastMatch - start + 1 > maximumSpan) continue;
    const rawStart = quoteMap.rawIndexes[start];
    const lastRawIndex = quoteMap.rawIndexes[lastMatch];
    const lastCharacter = String.fromCodePoint(quoteMap.raw.codePointAt(lastRawIndex));
    spans.push({ start: rawStart, end: lastRawIndex + lastCharacter.length });
  }
  return spans;
};

const scopesMatch = (claimScope, quoteScope) => SCOPE_KEYS.every((key) => Boolean(claimScope[key]) === Boolean(quoteScope[key]));

export const evidenceSupportsClaim = ({ claim = "", quote = "" } = {}) => {
  const claimMap = normalizedWithMap(claim);
  const quoteMap = normalizedWithMap(quote);
  if (!claimMap.text || !quoteMap.text) return false;
  const claimSemantics = semanticLabels(claim);
  const quoteSemantics = semanticLabels(quote);
  if ([...claimSemantics].some((label) => !quoteSemantics.has(label))) return false;
  const claimScope = factScope({ raw: claimMap.raw, start: 0, end: claimMap.raw.length, claimSemantics });
  return orderedFactSpans(claimMap.text, quoteMap).some((span) => scopesMatch(
    claimScope,
    factScope({ raw: quoteMap.raw, ...span, claimSemantics }),
  ));
};

// Only the factual core must be supported by a verbatim source quote. Fields
// such as release stage, source unit and allowed future writing are trusted-core
// metadata: concatenating them into the assertion makes a valid structured
// record impossible to prove from prose and causes the whole record to be
// discarded. Legacy sentence-as-name entries remain verifiable via `name`.
export const memoryRecordFactualAssertion = (entry = {}) => String(
  entry?.detail || entry?.name || entry?.state || "",
).trim();

const normalizedEvidenceItems = (memoryUpdate = {}) => (Array.isArray(memoryUpdate?.evidence) ? memoryUpdate.evidence : [])
  .map((item) => ({ claim: String(item?.claim ?? "").trim(), quote: String(item?.quote ?? "").trim() }))
  .filter((item) => item.claim && item.quote);

const evidenceSupportsAssertion = (assertion, evidence = []) => evidence.some((item) => (
  evidenceSupportsClaim({ claim: assertion, quote: item.claim })
));

export const memoryUpdateAssertions = (memoryUpdate = {}) => [
  String(memoryUpdate.chapterSummary ?? "").trim(),
  ...normalizeStateEntries(memoryUpdate.stateChanges).map(memoryRecordFactualAssertion),
  ...normalizeLedgerEntries(memoryUpdate.foreshadowing, { kind: "foreshadow" }).map(memoryRecordFactualAssertion),
  ...normalizeLedgerEntries(memoryUpdate.firstAppearances, { kind: "information" }).map(memoryRecordFactualAssertion),
  ...normalizeLedgerEntries(memoryUpdate.informationRelease, { kind: "information" }).map(memoryRecordFactualAssertion),
  ...normalizeLedgerEntries(memoryUpdate.readerKnowledge, { kind: "information" }).map(memoryRecordFactualAssertion),
  ...(Array.isArray(memoryUpdate.nextContext) ? memoryUpdate.nextContext : []),
  ...(Array.isArray(memoryUpdate.pendingCanon) ? memoryUpdate.pendingCanon : []),
].map((item) => String(item ?? "").trim()).filter(Boolean);

export const verifyMemoryUpdateEvidence = ({ memoryUpdate, candidate = "" } = {}) => {
  if (!memoryUpdate || typeof memoryUpdate !== "object") return { ok: false, reason: "缺少记忆更新" };
  const candidateText = normalized(candidate);
  const evidence = normalizedEvidenceItems(memoryUpdate);
  if (!evidence.length) return { ok: false, reason: "缺少逐项证据" };
  for (const item of evidence) {
    if (!candidateText.includes(normalized(item.quote))) return { ok: false, reason: `引文不在候选稿中：${item.quote.slice(0, 40)}` };
    if (!evidenceSupportsClaim(item)) return { ok: false, reason: `引文不能确定性支持结论：${item.claim.slice(0, 40)}` };
  }
  const assertions = memoryUpdateAssertions(memoryUpdate);
  if (!assertions.length) return { ok: false, reason: "记忆更新没有可验证事实" };
  const unsupported = assertions.find((assertion) => !evidenceSupportsAssertion(assertion, evidence));
  if (unsupported) return { ok: false, reason: `记忆事实没有对应证据：${unsupported.slice(0, 60)}` };
  return { ok: true, evidence };
};

// Model-produced memory updates sometimes contain a useful, fully evidenced
// subset alongside one unsupported assertion. Rejecting the whole update loses
// safe continuity data; accepting it unchanged would weaken the trusted-core
// gate. This helper keeps only assertions that pass the existing deterministic
// evidence rules, then runs the complete verifier again over the reduced update.
// It never writes canon and never turns an unsupported claim into a fact.
export const retainVerifiedMemoryUpdateFacts = ({ memoryUpdate, candidate = "" } = {}) => {
  if (!memoryUpdate || typeof memoryUpdate !== "object" || Array.isArray(memoryUpdate)) {
    return { ok: false, reason: "缺少记忆更新" };
  }
  const candidateText = normalized(candidate);
  const suppliedEvidence = normalizedEvidenceItems(memoryUpdate);
  const validEvidence = suppliedEvidence.filter((item) => (
    candidateText.includes(normalized(item.quote)) && evidenceSupportsClaim(item)
  ));
  const supported = (assertion) => assertion && evidenceSupportsAssertion(assertion, validEvidence);
  const stateChanges = normalizeStateEntries(memoryUpdate.stateChanges).filter((entry) => supported(memoryRecordFactualAssertion(entry)));
  const foreshadowing = normalizeLedgerEntries(memoryUpdate.foreshadowing, { kind: "foreshadow" }).filter((entry) => supported(memoryRecordFactualAssertion(entry)));
  const firstAppearances = normalizeLedgerEntries(memoryUpdate.firstAppearances, { kind: "information" }).filter((entry) => supported(memoryRecordFactualAssertion(entry)));
  const informationRelease = normalizeLedgerEntries(memoryUpdate.informationRelease, { kind: "information" }).filter((entry) => supported(memoryRecordFactualAssertion(entry)));
  const readerKnowledge = normalizeLedgerEntries(memoryUpdate.readerKnowledge, { kind: "information" }).filter((entry) => supported(memoryRecordFactualAssertion(entry)));
  const stringFacts = (value) => (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").trim())
    .filter((item) => supported(item));
  const reduced = {
    chapterSummary: supported(String(memoryUpdate.chapterSummary ?? "").trim()) ? String(memoryUpdate.chapterSummary).trim() : "",
    stateChanges,
    foreshadowing,
    firstAppearances,
    informationRelease,
    readerKnowledge,
    nextContext: stringFacts(memoryUpdate.nextContext),
    pendingCanon: stringFacts(memoryUpdate.pendingCanon),
  };
  const retainedAssertions = memoryUpdateAssertions(reduced);
  const relevantEvidence = validEvidence.filter((item) => retainedAssertions.some((assertion) => (
    evidenceSupportsClaim({ claim: assertion, quote: item.claim })
  )));
  reduced.evidence = relevantEvidence;
  const verification = verifyMemoryUpdateEvidence({ memoryUpdate: reduced, candidate });
  const originalAssertions = memoryUpdateAssertions(memoryUpdate);
  const coverage = {
    originalAssertions: originalAssertions.length,
    retainedAssertions: retainedAssertions.length,
    rejectedAssertions: Math.max(0, originalAssertions.length - retainedAssertions.length),
    suppliedEvidence: suppliedEvidence.length,
    retainedEvidence: relevantEvidence.length,
    rejectedEvidence: Math.max(0, suppliedEvidence.length - relevantEvidence.length),
  };
  if (!verification.ok) return { ok: false, reason: verification.reason, coverage };
  return {
    ok: true,
    memoryUpdate: reduced,
    evidence: verification.evidence,
    partial: coverage.rejectedAssertions > 0 || coverage.rejectedEvidence > 0,
    coverage,
  };
};
