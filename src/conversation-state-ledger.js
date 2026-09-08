const compact = (value = "") => String(value || "").replace(/\s+/gu, " ").trim();
const unique = (items = []) => [...new Map(items.filter(Boolean).map((item) => [`${item.sourceMessageId}:${item.text}`, item])).values()];
const clip = (value = "", limit = 1_200) => {
  const text = compact(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`;
};

const messageContent = (message = {}) => compact(
  (typeof message.candidate === "string" && message.candidate.trim())
  || message.modelContent
  || message.content
  || message.lead
  || "",
);

const activeMessage = (message = {}) => Boolean(
  message
  && ["user", "assistant"].includes(message.role)
  && !message.pending
  && message.contextEligible !== false
  && message.choiceSuperseded !== true
  && message.rolledBack !== true
  && message.isolatedBranch !== true
  && message.branchActive !== false
  && message.candidateBranchActive !== false
  && message.candidateSelected !== false
  && message.candidateDisposition !== "unselected",
);

export const conversationCompressionMessages = (messages = []) => (Array.isArray(messages) ? messages : [])
  .filter(activeMessage)
  .map((message, index) => ({
    id: String(message.id || `message-${index + 1}`),
    role: message.role,
    content: messageContent(message),
    candidateBranchGroupId: String(message.candidateBranchGroupId || ""),
    candidateBranchVersionId: String(message.candidateBranchVersionId || ""),
  }))
  .filter((message) => message.content);

const stableHash = (value = "") => {
  const source = String(value || "");
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193) >>> 0;
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b) >>> 0;
  }
  return `ctx-v1-${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
};

const digestPayload = (messages = []) => conversationCompressionMessages(messages)
  .map((message) => [message.id, message.role, message.candidateBranchGroupId, message.candidateBranchVersionId, message.content].join("\u241f"))
  .join("\u241e");

export const conversationCompressionContentHash = (messages = []) => stableHash(digestPayload(messages));

export const conversationCompressionSourceSignature = (messages = []) => {
  const active = conversationCompressionMessages(messages);
  return active.map((message) => `${message.id}:${message.content.length}:${message.candidateBranchVersionId}`).join("|");
};

const sentenceRows = (messages = []) => conversationCompressionMessages(messages).flatMap((message) => (
  message.content
    .split(/(?<=[。！？!?；;，,])\s*/u)
    .map(compact)
    .filter(Boolean)
    .map((text) => ({ sourceMessageId: message.id, role: message.role, text: clip(text) }))
));

const ACCEPT_PLAN = /^(?:ok|okay|好|好的|可以|确定|确认|同意|没问题|就这样|就按(?:这个|上述|上面|该方案)|按(?:这个|上述|上面|该方案)(?:执行|实施|优化)?|开始(?:执行|实施|优化)|可以开始)[。！!，,\s]*$/iu;
const PLAN_CONTENT = /方案|计划|实施|执行|优化|重构|修改|验收|落盘|路由|上下文|Skill|历史版本|任务状态/u;

const acceptedPlansFromMessages = (messages = []) => {
  const source = conversationCompressionMessages(messages);
  const plans = [];
  for (let index = 1; index < source.length; index += 1) {
    const plan = source[index - 1];
    const acceptance = source[index];
    if (plan.role !== "assistant" || acceptance.role !== "user") continue;
    if (!ACCEPT_PLAN.test(acceptance.content) || plan.content.length < 80 || !PLAN_CONTENT.test(plan.content)) continue;
    plans.push({
      sourceMessageId: plan.id,
      planMessageId: plan.id,
      acceptanceMessageId: acceptance.id,
      text: clip(plan.content, 8_000),
    });
  }
  return plans;
};

const extractEntities = (text = "") => {
  const source = compact(text);
  const entities = new Set();
  for (const match of source.matchAll(/第\s*[一二两三四五六七八九十百千万\d]+\s*[章节集卷幕部]/gu)) entities.add(compact(match[0]));
  for (const match of source.matchAll(/[“‘「『"']([^”’」』"']{2,40})[”’」』"']/gu)) entities.add(compact(match[1]));
  for (const match of source.matchAll(/[A-Z][A-Za-z0-9._-]{1,63}|[a-z][a-z0-9._-]{2,63}/gu)) entities.add(match[0].toLocaleLowerCase("en-US"));
  return [...entities];
};

export const conversationSemanticEntities = (text = "") => extractEntities(text);

const goalRow = (messages = [], previousLedger = null) => {
  const latest = [...conversationCompressionMessages(messages)].reverse().find((message) => message.role === "user");
  if (latest) return { sourceMessageId: latest.id, text: clip(latest.content, 1_600) };
  return previousLedger?.currentGoal || null;
};

const mergeLedgerRows = (previous = [], next = [], limit = 48) => unique([...(previous || []), ...next]).slice(-limit);

export const buildConversationTaskLedger = (messages = [], { previousLedger = null } = {}) => {
  const rows = sentenceRows(messages);
  const userRows = rows.filter((row) => row.role === "user");
  const importantFacts = userRows.filter((row) => /事实(?:是|为)|设定(?:是|为)|已经|目前|现为|身份(?:是|为)|位于|留在|拥有|受伤|死亡|失踪|知道|不知道/u.test(row.text));
  const adoptedDecisions = userRows.filter((row) => /采用|确定|确认|就按|选择|保留(?:方案|方向|设定)|同意(?:方案|方向)/u.test(row.text)
    && !/不采用|不要|否决|放弃|取消/u.test(row.text));
  const rejectedDirections = userRows.filter((row) => /不采用|不要|否决|放弃|取消|作废|不再使用|不能接受/u.test(row.text));
  const characterStates = rows.filter((row) => /受伤|死亡|失踪|昏迷|苏醒|位于|留在|抵达|离开|知道|不知道|决定|背叛|结盟|拥有|失去/u.test(row.text));
  const unfinishedItems = rows.filter((row) => /还需要|尚未|仍待|未完成|待补|待处理|接下来|下一步|稍后/u.test(row.text));
  const unresolvedQuestions = rows.filter((row) => row.role === "assistant" && /[？?]$/u.test(row.text));
  const acceptedPlans = acceptedPlansFromMessages(messages);
  const entities = unique(rows.flatMap((row) => extractEntities(row.text).map((text) => ({ sourceMessageId: row.sourceMessageId, text }))));
  const sourceMessageIds = conversationCompressionMessages(messages).map((message) => message.id);
  return {
    schemaVersion: 1,
    currentGoal: goalRow(messages, previousLedger),
    importantFacts: mergeLedgerRows(previousLedger?.importantFacts, importantFacts),
    adoptedDecisions: mergeLedgerRows(previousLedger?.adoptedDecisions, adoptedDecisions),
    rejectedDirections: mergeLedgerRows(previousLedger?.rejectedDirections, rejectedDirections),
    characterStates: mergeLedgerRows(previousLedger?.characterStates, characterStates),
    unfinishedItems: mergeLedgerRows(previousLedger?.unfinishedItems, unfinishedItems),
    unresolvedQuestions: mergeLedgerRows(previousLedger?.unresolvedQuestions, unresolvedQuestions, 16),
    acceptedPlans: mergeLedgerRows(previousLedger?.acceptedPlans, acceptedPlans, 8),
    entities: mergeLedgerRows(previousLedger?.entities, entities, 64),
    sourceMessageIds: [...new Set([...(previousLedger?.sourceMessageIds || []), ...sourceMessageIds])],
  };
};

const validCheckpointPrefix = (checkpoint = null, messages = []) => {
  if (!checkpoint || checkpoint.schemaVersion !== 1) return false;
  const active = conversationCompressionMessages(messages);
  const coveredCount = Math.max(0, Number(checkpoint.coverage?.messageCount) || 0);
  if (!coveredCount || coveredCount > active.length) return false;
  const prefix = active.slice(0, coveredCount);
  if (prefix.some((message, index) => message.id !== checkpoint.sourceMessageIds?.[index])) return false;
  return conversationCompressionContentHash(prefix) === checkpoint.contentHash;
};

export const validateConversationCompressionCheckpoint = (checkpoint = null, messages = []) => {
  if (!checkpoint) return { valid: false, reason: "missing_checkpoint" };
  const active = conversationCompressionMessages(messages);
  if (!validCheckpointPrefix(checkpoint, active)) return { valid: false, reason: "source_changed" };
  const coveredCount = Math.max(0, Number(checkpoint.coverage?.messageCount) || 0);
  if (coveredCount !== active.length) return { valid: false, reason: "coverage_stale" };
  return { valid: true, reason: "verified" };
};

export const buildConversationCompressionCheckpoint = (messages = [], {
  previousCheckpoint = null,
  createdAt = new Date().toISOString(),
} = {}) => {
  const active = conversationCompressionMessages(messages);
  const prefixValid = validCheckpointPrefix(previousCheckpoint, active);
  const coveredCount = prefixValid ? Math.max(0, Number(previousCheckpoint.coverage?.messageCount) || 0) : 0;
  const delta = active.slice(coveredCount);
  const analysisDelta = coveredCount > 0 ? active.slice(coveredCount - 1) : active;
  const ledger = buildConversationTaskLedger(analysisDelta, {
    previousLedger: prefixValid ? previousCheckpoint.ledger : null,
  });
  const sourceMessageIds = active.map((message) => message.id);
  return {
    schemaVersion: 1,
    createdAt: String(createdAt || new Date().toISOString()),
    sourceMessageIds,
    deltaSourceMessageIds: delta.map((message) => message.id),
    contentHash: conversationCompressionContentHash(active),
    coverage: {
      messageCount: active.length,
      firstMessageId: sourceMessageIds[0] || "",
      lastMessageId: sourceMessageIds.at(-1) || "",
    },
    invalidatedPrevious: Boolean(previousCheckpoint && !prefixValid),
    ledger: {
      ...ledger,
      sourceMessageIds,
    },
  };
};

const ledgerLines = (label, rows = [], limit = 12) => rows.length
  ? `${label}：\n${rows.slice(-limit).map((row) => `- [来源 ${row.sourceMessageId}] ${row.text}`).join("\n")}`
  : "";

export const conversationTaskLedgerPrompt = (ledger = null) => {
  if (!ledger) return "";
  return [
    ledger.currentGoal?.text ? `当前任务目标：[来源 ${ledger.currentGoal.sourceMessageId}] ${ledger.currentGoal.text}` : "",
    ledgerLines("重要事实", ledger.importantFacts),
    ledgerLines("已经采用的方案", ledger.adoptedDecisions),
    ledgerLines("已经否决的方向", ledger.rejectedDirections),
    ledgerLines("人物与对象状态", ledger.characterStates),
    ledgerLines("未完成事项", ledger.unfinishedItems),
  ].filter(Boolean).join("\n\n");
};
