const RECOVERY_ACTION_PATTERN = /(?:找回|恢复|取回|捞回|还原|提取)/u;
const DELETED_SCOPE_PATTERN = /(?:回收站|已删除|被删除|删掉|删除的|刚(?:刚|才)?删|删掉的)/u;
const BROAD_RECOVERY_PATTERN = /(?:(?:找回|恢复|取回|捞回|还原|提取).{0,12}(?:全部|所有|全都|整个回收站)|(?:全部|所有|全都|整个回收站).{0,12}(?:找回|恢复|取回|捞回|还原|提取))/u;
const RECENT_TARGET_PATTERN = /(?:刚才|刚刚|最近|上一个|最后一个|刚删)/u;
const SEGMENT_REQUEST_PATTERN = /(?:某段|那段|片段|部分内容|关于.{1,40}(?:的内容|的部分|那段|片段)|第[一二三四五六七八九十\d]+段)/u;
const GENERIC_TARGETS = new Set(["内容", "对话", "历史对话", "文档", "章节", "白板", "回收项", "东西", "资料"]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const stripMarkup = (value) => clean(String(value ?? "")
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&lt;/giu, "<")
  .replace(/&gt;/giu, ">"));

const quotedTargets = (text) => [...String(text).matchAll(/《([^》]{1,80})》|「([^」]{1,80})」|“([^”]{1,80})”|"([^"]{1,80})"|'([^']{1,80})'/gu)]
  .map((match) => clean(match.slice(1).find(Boolean)))
  .filter(Boolean);

const inferredTargetHint = (text) => {
  const quoted = quotedTargets(text);
  if (quoted.length) return quoted[0];
  const source = clean(text)
    .replace(RECOVERY_ACTION_PATTERN, " ")
    .replace(DELETED_SCOPE_PATTERN, " ")
    .replace(/(?:从|在|里|中|里的|中的|那份|那个|这份|这个|某个|一份|一条|一段|关于|请|帮我|一下)/gu, " ")
    .replace(/(?:历史对话|对话|文档|章节|白板|内容|片段|部分)$/u, " ");
  const hint = clean(source).replace(/[，。！？、；：]/gu, " ").trim();
  return hint.length >= 2 && !GENERIC_TARGETS.has(hint) ? hint.slice(0, 80) : "";
};

const segmentTermsForPrompt = (text) => {
  const terms = [];
  const about = String(text).match(/关于\s*([^，。！？；：]{1,40}?)(?:的那段|那段|的内容|的部分|片段|$)/u)?.[1];
  if (about) terms.push(clean(about));
  const quoted = quotedTargets(text);
  if (quoted.length > 1) terms.push(...quoted.slice(1));
  return [...new Set(terms.filter((term) => term.length >= 1))];
};

export const deletedContentRequestMentioned = (prompt = "") => DELETED_SCOPE_PATTERN.test(clean(prompt));

export const deletedContentAccessDecision = (prompt = "") => {
  const text = clean(prompt);
  const explicitAction = RECOVERY_ACTION_PATTERN.test(text);
  const deletedScope = DELETED_SCOPE_PATTERN.test(text);
  const broad = BROAD_RECOVERY_PATTERN.test(text);
  const targetHint = inferredTargetHint(text);
  const recentTarget = RECENT_TARGET_PATTERN.test(text);
  const segmentRequested = SEGMENT_REQUEST_PATTERN.test(text);
  const segmentTerms = segmentTermsForPrompt(text);
  const specificTarget = Boolean(targetHint || recentTarget);
  const authorized = Boolean(text && explicitAction && deletedScope && specificTarget && !broad);
  return Object.freeze({
    authorized,
    reason: authorized ? "explicit_specific_recovery" : broad ? "broad_recovery_denied" : "no_explicit_specific_recovery",
    targetHint,
    recentTarget,
    segmentRequested,
    segmentTerms,
  });
};

const entryTitle = (entry = {}) => clean(entry.title || entry.conversation?.title || entry.document?.title || entry.id || "");
const entryKindMatchesPrompt = (entry, prompt) => {
  if (/(?:历史)?对话/u.test(prompt)) return entry.kind === "conversation" || Boolean(entry.conversation);
  if (/(?:文档|章节|正文)/u.test(prompt)) return entry.kind === "file" || entry.kind === "tree" || Boolean(entry.document || entry.documents);
  if (/白板/u.test(prompt)) return entry.document?.documentKind === "whiteboard"
    || Object.values(entry.documents ?? {}).some((document) => document?.documentKind === "whiteboard");
  return true;
};

const selectAuthorizedEntries = (entries, prompt, decision) => {
  if (!decision.authorized) return [];
  const active = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entryKindMatchesPrompt(entry, prompt))
    .sort((left, right) => Date.parse(right.deletedAtIso || right.deletedAt || 0) - Date.parse(left.deletedAtIso || left.deletedAt || 0));
  if (decision.targetHint) {
    const hint = decision.targetHint.toLowerCase();
    const exact = active.filter((entry) => {
      const title = entryTitle(entry).toLowerCase();
      return title === hint || title.includes(hint) || hint.includes(title);
    });
    if (exact.length) return exact.slice(0, 1);
  }
  return decision.recentTarget ? active.slice(0, 1) : [];
};

const boundedMatchingLines = (lines, terms, maximum) => {
  const matches = lines.filter((line) => terms.some((term) => line.toLowerCase().includes(term.toLowerCase())));
  let result = "";
  for (const line of matches) {
    const next = result ? `${result}\n${line}` : line;
    if (next.length > maximum) break;
    result = next;
  }
  return result;
};

const deletedEntrySegment = (entry, terms, maximum) => {
  if (!terms.length) return "";
  if (entry.kind === "conversation" || entry.conversation) {
    const lines = (entry.conversation?.messages ?? [])
      .map((message) => `${message.role === "assistant" ? "神思" : "用户"}：${stripMarkup(message.content || message.modelContent || "")}`)
      .filter((line) => line.length > 3);
    return boundedMatchingLines(lines, terms, maximum);
  }
  const documents = entry.kind === "tree" ? Object.values(entry.documents ?? {}) : [entry.document].filter(Boolean);
  const lines = documents.flatMap((document) => stripMarkup(document?.html || document?.markdown || "").split(/(?<=[。！？\n])/u).map(clean).filter(Boolean));
  return boundedMatchingLines(lines, terms, maximum);
};

export const buildDeletedContentRecoveryContext = ({ entries = [], prompt = "", maxChars = 6000 } = {}) => {
  const decision = deletedContentAccessDecision(prompt);
  const selected = selectAuthorizedEntries(entries, prompt, decision);
  const maximum = Math.max(500, Math.min(12_000, Number(maxChars) || 6000));
  const contextText = decision.segmentRequested && decision.segmentTerms.length && selected.length
    ? selected.map((entry) => {
      const segment = deletedEntrySegment(entry, decision.segmentTerms, maximum);
      return segment ? `## 已删除内容片段 · ${entryTitle(entry)}\n${segment}` : "";
    }).filter(Boolean).join("\n\n").slice(0, maximum)
    : "";
  return Object.freeze({
    ...decision,
    entries: Object.freeze(selected.map((entry) => Object.freeze({
      trashId: clean(entry.trashId || entry.id),
      title: entryTitle(entry),
      kind: clean(entry.kind || (entry.conversation ? "conversation" : "file")),
    }))),
    contextText,
  });
};

export const deletedContentSearchEntries = (entries = [], prompt = "") => {
  const decision = deletedContentAccessDecision(prompt);
  return selectAuthorizedEntries(entries, prompt, decision);
};

export const sanitizeDeletedContentWorkspaceRequest = ({ prompt = "", workspaceMeta = {}, documentContext = [] } = {}) => {
  const decision = deletedContentAccessDecision(prompt);
  const allowedTrash = decision.authorized
    ? selectAuthorizedEntries(workspaceMeta?.trash ?? [], prompt, decision)
    : [];
  const allowDeletedBlocks = decision.authorized && allowedTrash.length > 0;
  const contextWasString = typeof documentContext === "string";
  const contextBlocks = contextWasString
    ? String(documentContext).split(/(?=^##\s*已删除内容片段)/gmu)
    : Array.isArray(documentContext) ? documentContext : [];
  const safeContextBlocks = contextBlocks
    .filter((entry) => allowDeletedBlocks || !/^##\s*已删除内容片段/u.test(String(entry || "").trim()));
  return Object.freeze({
    decision,
    workspaceMeta: Object.freeze({
      ...(workspaceMeta ?? {}),
      trash: Object.freeze(allowedTrash.map((entry) => Object.freeze({ ...entry }))),
    }),
    documentContext: contextWasString
      ? safeContextBlocks.join("\n\n")
      : Object.freeze(safeContextBlocks),
  });
};
