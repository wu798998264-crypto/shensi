const text = (value = "") => String(value ?? "").replace(/\r\n?/gu, "\n").trim();

const UPSTREAM_REFERENCE_PATTERN = /(?:以上|上面|上述|前面|前述|刚才|上一条|上一则|上一次|上一轮|你(?:刚才|上面|上一条|上一则|上一轮)?(?:的)?(?:回复|回答|输出|内容)|AI(?:刚才|上面|上一条)?(?:的)?(?:回复|回答|输出|内容))/u;
const WHOLE_REPLY_PATTERN = /(?:全部|完整|整条|整份|整篇|全文|原样).{0,8}(?:内容|回复|回答|输出)|(?:以上|上一条|上一则|刚才|上面|上述|前面|前述)(?:的)?(?:全部|完整|整条|整份|整篇|全文|原样)(?:回复|回答|输出|内容)/u;

const chineseDigit = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

const ordinalNumber = (value = "") => {
  const token = text(value);
  if (/^\d+$/u.test(token)) return Number(token);
  if (token === "十") return 10;
  if (token.startsWith("十")) return 10 + (chineseDigit[token[1]] ?? 0);
  if (token.endsWith("十")) return (chineseDigit[token[0]] ?? 0) * 10;
  const compound = token.match(/^([一二两三四五六七八九])十([一二三四五六七八九])$/u);
  if (compound) return chineseDigit[compound[1]] * 10 + chineseDigit[compound[2]];
  return token.length === 1 ? chineseDigit[token] ?? 0 : 0;
};

export const conversationFormalContentBlocks = (value = "") => {
  const source = text(value);
  if (!source) return [];
  const paragraphs = source.split(/\n[\t ]*\n+/u).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  const lines = source.split("\n").map((part) => part.trim()).filter(Boolean);
  return lines.length > 1 ? lines : [source];
};

const visibleAssistantContent = (message = null) => text(message?.content || message?.candidate || "");

const referenceMessages = (messages = []) => (Array.isArray(messages) ? messages : []).filter((message) => (
  message?.role === "assistant"
  && message?.pending !== true
  && message?.conversationChoiceQuestion !== true
  && visibleAssistantContent(message)
));

const latestReferenceMessage = (messages = []) => referenceMessages(messages).at(-1) || null;

const quotedAnchors = (instruction = "") => {
  const source = text(instruction);
  const anchors = [];
  for (const match of source.matchAll(/[「『“"]([^」』”"\n]{4,160})[」』”"]/gu)) {
    const prefix = source.slice(Math.max(0, Number(match.index) - 12), Number(match.index));
    if (/(?:写入|写进|保存|存入|落盘)(?:到|进|至)?(?:当前|目标|对应)?$/u.test(prefix)) continue;
    anchors.push(match[1].trim());
  }
  return anchors;
};

const optionLabel = (content = "", index = 0) => {
  const excerpt = text(content).replace(/\s+/gu, " ");
  return `第 ${index + 1} 段 · ${excerpt.slice(0, 34)}${excerpt.length > 34 ? "…" : ""}`;
};

const messageReferenceLabel = (message = null, { latest = false } = {}) => {
  if (latest) return "上一条";
  const time = text(message?.time || message?.createdAt || message?.timestamp || "");
  return time ? `较早回复 ${time}` : "较早回复";
};

const referenceChoiceOptions = (content = "", blocks = [], { message = null, latest = true, includeWhole = true } = {}) => {
  const whole = text(content);
  const parts = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!whole) return [];
  const prefix = messageReferenceLabel(message, { latest });
  if (parts.length <= 1) return [{ id: `whole-reply-${message?.id || "latest"}`, label: `${prefix}完整回复`, content: whole, blockIndex: null, sourceMessageId: message?.id || "" }];
  return [
    ...(includeWhole ? [{ id: `whole-reply-${message?.id || "latest"}`, label: `${prefix}完整回复`, content: whole, blockIndex: null, sourceMessageId: message?.id || "" }] : []),
    ...parts.slice(0, includeWhole ? 7 : 8).map((block, index) => ({
      id: `paragraph-${message?.id || "latest"}-${index + 1}`,
      label: latest ? optionLabel(block, index) : `${prefix} · ${optionLabel(block, index)}`,
      content: block,
      blockIndex: index,
      sourceMessageId: message?.id || "",
    })),
  ];
};

const messageOrdinalSelection = (instruction = "", messages = []) => {
  const source = text(instruction);
  const records = referenceMessages(messages);
  const match = source.match(/(倒数)?第\s*([零〇一二两三四五六七八九十百\d]+)\s*条(?:\s*(?:AI|神思|助手))?\s*回复/u);
  if (!match) return null;
  const ordinal = ordinalNumber(match[2]);
  if (!ordinal) return { requested: true, message: null, availableCount: records.length };
  return {
    requested: true,
    message: match[1] ? records.at(-ordinal) || null : records[ordinal - 1] || null,
    availableCount: records.length,
  };
};

const anchorMatchesAcrossMessages = (anchors = [], messages = []) => {
  if (!anchors.length) return [];
  const records = referenceMessages(messages);
  const matches = [];
  records.forEach((message, messageIndex) => {
    conversationFormalContentBlocks(visibleAssistantContent(message)).forEach((block, blockIndex) => {
      if (anchors.some((anchor) => block.includes(anchor))) matches.push({ message, messageIndex, block, blockIndex });
    });
  });
  return matches;
};

export const explicitConversationWriteOperation = (instruction = "") => {
  const source = text(instruction);
  if (/(?:追加|续写)(?:到|进|至)?(?:当前|目标|对应|该|这个)?文档|(?:追加|续写|接在|写在|放在|插入到).{0,10}(?:末尾|结尾|后面|之后)|(?:末尾|结尾|后面|之后).{0,10}(?:追加|写入|插入|补入)/u.test(source)) return "append";
  if (/(?:落盘|写入|写进|保存|存入).{0,18}(?:文档)?(?:末尾|结尾)/u.test(source)) return "append";
  if (/(?:覆盖|替换|取代|改成|作为).{0,10}(?:当前|原有|整篇|全文|正文|文档)|(?:全文|整篇|整个文档).{0,10}(?:覆盖|替换|写入)/u.test(source)) return "replace";
  return "";
};

export const resolveConversationFormalContentReference = ({ instruction = "", messages = [] } = {}) => {
  const source = text(instruction);
  const ordinalMatch = source.match(/第\s*([零〇一二两三四五六七八九十百\d]+)\s*(?:个)?(?:自然)?段/u);
  const messageSelection = messageOrdinalSelection(source, messages);
  const refersUpstream = UPSTREAM_REFERENCE_PATTERN.test(source) || Boolean(ordinalMatch) || messageSelection?.requested === true;
  if (!refersUpstream) return { status: "not_requested" };
  const sourceMessage = messageSelection?.requested ? messageSelection.message : latestReferenceMessage(messages);
  if (messageSelection?.requested && !sourceMessage) {
    const records = referenceMessages(messages);
    const fallback = records.at(-1) || null;
    return {
      status: records.length ? "ambiguous" : "missing",
      reason: "message_out_of_range",
      sourceMessageId: fallback?.id || "",
      availableCount: records.length,
      options: fallback
        ? records.slice(-8).reverse().flatMap((message, index) => referenceChoiceOptions(
          visibleAssistantContent(message),
          conversationFormalContentBlocks(visibleAssistantContent(message)),
          { message, latest: message.id === fallback.id, includeWhole: true },
        ).slice(0, 1).map((option) => ({ ...option, id: `message-fallback-${message.id}-${index}` })))
        : [],
      operation: explicitConversationWriteOperation(source),
    };
  }
  if (!sourceMessage) return { status: "missing", reason: "no_assistant_content" };
  const content = visibleAssistantContent(sourceMessage);
  const blocks = conversationFormalContentBlocks(content);
  if (!blocks.length) return { status: "missing", reason: "assistant_content_empty" };

  const requestedOrdinal = ordinalNumber(ordinalMatch?.[1]);
  if (requestedOrdinal) {
    const selected = blocks[requestedOrdinal - 1];
    return selected
      ? { status: "resolved", content: selected, sourceMessageId: sourceMessage.id, blockIndex: requestedOrdinal - 1, operation: explicitConversationWriteOperation(source) }
      : {
          status: "ambiguous",
          reason: "paragraph_out_of_range",
          sourceMessageId: sourceMessage.id,
          availableCount: blocks.length,
          operation: explicitConversationWriteOperation(source),
          options: referenceChoiceOptions(content, blocks, { message: sourceMessage, latest: sourceMessage === latestReferenceMessage(messages) }),
        };
  }
  if (/最后(?:一)?(?:个)?(?:自然)?段/u.test(source)) {
    return { status: "resolved", content: blocks.at(-1), sourceMessageId: sourceMessage.id, blockIndex: blocks.length - 1, operation: explicitConversationWriteOperation(source) };
  }
  const anchors = quotedAnchors(source);
  if (anchors.length && !messageSelection?.requested) {
    const historicalMatches = anchorMatchesAcrossMessages(anchors, messages);
    if (historicalMatches.length === 1) {
      const match = historicalMatches[0];
      return {
        status: "resolved",
        content: match.block,
        sourceMessageId: match.message.id,
        blockIndex: match.blockIndex,
        operation: explicitConversationWriteOperation(source),
      };
    }
    if (historicalMatches.length > 1) {
      const latest = latestReferenceMessage(messages);
      return {
        status: "ambiguous",
        reason: "anchor_not_unique",
        sourceMessageId: latest?.id || historicalMatches.at(-1)?.message?.id || "",
        operation: explicitConversationWriteOperation(source),
        options: historicalMatches.slice(-8).reverse().map((match, index) => ({
          id: `historical-anchor-${match.message.id}-${match.blockIndex}-${index}`,
          label: `${messageReferenceLabel(match.message, { latest: match.message.id === latest?.id })} · ${optionLabel(match.block, match.blockIndex)}`,
          content: match.block,
          blockIndex: match.blockIndex,
          sourceMessageId: match.message.id,
        })),
      };
    }
  }
  for (const anchor of anchors) {
    const matches = blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.includes(anchor));
    if (matches.length === 1) {
      return { status: "resolved", content: matches[0].block, sourceMessageId: sourceMessage.id, blockIndex: matches[0].index, operation: explicitConversationWriteOperation(source) };
    }
  }
  if (WHOLE_REPLY_PATTERN.test(source) || (messageSelection?.requested && /(?:全部|完整|整条|整份|整篇|全文|原样).{0,6}(?:回复|回答|输出|内容)/u.test(source))) {
    return { status: "resolved", content, sourceMessageId: sourceMessage.id, blockIndex: null, operation: explicitConversationWriteOperation(source) };
  }
  return {
    status: "ambiguous",
    reason: anchors.length ? "anchor_not_unique" : "reference_scope_unclear",
    sourceMessageId: sourceMessage.id,
    operation: explicitConversationWriteOperation(source),
    options: referenceChoiceOptions(content, blocks, { message: sourceMessage, latest: sourceMessage === latestReferenceMessage(messages) }),
  };
};
