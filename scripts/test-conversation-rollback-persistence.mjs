import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { splitConversationAtMessage } from "../src/conversation-branch.js";
import {
  conversationRollbackRevision,
  filterConversationRollbackMessages,
  filterConversationRollbackQueue,
  recordConversationRollback,
} from "../src/conversation-rollback.js";
import { preserveConversationReferences, reconcileConversationSave } from "../src/conversation-save-reconciliation.js";

const messages = [
  { id: "u1", role: "user", content: "第一条", createdAt: 1 },
  { id: "a1", role: "assistant", content: "第一条回复", createdAt: 2 },
  { id: "u2", role: "user", content: "第二条", createdAt: 3 },
  { id: "a2", role: "assistant", content: "第二条回复", createdAt: 4 },
];
const split = splitConversationAtMessage(messages, "u2");
assert.deepEqual(split.activePrefix.map((message) => message.id), ["u1", "a1"]);
assert.deepEqual(split.isolatedBranch.map((message) => message.id), ["u2", "a2"]);

const conversation = {
  id: "conversation-rollback-test",
  messages: split.activePrefix,
  queue: [
    { id: "q1", sourceMessageId: "u1", queuedAt: 1 },
    { id: "q2", sourceMessageId: "u2", queuedAt: 3 },
    { id: "legacy-queue", queuedAt: 0 },
  ],
};
recordConversationRollback(conversation, {
  messageIds: split.isolatedBranch.map((message) => message.id),
  queueIds: ["q2", "legacy-queue"],
});
assert.equal(conversationRollbackRevision(conversation), 1);
assert.deepEqual(filterConversationRollbackMessages(messages, conversation).map((message) => message.id), ["u1", "a1"]);
assert.deepEqual(filterConversationRollbackQueue(conversation.queue, conversation).map((item) => item.id), ["q1"]);

const baselineConversation = { id: conversation.id, rollbackRevision: 0, messages, queue: [{ id: "q2" }] };
const currentConversation = { ...conversation };
const persistedConversation = { ...baselineConversation };
const rebased = reconcileConversationSave({
  current: {
    conversations: [currentConversation],
    activeConversationId: conversation.id,
    messages: currentConversation.messages,
  },
  submitted: {
    conversations: [baselineConversation],
    activeConversationId: conversation.id,
    messages,
  },
  persisted: {
    conversations: [persistedConversation],
    activeConversationId: conversation.id,
    messages,
  },
});
assert.equal(rebased.ok, true);
assert.deepEqual(rebased.state.conversations[0].messages.map((message) => message.id), ["u1", "a1"], "旧保存冲突不得复活已退回消息");

const liveState = {
  activeConversationId: conversation.id,
  messages: conversation.messages,
  conversations: [conversation],
};
const staleIncoming = {
  activeConversationId: conversation.id,
  messages,
  conversations: [{ id: conversation.id, rollbackRevision: 0, messages, queue: [{ id: "q2" }] }],
};
const preserved = preserveConversationReferences(liveState, staleIncoming);
assert.deepEqual(preserved.conversations[0].messages.map((message) => message.id), ["u1", "a1"], "旧保存回读不得覆盖当前回退引用");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const rollback = app.slice(app.indexOf("const rollbackToMessage = async"), app.indexOf("const verifiedDocumentRefreshQueues ="));
assert.match(rollback, /recordConversationRollback\(conversation,\s*\{/u);
assert.match(rollback, /persistWorkspaceStateOnly\(\{ saveDelay: 0 \}\)/u);
assert.match(rollback, /await flushWorkspaceSave\(\{ throwOnError: true, recoverConflict: true \}\)/u);
assert.match(app, /const rollbackReference = runtimeRollbackRevision >= loadedRollbackRevision/u, "后台完成写入必须读取最新回退纪元");

console.log("conversation rollback persistence and stale-task resurrection tests passed");
