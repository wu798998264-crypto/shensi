import { formatClipboardPlainText } from "./prose-format.js";

export const splitConversationAtMessage = (messages = [], messageId) => {
  const index = messages.findIndex((message) => message.id === messageId && message.role === "user");
  if (index < 0) return null;
  return {
    index,
    draft: String(messages[index].content ?? ""),
    activePrefix: structuredClone(messages.slice(0, index)),
    isolatedBranch: structuredClone(messages.slice(index)),
  };
};

export const copyableMessageText = (message = {}) => {
  const source = String(message.candidate ?? message.content ?? message.lead ?? "");
  return source.trim() ? formatClipboardPlainText(source) : "";
};
