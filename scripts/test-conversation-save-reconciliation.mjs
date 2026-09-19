import assert from "node:assert/strict";
import { preserveConversationReferences, reconcileConversationSave, reconcileConversationSaveAfterConflict, reconcileWorkspaceSave } from "../src/conversation-save-reconciliation.js";
import { markAgentResultProjection, upsertAgentResultReference } from "../src/conversation-agent-document-projection.js";
import { ackConversationInstruction, markConversationInstructionAccepted, recoverConversationTaskQueueForStartup } from "../src/conversation-task-queue.js";
import { readComposerDraftCacheEntry, readComposerDraftCacheState, writeComposerDraftCacheEntry } from "../src/composer-draft-cache.js";
import { rebaseWorkspaceConflict, workspaceDocumentHashes, workspaceStateHashes } from "../src/workspace-conflict.js";

const submitted = {
  activeConversationId: "conversation-1",
  messages: [{ id: "user-a", role: "user", content: "第一条" }],
  conversations: [{ id: "conversation-1", messages: [{ id: "user-a", role: "user", content: "第一条" }], queue: [] }],
  documents: { "chapter-1": { html: "旧正文" } },
};
const current = structuredClone(submitted);
current.messages.push({ id: "user-b", role: "user", content: "第二条" });
current.conversations[0].messages = current.messages;
current.conversations[0].queue.push({ id: "queue-c", state: "queued", content: "第三条" });
const persisted = structuredClone(submitted);
persisted.documents["chapter-1"].html = "远端正文";
const merged = reconcileWorkspaceSave({ current, submitted, persisted });
assert.equal(merged.ok, true);
assert.deepEqual(merged.state.documents, persisted.documents);
assert.deepEqual(merged.state.messages.map((message) => message.id), ["user-a", "user-b"]);
assert.deepEqual(merged.state.conversations[0].queue.map((item) => item.id), ["queue-c"]);
const inFlightBase = {
  activeConversationId: "conversation-1",
  conversations: [{
    id: "conversation-1",
    updatedAt: "今天 10:00",
    messages: [{ id: "user-a", role: "user", content: "A", pending: true }],
    queue: [{ id: "queue-a", state: "dispatching", leaseId: "lease-a", sourceMessageId: "user-a" }],
    snapshots: {},
    isolatedBranches: [],
  }],
};
const inFlightCurrent = structuredClone(inFlightBase);
inFlightCurrent.conversations[0].updatedAt = "今天 10:02";
inFlightCurrent.conversations[0].messages.push({ id: "user-b", role: "user", content: "B" });
inFlightCurrent.conversations[0].queue.push({ id: "queue-b", state: "queued", sourceMessageId: "user-b" });
const inFlightPersisted = structuredClone(inFlightBase);
inFlightPersisted.conversations[0].updatedAt = "今天 10:01";
inFlightPersisted.conversations[0].messages[0].pending = false;
inFlightPersisted.conversations[0].messages.push({ id: "assistant-a", role: "assistant", content: "A 的回复" });
inFlightPersisted.conversations[0].queue = [];
const inFlightMerge = reconcileConversationSave({
  current: inFlightCurrent,
  submitted: inFlightBase,
  persisted: inFlightPersisted,
});
assert.equal(inFlightMerge.ok, true);
assert.deepEqual(inFlightMerge.state.conversations[0].messages.map((message) => message.id), ["user-a", "user-b", "assistant-a"]);
assert.equal(inFlightMerge.state.conversations[0].messages[0].pending, false);
assert.deepEqual(inFlightMerge.state.conversations[0].queue.map((item) => item.id), ["queue-b"]);

const externalWriteBaseline = {
  activeConversationId: "conversation-write",
  conversations: [{
    id: "conversation-write",
    messages: [{ id: "user-write", content: "写入文档" }, { id: "agent-write", pending: true, execution: { result: "正在生成" } }],
    queue: [],
  }],
};
const externalWriteSubmitted = structuredClone(externalWriteBaseline);
externalWriteSubmitted.conversations[0].messages[1].execution.result = "文档已写入并更新目录";
const externalWriteCurrent = structuredClone(externalWriteSubmitted);
externalWriteCurrent.conversations[0].messages[1].pending = false;
externalWriteCurrent.conversations[0].messages[1].execution.result = "任务完成";
const externalWritePersisted = structuredClone(externalWriteBaseline);
externalWritePersisted.documents = { "new-document": { title: "新文档", markdown: "正文" } };
const externalWriteMerge = reconcileConversationSaveAfterConflict({
  baseline: externalWriteBaseline,
  submitted: externalWriteSubmitted,
  current: externalWriteCurrent,
  persisted: externalWritePersisted,
});
assert.equal(externalWriteMerge.ok, true, "Agent 文档事务写入后不得把旧对话快照误判为冲突");
assert.equal(externalWriteMerge.state.conversations[0].messages[1].pending, false);
assert.equal(externalWriteMerge.state.conversations[0].messages[1].execution.result, "任务完成");
assert.equal(externalWriteMerge.state.documents["new-document"].markdown, "正文");

const projectedMessage = { execution: { agentResultReferences: [] } };
const staleReference = upsertAgentResultReference(projectedMessage, {
  sequence: 35,
  type: "document_saved",
  documentId: "new-document",
});
projectedMessage.execution = {
  agentResultReferences: [{ sequence: 35, type: "document_saved", documentId: "new-document" }],
};
markAgentResultProjection(projectedMessage, { reference: staleReference, verified: true });
assert.equal(projectedMessage.execution.agentResultReferences[0].clientProjectionVerified, true,
  "保存重基线替换 execution 对象后，可信目录同步标记必须写回当前消息而不是失效旧引用");

const parallelBase = {
  activeConversationId: "conversation-a",
  conversations: [
    { id: "conversation-a", title: "A", messages: [{ id: "a-1", content: "A1" }], queue: [] },
    { id: "conversation-b", title: "B", messages: [{ id: "b-1", content: "B1" }], queue: [] },
  ],
};
const parallelCurrent = structuredClone(parallelBase);
parallelCurrent.conversations[0].messages.push({ id: "a-2", content: "A2" });
const parallelPersisted = structuredClone(parallelBase);
parallelPersisted.activeConversationId = "conversation-b";
parallelPersisted.conversations[1].messages.push({ id: "b-2", content: "B2" });
const parallelMerge = reconcileConversationSave({ current: parallelCurrent, submitted: parallelBase, persisted: parallelPersisted });
assert.equal(parallelMerge.ok, true);
assert.deepEqual(parallelMerge.state.conversations.find((item) => item.id === "conversation-a").messages.map((item) => item.id), ["a-1", "a-2"]);
assert.deepEqual(parallelMerge.state.conversations.find((item) => item.id === "conversation-b").messages.map((item) => item.id), ["b-1", "b-2"]);

const conflict = reconcileConversationSave({
  current: { messages: [{ id: "same", content: "本地版本" }] },
  submitted: { messages: [{ id: "same", content: "原始版本" }] },
  persisted: { messages: [{ id: "same", content: "远端版本" }] },
});
assert.equal(conflict.ok, false);

const liveConversation = { id: "conversation-1", messages: [{ id: "a" }], snapshots: {}, queue: [] };
const newlyCreatedConversation = { id: "conversation-2", messages: [{ id: "b" }], snapshots: {}, queue: [] };
const preserved = preserveConversationReferences(
  { activeConversationId: "conversation-2", conversations: [liveConversation, newlyCreatedConversation] },
  { activeConversationId: "conversation-1", conversations: [{ id: "conversation-1", messages: [{ id: "a" }], snapshots: {}, queue: [] }] },
);
assert.deepEqual(preserved.conversations.map((item) => item.id), ["conversation-1", "conversation-2"]);
assert.equal(preserved.activeConversationId, "conversation-2");

const baselineWorkspace = { conversations: parallelBase.conversations, messages: parallelBase.conversations[0].messages, documents: { doc: { html: "base" } } };
const localWorkspace = structuredClone(baselineWorkspace);
localWorkspace.conversations[0].messages.push({ id: "a-2", content: "A2" });
const remoteWorkspace = structuredClone(baselineWorkspace);
remoteWorkspace.conversations[1].messages.push({ id: "b-2", content: "B2" });
remoteWorkspace.documents.doc.html = "remote";
const resolvedConversations = reconcileConversationSave({ current: localWorkspace, submitted: baselineWorkspace, persisted: remoteWorkspace });
const rebased = rebaseWorkspaceConflict({
  baselineDocumentHashes: workspaceDocumentHashes(baselineWorkspace.documents),
  baselineStateHashes: workspaceStateHashes(baselineWorkspace),
  localState: localWorkspace,
  remoteState: remoteWorkspace,
  stateConflictResolutions: { conversations: resolvedConversations.state.conversations },
});
assert.equal(rebased.ok, true);
assert.equal(rebased.state.documents.doc.html, "remote");
assert.deepEqual(rebased.state.conversations.flatMap((item) => item.messages.map((message) => message.id)), ["a-1", "a-2", "b-1", "b-2"]);

const queued = { id: "q-1", state: "dispatching", leaseId: "lease-1", claimedAt: Date.now(), sourceMessageId: "task-a" };
const conversation = { id: "c", queue: [queued] };
const startup = recoverConversationTaskQueueForStartup(conversation, { runningTaskIds: ["task-a"], now: Date.now() + 1 });
assert.deepEqual(startup.retainedIds, ["q-1"]);
assert.equal(conversation.queue.length, 1);
assert.equal(ackConversationInstruction({ conversation, itemId: "q-1", leaseId: "wrong" }), false);
assert.equal(conversation.queue.length, 1);
const expired = recoverConversationTaskQueueForStartup(conversation, { runningTaskIds: [], now: Date.now() + 180_000 });
assert.deepEqual(expired.recoveredIds, ["q-1"]);
assert.equal(conversation.queue[0].state, "queued");

const ownedQueue = { id: "q-owned", state: "dispatching", leaseId: "lease-owned", claimedAt: Date.now() };
const unrelatedQueue = { id: "q-unrelated", state: "dispatching", leaseId: "lease-unrelated", claimedAt: Date.now() };
const ownedConversation = { id: "conversation-owned", queue: [ownedQueue, unrelatedQueue] };
assert.ok(markConversationInstructionAccepted({
  conversation: ownedConversation,
  itemId: ownedQueue.id,
  leaseId: ownedQueue.leaseId,
  sourceMessageId: "source-owned",
  requestId: "request-owned",
}));
const ownedStartup = recoverConversationTaskQueueForStartup(ownedConversation, {
  runningTasks: [{
    conversationId: "conversation-owned",
    sourceMessageId: "source-owned",
    requestId: "request-owned",
    queueItemId: "q-owned",
    leaseId: "lease-owned",
  }],
  now: Date.now() + 1,
});
assert.deepEqual(ownedStartup.retainedIds, ["q-owned"]);
assert.deepEqual(ownedStartup.recoveredIds, ["q-unrelated"], "启动恢复必须立即重排未被运行任务逐条认领的 lease");
assert.equal(ownedConversation.queue.find((item) => item.id === "q-unrelated").state, "queued");

const wrongLeaseConversation = { id: "conversation-owned", queue: [{ ...ownedQueue, sourceMessageId: "source-owned", requestId: "request-owned" }] };
const wrongLease = recoverConversationTaskQueueForStartup(wrongLeaseConversation, {
  runningTasks: [{ conversationId: "conversation-owned", sourceMessageId: "source-owned", requestId: "request-owned", queueItemId: "q-owned", leaseId: "different-lease" }],
});
assert.deepEqual(wrongLease.recoveredIds, ["q-owned"], "任务标识相同但 lease 不同也不得冒领队列项");

// Missing optional identifiers must not stringify to the same "undefined"
// token and accidentally make an unrelated dispatch look owned.
const unidentifiableQueue = { id: "q-unidentifiable", state: "dispatching", leaseId: "lease-unidentifiable", claimedAt: Date.now() };
const unidentifiableConversation = { id: "conversation-unidentifiable", queue: [unidentifiableQueue] };
const unidentifiableRecovery = recoverConversationTaskQueueForStartup(unidentifiableConversation, {
  runningTasks: [{ conversationId: "conversation-unidentifiable" }],
  now: Date.now() + 1,
});
assert.deepEqual(unidentifiableRecovery.recoveredIds, ["q-unidentifiable"], "缺少任务标识的排队项不得被任意运行任务冒领");

// The queue item/lease pair is sufficient ownership proof for a pending task
// written by an older client that did not persist source/request identifiers.
const queueOnlyOwnership = { id: "q-legacy", state: "dispatching", leaseId: "lease-legacy", claimedAt: Date.now() };
const queueOnlyConversation = { id: "conversation-legacy", queue: [queueOnlyOwnership] };
const queueOnlyRecovery = recoverConversationTaskQueueForStartup(queueOnlyConversation, {
  runningTasks: [{ conversationId: "conversation-legacy", queueItemId: "q-legacy", leaseId: "lease-legacy" }],
  now: Date.now() + 1,
});
assert.deepEqual(queueOnlyRecovery.retainedIds, ["q-legacy"], "明确匹配 queueItemId 与 lease 的任务必须保留排队项");

const values = new Map();
const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
const draftId = "workspace::conversation-1";
values.set("shensi-composer-drafts-v1", JSON.stringify({ [draftId]: "旧草稿" }));
writeComposerDraftCacheEntry(storage, draftId, "");
assert.equal(readComposerDraftCacheEntry(storage, draftId), "");
assert.equal(readComposerDraftCacheState(storage, draftId).cleared, true);
assert.equal(values.has("shensi-composer-drafts-v1"), false, "清空新版草稿时必须同时删除最后一条旧版缓存");
writeComposerDraftCacheEntry(storage, draftId, "新草稿");
assert.equal(readComposerDraftCacheEntry(storage, draftId), "新草稿");
writeComposerDraftCacheEntry(storage, draftId, "");
assert.equal(readComposerDraftCacheEntry(storage, draftId), "");

const failedValues = new Map([["shensi-composer-drafts-v1", JSON.stringify({ [draftId]: "不能复活的旧草稿" })]]);
const failedManifestStorage = {
  getItem: (key) => failedValues.get(key) ?? null,
  setItem: (key, value) => {
    if (key === "shensi-composer-drafts-v2") throw new Error("manifest fault");
    failedValues.set(key, String(value));
  },
  removeItem: (key) => failedValues.delete(key),
};
assert.throws(() => writeComposerDraftCacheEntry(failedManifestStorage, draftId, ""), /manifest fault/u);
assert.equal(readComposerDraftCacheState(failedManifestStorage, draftId).cleared, true, "manifest 写入失败后独立墓碑仍必须压住磁盘旧草稿");

console.log("Conversation save conflict merge, startup queue ownership and composer draft tombstone tests passed");
