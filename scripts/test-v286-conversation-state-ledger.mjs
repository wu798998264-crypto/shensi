import assert from "node:assert/strict";

import {
  buildConversationCompressionCheckpoint,
  conversationTaskLedgerPrompt,
  validateConversationCompressionCheckpoint,
} from "../src/conversation-state-ledger.js";
import { buildBudgetedConversationContext } from "../src/conversation-context.js";

const messages = [
  { id: "u1", role: "user", content: "本轮目标是完成第八章。事实是牧尘左臂受伤，目前留在北灵院。" },
  { id: "a1", role: "assistant", content: "方案一保留追逐，方案二改为审讯。" },
  { id: "u2", role: "user", content: "采用方案一，不要方案二。还需要补完渠底伏笔。" },
  { id: "a2", role: "assistant", content: "已按方案一继续，渠底伏笔仍待完成。" },
];

const first = buildConversationCompressionCheckpoint(messages, { createdAt: "2026-08-23T00:00:00.000Z" });
assert.equal(first.schemaVersion, 1);
assert.deepEqual(first.sourceMessageIds, ["u1", "a1", "u2", "a2"]);
assert.equal(first.deltaSourceMessageIds.length, 4);
assert.ok(first.contentHash);
assert.match(first.ledger.currentGoal.text, /采用方案一/u);
assert.ok(first.ledger.importantFacts.some((item) => /牧尘左臂受伤/u.test(item.text)));
assert.ok(first.ledger.characterStates.some((item) => /牧尘/u.test(item.text)));
assert.ok(first.ledger.adoptedDecisions.some((item) => /方案一/u.test(item.text)));
assert.ok(first.ledger.rejectedDirections.some((item) => /方案二/u.test(item.text)));
assert.ok(first.ledger.unfinishedItems.some((item) => /渠底伏笔/u.test(item.text)));
assert.match(conversationTaskLedgerPrompt(first.ledger), /来源 u2/u);
assert.equal(validateConversationCompressionCheckpoint(first, messages).valid, true);

const appended = [...messages, { id: "u3", role: "user", content: "最新要求：改为先揭示青铜令牌，旧顺序作废。" }];
const second = buildConversationCompressionCheckpoint(appended, {
  previousCheckpoint: first,
  createdAt: "2026-08-23T00:01:00.000Z",
});
assert.deepEqual(second.deltaSourceMessageIds, ["u3"], "有效检查点之后只能增量处理新增消息");
assert.match(second.ledger.currentGoal.text, /改为先揭示青铜令牌/u);
assert.equal(validateConversationCompressionCheckpoint(second, appended).valid, true);

const deleted = appended.filter((message) => message.id !== "u2");
assert.equal(validateConversationCompressionCheckpoint(second, deleted).valid, false, "删除来源消息后旧摘要必须失效");

const switchedBranch = appended.map((message) => message.id === "a2"
  ? { ...message, candidateBranchGroupId: "branch-1", candidateBranchActive: false }
  : message);
assert.equal(validateConversationCompressionCheckpoint(second, switchedBranch).valid, false, "切换候选分支后旧摘要必须失效");

const longMessages = Array.from({ length: 16 }, (_, index) => ([
  { id: `lu${index}`, role: "user", content: `第${index + 1}轮目标：保持牧尘受伤状态，继续处理渠底线索。${"补充细节。".repeat(20)}` },
  { id: `la${index}`, role: "assistant", content: `第${index + 1}轮答复：记录当前状态。${"说明文字。".repeat(20)}` },
])).flat();
const longCheckpoint = buildConversationCompressionCheckpoint(longMessages);
const compiled = buildBudgetedConversationContext(longMessages, { maxChars: 4_000, checkpoint: longCheckpoint });
assert.equal(compiled.capsule.checkpointValidation.valid, true);
assert.match(compiled.capsule.text, /已校验的任务状态账本/u);
const changedLongMessages = longMessages.map((message) => message.id === "lu0" ? { ...message, content: `${message.content}被篡改` } : message);
const fallback = buildBudgetedConversationContext(changedLongMessages, { maxChars: 4_000, checkpoint: longCheckpoint });
assert.equal(fallback.capsule.checkpointValidation.valid, false);
assert.equal(fallback.capsule.taskStateLedger, null, "校验失败的旧摘要不得进入模型上下文");
assert.ok(fallback.messages.length, "摘要失败时必须继续使用原文与现有同步胶囊降级");

console.log("Conversation state ledger checkpoint tests passed");
