const compact = (value = "") => String(value).replace(/\s+/g, " ").trim();

import { stripInternalAssistantProtocol } from "./assistant-visible-content.js";
import { conversationSemanticEntities, conversationTaskLedgerPrompt, validateConversationCompressionCheckpoint } from "./conversation-state-ledger.js";

const clipped = (value, limit) => {
  const text = String(value || "").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const messageText = (message = {}) => compact(
  (typeof message.candidate === "string" && message.candidate.trim())
  || message.modelContent
  || message.content
  || message.lead
  || "",
);
const isCandidate = (message = {}) => Boolean(message.candidate) || /^【候选稿】/.test(messageText(message));
const unique = (items) => [...new Set(items.filter(Boolean))];

const DEFAULT_CONVERSATION_CHARACTER_BUDGET = 96_000;
const DEFAULT_RECENT_VERBATIM_TURNS = 12;
const MAX_CAPSULE_CHARACTERS = 32_000;

const candidateLifecycleState = (message = {}) => String(
  message.candidateLifecycle
  || message.candidateDisposition
  || message.candidateDecision
  || "",
).trim().toLowerCase();

const activeCandidateBranchMessage = (message = {}) => {
  const lifecycle = candidateLifecycleState(message);
  if (["discarded", "rejected", "abandoned", "废弃", "丢弃", "拒绝"].includes(lifecycle)) return false;
  if (message.candidateBranchActive === false) return false;
  return !message.candidateBranchGroupId || message.candidateBranchActive === true;
};

export const candidateComparisonAnalysisRequested = (value = "") => (
  /(?:分析|比较|对比|评估|点评|拆解).{0,18}(?:全部|所有|多个|这(?:几|三|两)个|各(?:个|版|稿))?(?:候选|版本|稿)|(?:全部|所有|多个|这(?:几|三|两)个|各(?:个|版|稿))(?:候选|版本|稿).{0,18}(?:分析|比较|对比|评估|点评|拆解)/u.test(compact(value))
);

export const candidateComparisonContextMessages = (messages = []) => {
  const source = Array.isArray(messages) ? messages : [];
  const latestUser = [...source].reverse().find((message) => message?.role === "user");
  if (!candidateComparisonAnalysisRequested(messageText(latestUser))) return [];
  const candidateGroups = new Map();
  for (const message of source) {
    const groupId = String(message?.candidateBranchGroupId || "").trim();
    if (!groupId || message?.role !== "assistant" || !isCandidate(message)) continue;
    if (!candidateGroups.has(groupId)) candidateGroups.set(groupId, []);
    candidateGroups.get(groupId).push(message);
  }
  const latestGroup = [...candidateGroups.values()].reverse().find((group) => group.length > 1) || [];
  return latestGroup.map((message, index) => ({
    ...message,
    id: String(message.id || `candidate-comparison-${index + 1}`),
    content: `【候选稿 ${index + 1}｜仅供本轮比较分析】\n${conversationMessageContentForModel(message)}`,
    candidate: "",
    candidateBranchGroupId: "",
    candidateBranchActive: true,
    candidateSelected: true,
    candidateComparisonContext: true,
  }));
};

export const conversationMessageEligibleForModel = (message = {}) => {
  if (!message || !["user", "assistant"].includes(message.role)) return false;
  if (message.pending || message.contextEligible === false || message.choiceSuperseded === true || message.rolledBack === true || message.isolatedBranch === true) return false;
  if (message.branchActive === false) return false;
  if (!activeCandidateBranchMessage(message)) return false;
  if (message.candidateSelected === false || message.candidateDisposition === "unselected") return false;
  return true;
};

const HISTORICAL_REFERENCE_MARKER = "【本轮明确回指的较早对话】";
const HISTORICAL_REFERENCE_PATTERN = /(?:回到|回看|回顾|继续|接着|承接|恢复|重启|重新|再来|再做|完成|处理|解决|优化|修改|分析|检查|评估|解释|回答|生成|创作|写|读取|核对).{0,28}(?:之前|此前|前面|早先|上次|上文|前文|刚才|先前)|(?:之前|此前|前面|早先|上次|上文|前文|刚才|先前).{0,40}(?:任务|问题|话题|对话|要求|指令|文章|正文|章节|那篇|稿|版本|方案|分析|内容|结果|提示词|素材|资料)|(?:那篇|那个任务|那个问题|那个话题|那个版本|那一版|那章|那段|那次).{0,24}(?:继续|完成|处理|解决|优化|修改|分析|检查|生成|写|怎么|如何|为什么)|(?:与|跟|和).{0,8}(?:之前|此前|前面|早先|上次|上文|刚才).{0,12}(?:对话|任务|问题|内容).{0,12}(?:有关|相关)/u;
const HISTORICAL_TASK_ACTION_PATTERN = /继续|接着|承接|恢复|完成|处理|解决|优化|修改|改写|重写|分析|检查|诊断|评估|解释|回答|生成|创作|撰写|写|读取|核对|查找|设计|制作|转换|落盘|安装|打包|修复|标题|命名|改名|起名|为什么|如何|怎么|能否|是否|有没有/u;
const CREATIVE_THREAD_MODES = new Set(["creative", "creative_guidance", "visual_prompt", "quick_revision"]);
const PLAN_ACCEPTANCE_PATTERN = /^(?:ok|okay|好|好的|可以|确定|确认|同意|没问题|就这样|就按(?:这个|上述|上面|该方案)|按(?:这个|上述|上面|该方案)(?:执行|实施|优化)?|开始(?:执行|实施|优化)|可以开始)[。！!，,\s]*$/iu;
const IMPLEMENTATION_PLAN_PATTERN = /方案|计划|实施|执行|优化|重构|修改|验收|落盘|路由|上下文|Skill|历史版本|任务状态/u;

export const explicitHistoricalContinuityAnchors = (request = "") => {
  const source = compact(request);
  const captures = [...source.matchAll(/(?:保留|沿用|继续使用|必须保持|不要丢失|不可丢失)([^。！？；\n]{1,120}?)(?:这些?|以上|上述)?(?:关键)?(?:设定|元素|专名|名称|信息|锚点)/gu)];
  const anchors = captures.flatMap((match) => String(match[1] || "")
    .replace(/^(?:住|好|原有|此前|之前|前面的?)\s*/u, "")
    .replace(/(?:三|四|五|六|七|八|九|十|\d+)个$/u, "")
    .split(/[、，,；;和与及]/u)
    .map((item) => item.replace(/[《》「」『』“”‘’"']/gu, "").trim())
    .filter((item) => item.length >= 1 && item.length <= 30));
  return unique(anchors).slice(0, 20);
};

export const extractAcceptedConversationPlans = (messages = [], { limit = 6, perPlanLimit = 8_000 } = {}) => {
  const source = Array.isArray(messages) ? messages : [];
  const accepted = [];
  for (let index = 1; index < source.length; index += 1) {
    const acceptance = source[index];
    const plan = source[index - 1];
    const acceptanceText = messageText(acceptance);
    const planText = messageText(plan);
    if (acceptance?.role !== "user" || plan?.role !== "assistant") continue;
    if (!PLAN_ACCEPTANCE_PATTERN.test(acceptanceText) || planText.length < 80 || !IMPLEMENTATION_PLAN_PATTERN.test(planText)) continue;
    accepted.push({
      planMessageId: String(plan.id || `message-${index}`),
      acceptanceMessageId: String(acceptance.id || `message-${index + 1}`),
      text: clipped(planText, perPlanLimit),
    });
  }
  return accepted.slice(-Math.max(1, Number(limit) || 1));
};

export const conversationMessageContentForModel = (message = {}, { candidateLabel = "【候选稿】" } = {}) => {
  const candidate = typeof message?.candidate === "string" ? message.candidate.trim() : "";
  if (candidate) return `${candidateLabel}\n${stripInternalAssistantProtocol(candidate)}`.trim();
  return stripInternalAssistantProtocol(message?.modelContent || message?.content || message?.lead || "");
};

const generatedMediaEntries = (message = {}) => [
  ...(Array.isArray(message.generatedImages) ? message.generatedImages : []).map((attachment) => ({ kind: "图片", attachment })),
  ...(Array.isArray(message.generatedVideos) ? message.generatedVideos : []).map((attachment) => ({ kind: "视频", attachment })),
  ...(Array.isArray(message.generatedAudios) ? message.generatedAudios : []).map((attachment) => ({ kind: "音频", attachment })),
].filter((entry) => entry.attachment?.relativePath || entry.attachment?.name);

export const conversationGeneratedMediaContext = (message = {}) => {
  const entries = generatedMediaEntries(message);
  if (!entries.length) return "";
  const batch = message.mediaBatch ?? message.execution?.mediaBatch ?? {};
  const batchIdentity = batch.id
    ? `批次 ${batch.id}，第 ${Math.max(1, Number(batch.index) || 1)}/${Math.max(1, Number(batch.total) || 1)} 项${batch.label ? `「${compact(batch.label)}」` : ""}`
    : "单项生成";
  const prompt = clipped(compact(message.generationPrompt || ""), 1_600);
  const lines = entries.map(({ kind, attachment }, index) => {
    const name = compact(attachment.name || attachment.relativePath || `${kind}${index + 1}`);
    const location = compact(attachment.relativePath || "");
    const dimensions = Number(attachment.width) > 0 && Number(attachment.height) > 0
      ? `${Number(attachment.width)}×${Number(attachment.height)}`
      : "";
    return `- ${kind}${entries.length > 1 ? ` ${index + 1}` : ""}：${name}${location ? `；工作区附件 ${location}` : ""}${dimensions ? `；${dimensions}` : ""}`;
  });
  return [
    `【本条已落盘生成媒体｜${batchIdentity}】`,
    ...lines,
    prompt ? `【实际生成提示词】${prompt}` : "",
    "后续用户提到“上面/刚才/这些图片”或批次序号时，应把本条媒体与对应提示词作为同一神思对话的可追溯上下文；需要判断画面内容时，还必须读取随请求附带的真实图片附件。",
  ].filter(Boolean).join("\n");
};

const GENERATED_IMAGE_REFERENCE_PATTERN = /(?:(?:上面|上述|前面|刚才|方才|这些|这组|那组|本批|上一批|刚生成|生成的).{0,18}(?:图片|图像|照片|插画|画面|视觉资产|成品图)|(?:第\s*\d+\s*张|哪一张|每一张|所有图片|全部图片).{0,18}(?:图片|图像|照片|插画|画面|视觉资产|成品图)?|(?:分析|检查|评价|修改|继续|参考|读取|识别|看看|比较|对比|选择|使用|基于|按照).{0,18}(?:这张图|这些图|上面的图|刚才的图|生成图|成品图))/u;

const generatedMessageBatch = (message = {}) => message.mediaBatch ?? message.execution?.mediaBatch ?? {};

export const conversationGeneratedImageAttachmentsForReference = (messages = [], query = "", { limit = 50 } = {}) => {
  const instruction = compact(query);
  if (!GENERATED_IMAGE_REFERENCE_PATTERN.test(instruction)) return [];
  const imageMessages = (Array.isArray(messages) ? messages : [])
    .filter(conversationMessageEligibleForModel)
    .filter((message) => Array.isArray(message.generatedImages) && message.generatedImages.some((attachment) => attachment?.relativePath));
  if (!imageMessages.length) return [];
  const latest = imageMessages.at(-1);
  const latestBatchId = String(generatedMessageBatch(latest).id || "");
  const ordinalMatches = [...instruction.matchAll(/第\s*(\d+)\s*张/gu)]
    .map((match) => Math.max(1, Number(match[1]) || 1));
  let selected = latestBatchId
    ? imageMessages.filter((message) => String(generatedMessageBatch(message).id || "") === latestBatchId)
    : [latest];
  if (ordinalMatches.length) {
    const requested = new Set(ordinalMatches);
    selected = selected.filter((message, index) => requested.has(Math.max(1, Number(generatedMessageBatch(message).index) || index + 1)));
  }
  const attachments = selected.flatMap((message) => {
    const batch = generatedMessageBatch(message);
    return message.generatedImages
      .filter((attachment) => attachment?.relativePath)
      .map((attachment) => ({
        ...attachment,
        contextOrigin: "conversation-generated-media",
        sourceMessageId: String(message.id || ""),
        ...(batch.id ? {
          mediaBatchId: String(batch.id),
          mediaBatchIndex: Math.max(1, Number(batch.index) || 1),
          mediaBatchTotal: Math.max(1, Number(batch.total) || 1),
          mediaBatchLabel: String(batch.label || ""),
        } : {}),
      }));
  });
  return [...new Map(attachments.map((attachment) => [String(attachment.relativePath).replace(/\\/g, "/").toLowerCase(), attachment])).values()]
    .slice(0, Math.max(1, Number(limit) || 50));
};

const conversationMessageForModel = (message = {}) => ({
  role: message.role,
  content: message.content,
  ...(message.candidateBranchGroupId ? {
    candidateBranchGroupId: String(message.candidateBranchGroupId),
    candidateBranchVersionId: String(message.candidateBranchVersionId || ""),
    candidateBranchActive: true,
  } : {}),
  ...(message.contextCapsule === true ? { contextCapsule: true } : {}),
  ...(message.recalledCandidate === true ? { recalledCandidate: true } : {}),
  ...(message.recalledHistory === true ? {
    recalledHistory: true,
    recalledHistorySourceId: String(message.recalledHistorySourceId || message.id || ""),
  } : {}),
});

const clipMessageContentToBudget = (content = "", maxChars = 1) => {
  const text = String(content || "");
  const limit = Math.max(1, Number(maxChars) || 1);
  if (text.length <= limit) return text;
  if (limit < 80) return text.slice(0, limit);
  const marker = "\n[…本条消息因单次模型窗口限制仅保留首尾；完整原文仍在对话历史中…]\n";
  const available = Math.max(1, limit - marker.length);
  const head = Math.max(1, Math.floor(available * 0.62));
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
};

export const modelConversationCharacterBudget = (settings = {}) => {
  const explicitWindowTokens = Number(settings.contextWindowTokens || settings.contextTokens || 0);
  if (Number.isFinite(explicitWindowTokens) && explicitWindowTokens > 0) {
    const rawPercent = Number(settings.effectiveContextWindowPercent || settings.contextWindowPercent || 95);
    const effectivePercent = rawPercent > 1 ? rawPercent / 100 : rawPercent;
    const usableWindow = explicitWindowTokens * Math.min(1, Math.max(0.5, effectivePercent || 0.95));
    const outputReserve = Math.max(8_000, Number(settings.maxOutputTokens) || 4_000);
    const systemAndToolReserve = Math.max(8_000, Math.floor(usableWindow * 0.06));
    // 神思正文以中文为主，使用 1 字≈1 token 的保守估算。窗口大小和
    // effective percent 来自本地 Codex 模型目录；超出后再进入与 Codex
    // 一致的“最近原文 + 压缩胶囊 + 按需召回”路径，而不是固定截 12 轮。
    return Math.max(40_000, Math.floor(usableWindow - outputReserve - systemAndToolReserve));
  }
  const provider = String(settings.provider || "").toLowerCase();
  const model = String(settings.model || "").toLowerCase();
  if (/^gpt-5\.6(?:-|$)/.test(model)) return 104_000;
  if (/^gpt-5\.(?:[1-5])(?:-|$)/.test(model)) return 160_000;
  if (/^(?:gpt-4\.1|gpt-4o)(?:-|$)/.test(model)) return 96_000;
  if (/claude|gemini|kimi|moonshot/.test(`${provider} ${model}`)) return 160_000;
  return DEFAULT_CONVERSATION_CHARACTER_BUDGET;
};

export const normalizeConversationMessages = (messages = []) => (Array.isArray(messages) ? messages : [])
  .filter(conversationMessageEligibleForModel)
  .map((message) => ({
    ...message,
    content: conversationMessageContentForModel(message),
  }))
  .filter((message) => message.content);

const turnAssociationKey = (message = {}) => {
  const snapshot = message?.turnContextSnapshot;
  if (!snapshot || message?.role !== "user") return "";
  if (snapshot.associationEnabled === false) return `conversation:${String(snapshot.conversationId || "unbound")}:unbound`;
  const workspace = String(snapshot.workspacePath || snapshot.workspaceName || "").trim().toLocaleLowerCase("en-US");
  const documentId = String(snapshot.boundDocumentId || "").trim();
  return documentId ? `${workspace}::${documentId}` : "";
};

export const conversationMessagesForActiveAssociation = (messages = [], { allowCrossAssociation = false } = {}) => {
  const source = Array.isArray(messages) ? messages : [];
  if (allowCrossAssociation || source.length < 2) return source;
  const latestUserIndex = source.findLastIndex((message) => message?.role === "user");
  if (latestUserIndex < 0) return source;
  const currentMessage = source[latestUserIndex];
  if (currentMessage?.turnContextSnapshot?.associationEnabled === false) return source;
  const currentKey = turnAssociationKey(currentMessage);
  if (!currentKey) return source;
  const currentRevision = Math.max(0, Number(currentMessage?.turnContextSnapshot?.associationRevision) || 0);
  let firstCurrentTurnIndex = latestUserIndex;
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (message?.role !== "user") continue;
    const key = turnAssociationKey(message);
    if (key === currentKey) {
      firstCurrentTurnIndex = index;
      continue;
    }
    if (key || currentRevision > 0) break;
  }
  return source.slice(firstCurrentTurnIndex);
};

export const rebuildConversationDerivedContext = (conversation = {}, activeMessages = []) => {
  const eligible = normalizeConversationMessages(activeMessages);
  conversation.constraintIndex = extractConversationConstraintIndex(eligible);
  conversation.contextCapsule = null;
  conversation.contextBudget = null;
  conversation.conversationContextCheckpoint = null;
  conversation.contextLedger = null;
  conversation.contextCompressionSignature = "";
  conversation.contextCompressionStatus = null;
  conversation.pendingTargetResolution = null;
  const activeMessageIds = new Set(eligible.map((message) => String(message.id || "")).filter(Boolean));
  conversation.candidateBranchGroups = (conversation.candidateBranchGroups ?? []).filter((group) => (
    (group.versions ?? []).some((version) => (version.messages ?? []).some((message) => activeMessageIds.has(String(message.id || ""))))
  ));
  conversation.branchGroups = (conversation.branchGroups ?? []).filter((group) => (
    (group.versions ?? []).some((version) => (version.messages ?? []).some((message) => activeMessageIds.has(String(message.id || ""))))
  ));
  return conversation;
};

export const trimConversationMessagesToBudget = (messages = [], { maxChars = DEFAULT_CONVERSATION_CHARACTER_BUDGET } = {}) => {
  const active = normalizeConversationMessages(messages);
  const budget = Math.max(1, Number(maxChars) || DEFAULT_CONVERSATION_CHARACTER_BUDGET);
  if (!active.length) return [];
  const capsule = active.find((message) => message.contextCapsule === true) || null;
  const recalled = active.filter((message) => message.recalledCandidate === true || message.recalledHistory === true);
  const selectedIndexes = new Set();
  const selected = [];
  let used = 0;

  const add = (message, index, allowance = budget - used) => {
    if (!message || selectedIndexes.has(index) || allowance <= 24 || used >= budget) return false;
    const available = Math.max(1, Math.min(allowance, budget - used) - 24);
    const content = clipMessageContentToBudget(message.content, available);
    if (!content) return false;
    selected.push({ index, message: { ...message, content } });
    selectedIndexes.add(index);
    used += content.length + 24;
    return true;
  };

  if (capsule) {
    const index = active.indexOf(capsule);
    add(capsule, index, Math.min(MAX_CAPSULE_CHARACTERS + 24, Math.floor(budget * 0.25)));
  }

  // The latest user instruction is always represented, even when that single
  // instruction itself exceeds the selected model's working-context budget.
  add(active.at(-1), active.length - 1, budget - used);

  for (const message of recalled) {
    const index = active.indexOf(message);
    add(message, index, budget - used);
  }

  for (let index = active.length - 1; index >= 0; index -= 1) {
    const message = active[index];
    if (selectedIndexes.has(index)) continue;
    const cost = message.content.length + 24;
    if (used + cost > budget) continue;
    add(message, index, cost);
  }
  return selected
    .sort((left, right) => {
      if (left.message.contextCapsule === true) return -1;
      if (right.message.contextCapsule === true) return 1;
      return left.index - right.index;
    })
    .map(({ message }) => message);
};

const matchingSentences = (text, pattern, limit = 3) => compact(text)
  .split(/(?<=[。！？!?；;])\s*/)
  .map((item) => item.trim())
  .filter((item) => item && pattern.test(item))
  .slice(0, limit);

const directiveClauses = (text = "") => compact(text)
  .split(/(?<=[。！？!?；;，,])\s*/u)
  .map((item) => item.replace(/[。！？!?；;，,]+$/u, "").trim())
  .filter(Boolean);

const quotedSegments = (text = "") => [...String(text).matchAll(/[“‘「『"']([^”’」』"']{2,80})[”’」』"']/gu)]
  .map((match) => compact(match[1]));

const directiveTarget = (text = "") => compact(text)
  .replace(/^(?:现在|从现在起|以后|接下来|请|务必|必须|应当|需要|继续|始终|一律|明确)?/u, "")
  .replace(/^(?:不要|不能|不许|不得|禁止|避免|无需|不用|允许|可以|保留|保持|改成|改为|采用|选择|确认|就用|增加|加入|去掉|取消)+/u, "")
  .replace(/(?:这个|该项|这一项)?(?:要求|规则|方向)$/u, "")
  .trim();

const comparableTarget = (text = "") => directiveTarget(text)
  .replace(/(?:内容|部分|方面|规则|要求|方向|方式|进行|使用|采用|写入|写|加上|加入|增加)/gu, "")
  .replace(/[\s，。！？、：；,.!?:;“”‘’「」『』()（）【】\[\]]/gu, "")
  .trim();

const targetsOverlap = (left = "", right = "") => {
  const a = comparableTarget(left);
  const b = comparableTarget(right);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.length < 2) return false;
  let shared = 0;
  for (const character of new Set(shorter)) if (longer.includes(character)) shared += 1;
  return shared / new Set(shorter).size >= 0.75;
};

const nonBindingMetaClause = (text = "") => /^(?:例如|比如|譬如|举例|假设|示例)/u.test(text)
  || /(?:不是|并非)(?:说|要求|意味着|代表).*(?:必须|务必|只能|一定)|只是(?:举例|例子|示例|假设)|不代表(?:必须|一定)/u.test(text)
  || /(?:是否|能否|可否|要不要|是不是|为什么).*(?:必须|需要|可以|允许)|(?:可以|允许).*(?:吗|呢)$/u.test(text)
  || /^(?:他说|她说|原文写道|角色说|文中提到)[：:]?/u.test(text);

const allowanceClause = (text = "") => /(?:现在|目前|从现在起)?(?:可以|允许)|不再禁止|不再限制/u.test(text)
  && !/(?:不可以|不允许)/u.test(text);

const revocationClause = (text = "") => /作废|撤回|不再适用|忽略(?:上一条|此前|之前|前面)|取消(?:上一条|此前|之前|前面|该项|这个)(?:要求|规则|限制)?/u.test(text);

const requirementClause = (text = "") => /必须|务必|始终|一律|应当|需要|保持|保留|改成|改为|采用|选择|确认|就用|取消|去掉|删除/u.test(text);
const prohibitionClause = (text = "") => /不要|不能|不许|不得|禁止|避免|无需|不用/u.test(text)
  && !allowanceClause(text);
const clarificationClause = (text = "") => /也就是说|我的意思是|准确来说|需要注意|仅限|只指|这里指/u.test(text);

const constraintScope = (text = "") => {
  if (/这次|本次|本轮|这一轮|暂时/u.test(text)) return "turn";
  if (/本段|这段|这一段/u.test(text)) return "paragraph";
  if (/本章|这章|这一章/u.test(text)) return "chapter";
  if (/这一版|这版|本版/u.test(text)) return "draft";
  if (/以后都这样|以后(?:都|一律|始终)|记住|长期|永久/u.test(text)) return "persistent_candidate";
  return "conversation";
};

const constraintMetadata = ({ sourceMessageId, text }) => {
  const scope = constraintScope(text);
  const confirmation = scope === "persistent_candidate" ? "pending" : "not_required";
  return {
    sourceMessageId,
    text,
    originalText: text,
    scope,
    level: "advisory",
    requestedLevel: confirmation === "pending" ? "confirmed" : "advisory",
    confirmation,
    binding: false,
  };
};

const sourceLabel = (entry = {}) => `[来源 ${entry.sourceMessageId}] ${entry.text}`;

export const extractConversationConstraintIndex = (messages = []) => {
  const ledger = [];
  const activeEntries = () => ledger.filter((entry) => entry.active === true && ["requirement", "prohibition"].includes(entry.kind));
  const revoke = (entry, revocationId, reason) => {
    entry.active = false;
    entry.supersededBy = revocationId;
    entry.revocationReason = reason;
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role !== "user" || isCandidate(message)) continue;
    const sourceMessageId = String(message.id || `message-${messageIndex + 1}`);
    const clauses = directiveClauses(messageText(message));
    for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      const text = clauses[clauseIndex];
      const entryId = `constraint:${sourceMessageId}:${clauseIndex + 1}`;
      const metadata = constraintMetadata({ sourceMessageId, text });
      if (nonBindingMetaClause(text)) {
        ledger.push({ id: entryId, ...metadata, target: directiveTarget(text), kind: "clarification", active: true });
        continue;
      }
      if (allowanceClause(text)) {
        const target = directiveTarget(text);
        for (const entry of activeEntries().filter((item) => item.kind === "prohibition" && targetsOverlap(item.target || item.text, target || text))) {
          revoke(entry, entryId, text);
        }
        ledger.push({ id: entryId, ...metadata, target, kind: "allowance", active: true });
        continue;
      }
      if (revocationClause(text)) {
        const quoted = quotedSegments(text);
        const candidates = activeEntries();
        let matched = quoted.length
          ? candidates.filter((entry) => quoted.some((segment) => targetsOverlap(entry.target || entry.text, segment) || entry.text.includes(segment)))
          : candidates.filter((entry) => targetsOverlap(entry.target || entry.text, text));
        if (!matched.length && /上一条|此前|之前|前面/u.test(text)) matched = candidates.slice(-1);
        for (const entry of matched) revoke(entry, entryId, text);
        ledger.push({ id: entryId, ...metadata, target: quoted[0] || directiveTarget(text), kind: "revocation", active: false, revokedEntryIds: matched.map((entry) => entry.id) });
        continue;
      }
      const kind = prohibitionClause(text) ? "prohibition"
        : requirementClause(text) ? "requirement"
          : clarificationClause(text) ? "clarification" : "";
      if (!kind) continue;
      const entry = {
        id: entryId,
        ...metadata,
        target: directiveTarget(text),
        kind,
        active: true,
      };
      if (kind === "requirement" || kind === "prohibition") {
        const opposite = kind === "requirement" ? "prohibition" : "requirement";
        for (const previous of activeEntries().filter((item) => item.kind === opposite && targetsOverlap(item.target || item.text, entry.target || entry.text))) {
          revoke(previous, entryId, text);
        }
      }
      ledger.push(entry);
    }
  }
  return ledger;
};

export const mergeConversationConstraintIndex = (extracted = [], existing = []) => {
  const prior = new Map((Array.isArray(existing) ? existing : []).map((entry) => [String(entry?.id || ""), entry]));
  return (Array.isArray(extracted) ? extracted : []).map((entry) => {
    const saved = prior.get(String(entry?.id || ""));
    if (!saved || !["confirmed", "canon_binding"].includes(saved.level)) return { ...entry };
    return {
      ...entry,
      level: saved.level,
      requestedLevel: saved.requestedLevel || saved.level,
      confirmation: "confirmed",
      binding: true,
      confirmedByMessageId: String(saved.confirmedByMessageId || ""),
      ...(saved.level === "canon_binding" ? {
        canonDocumentId: String(saved.canonDocumentId || ""),
        canonRevision: String(saved.canonRevision || ""),
      } : {}),
    };
  });
};

export const constraintAppliesToScope = (entry = {}, { sourceMessageId = "", currentMessageId = "", scope = "conversation" } = {}) => {
  if (entry.active === false) return false;
  const entryScope = String(entry.scope || "conversation");
  if (entryScope === "turn") return String(sourceMessageId || entry.sourceMessageId) === String(currentMessageId || "");
  if (["paragraph", "chapter", "draft"].includes(entryScope)) return entryScope === String(scope || "conversation");
  return true;
};

export const confirmConversationConstraint = (index = [], constraintId = "", { confirmedByMessageId = "" } = {}) => (
  (Array.isArray(index) ? index : []).map((entry) => entry.id === constraintId && entry.active !== false
    ? {
      ...entry,
      level: "confirmed",
      requestedLevel: "confirmed",
      confirmation: "confirmed",
      binding: true,
      confirmedByMessageId: String(confirmedByMessageId || ""),
    }
    : { ...entry })
);

export const bindConversationConstraintToCanon = (index = [], constraintId = "", {
  committed = false,
  documentId = "",
  revision = "",
} = {}) => {
  if (committed !== true || !String(documentId).trim() || !String(revision).trim()) return (Array.isArray(index) ? index : []).map((entry) => ({ ...entry }));
  return (Array.isArray(index) ? index : []).map((entry) => entry.id === constraintId && entry.level === "confirmed" && entry.active !== false
    ? {
      ...entry,
      level: "canon_binding",
      requestedLevel: "canon_binding",
      confirmation: "confirmed",
      binding: true,
      canonDocumentId: String(documentId),
      canonRevision: String(revision),
    }
    : { ...entry });
};

export const buildConversationCapsule = (messages = [], { recentLimit = 12, maxChars = 6000, constraintIndex = [], checkpoint = null, checkpointMessages = messages } = {}) => {
  const active = messages.filter((message) => !message.pending
    && ["user", "assistant"].includes(message.role)
    && activeCandidateBranchMessage(message));
  const older = active.slice(0, Math.max(0, active.length - recentLimit));
  const checkpointValidation = validateConversationCompressionCheckpoint(checkpoint, checkpointMessages);
  const taskStateLedger = checkpointValidation.valid ? checkpoint.ledger : null;
  const sourceMessageIds = older.map((message, index) => String(message.id || `message-${index + 1}`));
  const unresolvedQuestions = taskStateLedger
    ? (taskStateLedger.unresolvedQuestions ?? []).map((entry) => entry.text)
    : [];
  if (!taskStateLedger) {
    for (const message of older) {
      if (isCandidate(message)) continue;
      const text = messageText(message);
      if (!text) continue;
      if (message.role === "assistant") unresolvedQuestions.push(...matchingSentences(text, /[？?]$/));
    }
  }
  const constraintLedger = taskStateLedger && Array.isArray(constraintIndex) && constraintIndex.length
    ? constraintIndex.map((entry) => ({ ...entry }))
    : mergeConversationConstraintIndex(extractConversationConstraintIndex(older), constraintIndex);
  const activeRequirements = constraintLedger.filter((entry) => entry.active && entry.kind === "requirement");
  const activeProhibitions = constraintLedger.filter((entry) => entry.active && entry.kind === "prohibition");
  const activeClarifications = constraintLedger.filter((entry) => entry.active && ["clarification", "allowance"].includes(entry.kind));
  const revokedEntries = constraintLedger.filter((entry) => !entry.active && ["requirement", "prohibition"].includes(entry.kind));
  const acceptedPlans = taskStateLedger?.acceptedPlans?.length
    ? taskStateLedger.acceptedPlans.slice(-4)
    : extractAcceptedConversationPlans(older, {
      limit: 4,
      perPlanLimit: Math.max(1_200, Math.floor(maxChars * 0.42)),
    });
  const normalized = {
    sourceMessageIds,
    confirmedDecisions: unique(activeRequirements.filter((entry) => entry.binding).map((entry) => entry.text)).slice(-20),
    rejectedDirections: unique(activeProhibitions.filter((entry) => entry.binding).map((entry) => entry.text)).slice(-12),
    advisoryDirections: unique([...activeRequirements, ...activeProhibitions].filter((entry) => !entry.binding).map((entry) => entry.text)).slice(-24),
    activeClarifications: unique(activeClarifications.map((entry) => entry.text)).slice(-12),
    revokedDecisions: unique(revokedEntries.map((entry) => entry.text)).slice(-12),
    unresolvedQuestions: unique(unresolvedQuestions).slice(-8),
    constraintLedger,
    constraintIndex: constraintLedger,
    acceptedPlans,
    taskStateLedger,
    checkpointValidation,
  };
  const confirmedRequirements = activeRequirements.filter((entry) => entry.binding);
  const confirmedProhibitions = activeProhibitions.filter((entry) => entry.binding);
  const advisoryEntries = [...activeRequirements, ...activeProhibitions].filter((entry) => !entry.binding);
  const pendingConfirmations = advisoryEntries.filter((entry) => entry.confirmation === "pending");
  const sections = [
    taskStateLedger ? `已校验的任务状态账本（低于本轮最新指令、当前文档和明确引用；不得把旧状态覆盖到新要求上）：\n${conversationTaskLedgerPrompt(taskStateLedger)}` : "",
    acceptedPlans.length ? `用户已经确认的较早执行方案（后续“按之前方案执行”必须优先回溯这些来源，不得用中间话题替代）：\n${acceptedPlans.map((entry) => `- 方案来源 ${entry.planMessageId}，确认来源 ${entry.acceptanceMessageId}\n${entry.text}`).join("\n")}` : "",
    confirmedRequirements.length ? `已确认的持续约束：\n- ${confirmedRequirements.slice(-20).map(sourceLabel).join("\n- ")}` : "",
    confirmedProhibitions.length ? `已确认的禁止方向：\n- ${confirmedProhibitions.slice(-12).map(sourceLabel).join("\n- ")}` : "",
    advisoryEntries.length ? `较早消息自动提取的软索引（仅作建议；不得覆盖当前消息、阻断任务或伪造成已确认规则）：\n- ${advisoryEntries.slice(-24).map(sourceLabel).join("\n- ")}` : "",
    pendingConfirmations.length ? `待用户确认的长期规则候选（确认前仍只是建议）：\n- ${pendingConfirmations.slice(-12).map(sourceLabel).join("\n- ")}` : "",
    activeClarifications.length ? `有效澄清与许可（许可不等于强制要求）：\n- ${activeClarifications.slice(-12).map(sourceLabel).join("\n- ")}` : "",
    revokedEntries.length ? `已撤销或被后续要求取代，禁止继续套用：\n- ${revokedEntries.slice(-12).map((entry) => `${sourceLabel(entry)}（由 ${entry.supersededBy} 撤销）`).join("\n- ")}` : "",
    normalized.unresolvedQuestions.length ? `仍待确认的问题：\n- ${normalized.unresolvedQuestions.join("\n- ")}` : "",
  ].filter(Boolean);
  return {
    ...normalized,
    text: clipped(sections.join("\n\n"), maxChars),
    recentLimit,
  };
};

const chineseNumber = (value = "") => {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  const [left = "", right = ""] = String(value).split("十");
  if (String(value).includes("十")) return (left ? digits[left] || 0 : 1) * 10 + (right ? digits[right] || 0 : 0);
  return digits[value] || 0;
};

const requestedCandidateIndexes = (messages, candidates) => {
  const request = messageText([...messages].reverse().find((message) => message.role === "user"));
  if (!/(?:前面|此前|之前|刚才|上一|最早|第一|第[一二两三四五六七八九十\d]+)(?:的)?(?:那)?(?:个|版|稿|候选|篇|章|段|份|次|任务|结果|文章|正文|内容)|候选稿|前稿|那篇|那一篇|那版|那一版|那章|那段/u.test(request)) return [];
  const exactIdIndex = candidates.findIndex((message) => message.id && request.includes(String(message.id)));
  if (exactIdIndex >= 0) return [exactIdIndex];
  const ordinal = request.match(/第([一二两三四五六七八九十\d]+)(?:个|版|稿|项|份)?(?:候选|版本|稿)?/u);
  if (ordinal) {
    const index = chineseNumber(ordinal[1]) - 1;
    return index >= 0 && index < candidates.length ? [index] : [];
  }
  if (/最早|第一(?:个|版|稿|份)?/u.test(request)) return candidates.length ? [0] : [];
  if (/倒数第二|上上(?:个|版|稿)/u.test(request)) return candidates.length > 1 ? [candidates.length - 2] : [];
  return candidates.length ? [candidates.length - 1] : [];
};

const RECALL_GENERIC_TERMS = new Set([
  "上面", "前面", "此前", "之前", "刚才", "历史", "早先", "一开始", "开头", "原文", "消息", "对话", "内容",
  "这个", "那个", "这些", "那些", "里面", "其中", "相关", "对应", "继续", "重新", "再次", "现在", "当前",
  "请问", "请把", "帮我", "需要", "必须", "可以", "怎么", "如何", "什么", "哪个", "是否", "进行", "使用",
  "生成", "修改", "分析", "读取", "查看", "回答", "处理", "优化", "问题", "要求", "结果", "文本", "文章",
  "任务", "话题", "指令", "完成", "解决", "恢复", "回到", "回看", "回顾", "那个任务", "那个问题", "之前任务",
]);

const recallTerms = (value = "") => {
  const normalized = String(value || "").toLocaleLowerCase("zh-CN");
  const terms = new Set();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._:-]{1,63}/giu)) terms.add(match[0]);
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,32}/gu)) {
    const run = match[0];
    if (run.length <= 12) terms.add(run);
    for (const width of [2, 3, 4]) {
      for (let index = 0; index + width <= run.length; index += 1) terms.add(run.slice(index, index + width));
    }
  }
  return [...terms].filter((term) => !RECALL_GENERIC_TERMS.has(term));
};

const conversationTaskKinds = (value = "") => {
  const text = compact(value);
  const kinds = new Set();
  const patterns = [
    ["rename", /标题|命名|改名|起名/u],
    ["continue", /续写|接着写|继续写|承接|下一段|下一章/u],
    ["rewrite", /改写|重写|替换|局部修改|全文优化/u],
    ["analyze", /分析|诊断|检查|评估|怎么看|为什么/u],
    ["generate", /生成|创作|撰写|写一/u],
    ["configure", /配置|连接|模型|运行器|Provider|API|CLI/iu],
    ["export", /导出|编译|Word|PDF|Markdown/iu],
    ["delete", /删除|清空|回收站/u],
  ];
  for (const [kind, pattern] of patterns) if (pattern.test(text)) kinds.add(kind);
  return [...kinds];
};

const conversationRecallSignals = (query = "", candidate = "") => {
  const queryTerms = new Set(recallTerms(query));
  const candidateTerms = [...new Set(recallTerms(candidate))];
  const sharedTerms = candidateTerms.filter((term) => queryTerms.has(term));
  const queryEntities = new Set(conversationSemanticEntities(query));
  const sharedEntities = conversationSemanticEntities(candidate).filter((entity) => queryEntities.has(entity));
  const queryTasks = new Set(conversationTaskKinds(query));
  const sharedTasks = conversationTaskKinds(candidate).filter((kind) => queryTasks.has(kind));
  return { sharedTerms, sharedEntities, sharedTasks };
};

const explicitHistoricalMessageIndexes = (messages = [], request = "") => {
  const indexes = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const id = String(messages[index]?.id || "");
    if (id && request.includes(id)) indexes.add(index);
  }
  const ordinal = request.match(/第([一二两三四五六七八九十\d]+)(?:轮|条(?:消息)?|次对话)/u);
  if (ordinal) {
    const requested = chineseNumber(ordinal[1]) - 1;
    if (requested >= 0 && requested < messages.length) indexes.add(requested);
  }
  if (/(?:最早|一开始|对话开头|第一轮)/u.test(request) && messages.length) indexes.add(0);
  return [...indexes];
};

export const requestsHistoricalConversationContext = (text = "") => {
  const source = String(text || "").trim();
  return Boolean(source
    && !source.includes(HISTORICAL_REFERENCE_MARKER)
    && HISTORICAL_REFERENCE_PATTERN.test(source)
    && HISTORICAL_TASK_ACTION_PATTERN.test(source));
};

const historicalTaskMessage = (message = {}) => {
  if (message.role !== "user" || isCandidate(message)) return false;
  const text = messageText(message);
  if (!text || /^(?:好|好的|好吧|谢谢|多谢|明白|收到|嗯|继续)[。！!，,\s]*$/u.test(text)) return false;
  if (String(message.requestMode || "").trim()) return true;
  return HISTORICAL_TASK_ACTION_PATTERN.test(text) || /[？?]/u.test(text);
};

const historicalTaskGroups = (messages = []) => {
  const groups = [];
  for (let index = 0; index < messages.length; index += 1) {
    const userMessage = messages[index];
    if (!historicalTaskMessage(userMessage)) continue;
    const assistantMessages = [];
    for (let cursor = index + 1; cursor < messages.length && messages[cursor]?.role !== "user"; cursor += 1) {
      const candidate = messages[cursor];
      if (candidate?.role === "assistant" && !candidate?.pending && activeCandidateBranchMessage(candidate)) assistantMessages.push(candidate);
    }
    groups.push({
      index,
      userMessage,
      assistantMessages,
      requestMode: String(userMessage.requestMode || ""),
      creative: CREATIVE_THREAD_MODES.has(String(userMessage.requestMode || ""))
        || assistantMessages.some((message) => isCandidate(message)),
    });
  }
  return groups;
};

const historicalGroupText = (group = {}) => [
  messageText(group.userMessage),
  ...(group.assistantMessages ?? []).map(messageText),
].filter(Boolean).join("\n");

export const resolveHistoricalConversationTaskReference = (messages = [], { request = "" } = {}) => {
  const active = (Array.isArray(messages) ? messages : [])
    .filter((message) => !message?.pending
      && ["user", "assistant"].includes(message?.role)
      && activeCandidateBranchMessage(message));
  const currentUserIndex = (() => {
    for (let index = active.length - 1; index >= 0; index -= 1) if (active[index]?.role === "user") return index;
    return -1;
  })();
  const sourceRequest = String(request || (currentUserIndex >= 0 ? messageText(active[currentUserIndex]) : "")).trim();
  if (currentUserIndex < 0 || !requestsHistoricalConversationContext(sourceRequest)) return null;
  const prior = active.slice(0, currentUserIndex);
  const groups = historicalTaskGroups(prior);
  if (!groups.length) return null;

  const explicitIndexes = new Set(explicitHistoricalMessageIndexes(prior, sourceRequest));
  const queryTerms = recallTerms(sourceRequest);
  const querySet = new Set(queryTerms);
  const ranked = groups.map((group, order) => {
    const groupText = historicalGroupText(group);
    const terms = [...new Set(recallTerms(groupText))];
    const shared = terms.filter((term) => querySet.has(term));
    const signals = conversationRecallSignals(sourceRequest, groupText);
    const semanticScore = shared.reduce((total, term) => total + Math.max(1, term.length - 1), 0)
      + signals.sharedEntities.length * 12
      + signals.sharedTasks.length * 8;
    const explicitlySelected = explicitIndexes.has(group.index)
      || group.assistantMessages.some((_, assistantOffset) => explicitIndexes.has(group.index + assistantOffset + 1));
    return {
      ...group,
      order,
      shared,
      sharedEntities: signals.sharedEntities,
      sharedTasks: signals.sharedTasks,
      semanticScore,
      explicitlySelected,
      score: (explicitlySelected ? 100_000 : 0)
        + semanticScore * 100
        + (group.creative ? 20 : 0)
        + order / Math.max(1, groups.length),
    };
  });
  const semanticMatches = ranked.filter((group) => group.explicitlySelected
    || group.semanticScore >= 4
    || (group.sharedEntities.length && group.sharedTasks.length));
  const pool = semanticMatches.length
    ? semanticMatches
    : ranked.some((group) => group.creative)
      ? ranked.filter((group) => group.creative)
      : ranked;
  const selected = [...pool].sort((left, right) => right.score - left.score || right.index - left.index)[0];
  if (!selected) return null;
  const selectedAssistants = (() => {
    const currentCandidate = [...selected.assistantMessages].reverse().find(isCandidate);
    return currentCandidate ? [currentCandidate] : selected.assistantMessages.slice(-1);
  })();
  const sourceMessageIds = [selected.userMessage?.id, ...selectedAssistants.map((message) => message.id)].map(String).filter(Boolean);
  const interveningMessages = Math.max(0, currentUserIndex - selected.index - 1);
  return {
    userMessage: selected.userMessage,
    assistantMessages: selectedAssistants,
    requestMode: selected.requestMode,
    creative: selected.creative,
    sourceMessageIds,
    interveningMessages,
    semanticTerms: selected.shared,
    semanticEntities: selected.sharedEntities,
    semanticTaskKinds: selected.sharedTasks,
  };
};

export const historicalConversationReferencePrompt = (reference = null, currentRequest = "") => {
  if (!reference?.userMessage) return String(currentRequest || "").trim();
  const sourceRows = [
    `【较早任务原始要求｜来源 ${reference.userMessage.id || "unknown"}】\n${messageText(reference.userMessage)}`,
    ...(reference.assistantMessages ?? []).map((message) => {
      const label = isCandidate(message) ? "较早任务候选或结果" : "较早任务答复";
      return `【${label}｜来源 ${message.id || "unknown"}】\n${messageText(message)}`;
    }),
  ];
  const sourceLabel = reference.sourceConversationId
    ? `较早对话“${reference.sourceConversationTitle || reference.sourceConversationId}”`
    : "当前分支的持久对话历史";
  const header = `${HISTORICAL_REFERENCE_MARKER}\n以下来源来自${sourceLabel}，不是新任务。必须先据此识别用户回指的任务、资料和能力，再处理本轮具体问题；不得被中间插入的其他话题覆盖。`;
  const continuityAnchors = explicitHistoricalContinuityAnchors(currentRequest);
  const anchorContract = continuityAnchors.length
    ? `【本轮不可丢失的连续性锚点】\n${continuityAnchors.map((anchor) => `- ${anchor}`).join("\n")}\n这些锚点是用户明确要求保留的硬约束。正式结果必须逐项维持并在正文中自然体现；不得只在说明里复述，也不得遗漏其中任何一项。`
    : "";
  const footer = `【本轮具体问题】\n${String(currentRequest || "").trim()}\n\n${anchorContract ? `${anchorContract}\n\n` : ""}如果较早任务依赖的明确 @ 资料已删除、为空或可信重读失败，应逐项告知真实缺口；除此之外不得用“没有上下文”“没有这个能力”或固定答复代替执行。`;
  // 不在历史锚点内部做第二次 16000 字截断。完整当前正文和本轮问题交给
  // 统一模型窗口预算处理；只有全局预算溢出时才保留首尾并生成压缩胶囊。
  return [header, ...sourceRows, footer].join("\n\n");
};

const recentVerbatimLimitForBudget = (messages = [], budget = DEFAULT_CONVERSATION_CHARACTER_BUDGET) => {
  const active = Array.isArray(messages) ? messages : [];
  if (!active.length) return 0;
  const recentBudget = Math.max(1, Math.floor(Math.max(1, Number(budget) || 1) * 0.78));
  let used = 0;
  let count = 0;
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const cost = String(active[index]?.content || "").length + 24;
    if (count > 0 && used + cost > recentBudget) break;
    used += Math.min(cost, recentBudget);
    count += 1;
    if (used >= recentBudget) break;
  }
  return Math.max(1, count);
};

export const recallHistoricalConversationMessages = (messages = [], {
  recentStart = Math.max(0, messages.length - DEFAULT_RECENT_VERBATIM_TURNS),
  limit = 6,
} = {}) => {
  const active = (Array.isArray(messages) ? messages : [])
    .filter((message) => !message?.pending
      && ["user", "assistant"].includes(message?.role)
      && activeCandidateBranchMessage(message));
  const boundedRecentStart = Math.max(0, Math.min(active.length, Number(recentStart) || 0));
  const older = active.slice(0, boundedRecentStart);
  const request = messageText([...active].reverse().find((message) => message.role === "user"));
  if (!request || !older.length || limit <= 0) return [];

  const explicitIndexes = explicitHistoricalMessageIndexes(older, request);
  const queryTerms = recallTerms(request);
  const candidateTerms = older.map((message) => isCandidate(message) ? [] : recallTerms(messageText(message)));
  const documentFrequency = new Map();
  for (const terms of candidateTerms) {
    for (const term of new Set(terms)) {
      if (queryTerms.includes(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const querySet = new Set(queryTerms);
  const ranked = older.map((message, index) => {
    if (isCandidate(message)) return null;
    const shared = [...new Set(candidateTerms[index].filter((term) => querySet.has(term)))];
    const signals = conversationRecallSignals(request, messageText(message));
    const lexicalScore = shared.reduce((total, term) => {
      const rarity = Math.log((older.length + 1) / ((documentFrequency.get(term) || 0) + 1));
      return total + Math.max(1, term.length - 1) * (1 + rarity);
    }, 0);
    const score = lexicalScore + signals.sharedEntities.length * 12 + signals.sharedTasks.length * 8;
    return { message, index, shared, score, ...signals };
  }).filter(Boolean);

  const selectedIndexes = new Set(explicitIndexes);
  for (const item of ranked
    .filter((item) => item.shared.length >= 2 || item.score >= 5 || (item.sharedEntities.length && item.sharedTasks.length))
    .sort((left, right) => right.score - left.score || right.index - left.index)) {
    if (selectedIndexes.size >= limit) break;
    selectedIndexes.add(item.index);
  }

  // When an explicitly recalled message is one half of a user/assistant pair,
  // include its adjacent counterpart if room remains. This preserves the
  // question-and-answer meaning instead of returning an isolated sentence.
  for (const index of [...selectedIndexes]) {
    if (selectedIndexes.size >= limit) break;
    const nextIndex = index + 1;
    if (nextIndex < older.length && older[nextIndex]?.role !== older[index]?.role && !isCandidate(older[nextIndex])) {
      selectedIndexes.add(nextIndex);
    }
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .slice(0, Math.max(0, limit))
    .map((index) => ({ message: older[index], index }));
};

export const conversationMessagesWithCapsule = (messages = [], {
  capsule = buildConversationCapsule(messages),
  recentLimit = capsule.recentLimit || 12,
  candidateRecallLimit = 3,
  historyRecallLimit = 6,
} = {}) => {
  const active = messages.filter((message) => !message.pending
    && ["user", "assistant"].includes(message.role)
    && activeCandidateBranchMessage(message));
  const recentStart = Math.max(0, active.length - recentLimit);
  const recent = active.slice(recentStart);
  const allCandidates = active.filter(isCandidate);
  const requestedIndexes = requestedCandidateIndexes(active, allCandidates).slice(0, candidateRecallLimit);
  const recalledCandidates = requestedIndexes
    .map((index) => ({ message: allCandidates[index], ordinal: index + 1 }))
    .filter(({ message }) => message && active.indexOf(message) < recentStart);
  const recalledHistory = recallHistoricalConversationMessages(active, {
    recentStart,
    limit: historyRecallLimit,
  });
  return [
    ...(capsule.text ? [{ role: "user", content: `【较早对话的可追溯压缩胶囊】\n${capsule.text}`, contextCapsule: true }] : []),
    ...recalledHistory.map(({ message }) => ({
      ...message,
      content: `【按需召回历史原文｜来源 ${message.id || "unknown"}】\n${message.content}`,
      recalledHistory: true,
      recalledHistorySourceId: String(message.id || ""),
    })),
    ...recalledCandidates.map(({ message, ordinal }) => ({
      ...message,
      content: `【按需召回候选｜来源 ${message.id || `candidate-${ordinal}`}｜候选序号 ${ordinal}】\n${message.content}`,
      recalledCandidate: true,
      recalledCandidateSourceId: String(message.id || `candidate-${ordinal}`),
      recalledCandidateOrdinal: ordinal,
    })),
    ...recent,
  ];
};

export const buildBudgetedConversationContext = (messages = [], { settings = {}, maxChars = 0, constraintIndex = [], checkpoint = null, checkpointMessages = messages } = {}) => {
  const normalized = normalizeConversationMessages(messages).map((message, index) => ({
    ...message,
    id: String(message.id || `message-${index + 1}`),
  }));
  const historicalReference = resolveHistoricalConversationTaskReference(normalized);
  const active = historicalReference && normalized.length
    ? normalized.map((message, index) => index === normalized.length - 1 && message.role === "user"
      ? { ...message, content: historicalConversationReferencePrompt(historicalReference, message.content) }
      : message)
    : normalized;
  const budget = Number(maxChars) > 0 ? Number(maxChars) : modelConversationCharacterBudget(settings);
  const estimatedCharacters = active.reduce((total, message) => total + message.content.length + 24, 0);
  // Short conversations stay verbatim. Once a conversation grows beyond the
  // recent working window, earlier accepted requirements move into the
  // traceable state ledger even when the provider could technically fit all
  // original turns. This prevents every review/repair stage from paying for
  // unchanged history while preserving source message ids in the capsule.
  const stateLedgerRequired = active.length > DEFAULT_RECENT_VERBATIM_TURNS;
  if (estimatedCharacters <= budget && !stateLedgerRequired) {
    return {
      schemaVersion: 3,
      messages: active.map(conversationMessageForModel),
      capsule: buildConversationCapsule(active, {
        recentLimit: active.length,
        maxChars: Math.min(MAX_CAPSULE_CHARACTERS, Math.max(2_000, Math.floor(budget * 0.08))),
        constraintIndex,
        checkpoint,
        checkpointMessages,
      }),
      budget,
      estimatedCharacters,
      compiledCharacters: estimatedCharacters,
      exceedsEstimate: false,
      budgetLimited: false,
      includedCount: active.length,
      omittedCount: 0,
      omittedSourceMessageIds: [],
      contextWindowNotice: "",
      stateLedgerApplied: false,
    };
  }
  const recentLimit = estimatedCharacters <= budget
    ? Math.min(DEFAULT_RECENT_VERBATIM_TURNS, active.length)
    : recentVerbatimLimitForBudget(active, budget);
  const capsule = buildConversationCapsule(active, {
    recentLimit,
    maxChars: Math.min(MAX_CAPSULE_CHARACTERS, Math.max(2_000, Math.floor(budget * 0.12))),
    constraintIndex,
    checkpoint,
    checkpointMessages,
  });
  const compiled = conversationMessagesWithCapsule(active, {
    capsule,
    recentLimit,
  });
  const selected = trimConversationMessagesToBudget(compiled, { maxChars: budget });
  const selectedSourceIds = new Set(selected
    .filter((message) => message.contextCapsule !== true)
    .map((message) => String(message.id || ""))
    .filter(Boolean));
  const selectedOriginalCount = active.filter((message) => selectedSourceIds.has(String(message.id || ""))).length
    || selected.filter((message) => message.contextCapsule !== true).length;
  const compiledCharacters = selected.reduce((total, message) => total + message.content.length + 24, 0);
  const omittedSourceMessageIds = active
    .filter((message) => !selectedSourceIds.has(String(message.id || "")))
    .map((message, index) => String(message.id || `message-${index + 1}`));
  const omittedCount = Math.max(0, active.length - selectedOriginalCount);
  const contextWindowNotice = omittedCount
    ? estimatedCharacters > budget
      ? `当前对话原文已超过本模型单次上下文窗口：本轮保留最近原文、已确认约束胶囊和按需召回内容，另有 ${omittedCount} 条较早消息未逐字送入模型；完整原文仍保存在本对话中。若任务必须逐字核对较早内容，请引用对应消息或文档。`
      : `较早对话已整理为可追溯任务状态账本，本轮保留最近原文和仍有效的已确认要求；${omittedCount} 条较早消息不再重复逐字发送。`
    : "";
  return {
    schemaVersion: 3,
    messages: selected.map(conversationMessageForModel),
    capsule,
    budget,
    estimatedCharacters,
    compiledCharacters,
    exceedsEstimate: estimatedCharacters > budget,
    budgetLimited: estimatedCharacters > budget && omittedCount > 0,
    stateLedgerApplied: stateLedgerRequired,
    includedCount: Math.min(active.length, selectedOriginalCount),
    omittedCount,
    omittedSourceMessageIds: omittedSourceMessageIds.slice(0, 256),
    contextWindowNotice,
  };
};
