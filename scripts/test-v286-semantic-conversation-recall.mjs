import assert from "node:assert/strict";

import {
  recallHistoricalConversationMessages,
  resolveHistoricalConversationTaskReference,
} from "../src/conversation-context.js";

const messages = [
  { id: "u1", role: "user", content: "为第八章起一个标题，重点是渠底回声。" },
  { id: "a1", role: "assistant", content: "建议标题：雨渠回声。" },
  { id: "u2", role: "user", content: "分析牧尘和唐芊儿的关系变化。" },
  { id: "a2", role: "assistant", content: "两人的互信有所增强。" },
  { id: "u3", role: "user", content: "继续第八章的命名工作。" },
];

const recalled = recallHistoricalConversationMessages(messages, { recentStart: 4, limit: 2 });
assert.deepEqual(recalled.map((item) => item.message.id), ["u1", "a1"], "实体＋任务相似度应召回对应原文问答，而不是最近的不相关历史");

const explicit = resolveHistoricalConversationTaskReference([
  ...messages.slice(0, 4),
  { id: "u4", role: "user", content: "继续之前第 u1 条消息里的任务。" },
]);
assert.equal(explicit?.userMessage?.id, "u1", "明确回指来源消息时必须优先于相似度排序");

console.log("Semantic conversation recall tests passed");
