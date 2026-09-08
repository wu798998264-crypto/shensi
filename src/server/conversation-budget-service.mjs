import {
  buildBudgetedConversationContext,
  modelConversationCharacterBudget,
  normalizeConversationMessages,
} from "../conversation-context.js";

// 仅用于防止异常目录数据制造无界请求；真实预算由可信模型目录决定。
// 这不是产品层的 16k/220k 截断上限。
export const SERVER_CONTEXT_CHARACTER_LIMIT = 4_000_000;

export const compileServerConversationContext = (messages = [], settings = {}, { trustedModelMetadata = false } = {}) => {
  // 客户端自报的窗口仍不可信；只有服务端从本地 Codex 模型目录重新取得
  // 的 metadata 才能参与预算计算。
  const serverBudget = Math.min(SERVER_CONTEXT_CHARACTER_LIMIT, modelConversationCharacterBudget({
    provider: String(settings?.provider || ""),
    model: String(settings?.model || ""),
    maxOutputTokens: Math.max(0, Math.min(64_000, Number(settings?.maxOutputTokens) || 0)),
    ...(trustedModelMetadata ? {
      contextWindowTokens: Math.max(0, Number(settings?.contextWindowTokens) || 0),
      effectiveContextWindowPercent: Math.max(0, Number(settings?.effectiveContextWindowPercent) || 0),
    } : {}),
  }));
  return buildBudgetedConversationContext(normalizeConversationMessages(messages), { maxChars: serverBudget });
};
