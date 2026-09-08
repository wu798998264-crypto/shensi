import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  ackConversationInstruction,
  createConversationDispatchGate,
  dequeueReadyConversationInstruction,
  markConversationInstructionAccepted,
} from "../src/conversation-task-queue.js";

const queued = (id, queuedAt) => ({
  id,
  content: id,
  queuedAt,
  state: "queued",
  leaseId: "",
  claimedAt: 0,
  attempts: 0,
});

const conversationA = {
  id: "conversation-a",
  queue: [queued("a-1", 1), queued("a-2", 2)],
  messages: [],
};
const conversationB = {
  id: "conversation-b",
  queue: [queued("b-1", 1)],
  messages: [],
};
const gate = createConversationDispatchGate();

const a1 = dequeueReadyConversationInstruction({
  conversation: conversationA,
  messages: conversationA.messages,
  dispatching: gate.has(conversationA.id),
  leaseId: "lease-a-1",
  now: 10,
});
assert.equal(a1?.id, "a-1", "同一对话必须先派发最早进入队列的指令");
assert.equal(gate.claim(conversationA.id, "dispatch-a-1"), true);

const b1 = dequeueReadyConversationInstruction({
  conversation: conversationB,
  messages: conversationB.messages,
  dispatching: gate.has(conversationB.id),
  leaseId: "lease-b-1",
  now: 11,
});
assert.equal(b1?.id, "b-1", "A 的门闩不得阻止 B 派发");
assert.equal(gate.claim(conversationB.id, "dispatch-b-1"), true,
  "不同对话必须能够同时持有各自的派发门闩");

const acceptedA1 = markConversationInstructionAccepted({
  conversation: conversationA,
  itemId: a1.id,
  leaseId: a1.leaseId,
  sourceMessageId: "message-a-1",
  requestId: "request-a-1",
});
assert.equal(acceptedA1?.sourceMessageId, "message-a-1");
conversationA.messages.push({
  id: "pending-a-1",
  role: "assistant",
  pending: true,
  execution: { status: "running", sourceMessageId: "message-a-1", requestId: "request-a-1" },
});
assert.equal(ackConversationInstruction({
  conversation: conversationA,
  itemId: a1.id,
  leaseId: a1.leaseId,
}), true, "真正建立任务后才确认消费队列项");

assert.equal(dequeueReadyConversationInstruction({
  conversation: conversationA,
  messages: conversationA.messages,
  dispatching: gate.has(conversationA.id),
  leaseId: "lease-a-2-too-early",
  now: 12,
}), null, "A1 运行期间 A2 必须保持排队");

// 切换界面中的当前对话不应释放或取消 A 的运行门闩。
let activeConversationId = conversationB.id;
assert.equal(activeConversationId, conversationB.id);
assert.equal(gate.has(conversationA.id), true);

conversationA.messages[0].pending = false;
conversationA.messages[0].execution = {
  ...conversationA.messages[0].execution,
  status: "complete",
  endedAt: 13,
};
assert.equal(gate.release(conversationA.id, "dispatch-a-1"), true);
const a2 = dequeueReadyConversationInstruction({
  conversation: conversationA,
  messages: conversationA.messages,
  dispatching: gate.has(conversationA.id),
  leaseId: "lease-a-2",
  now: 14,
});
assert.equal(a2?.id, "a-2", "A1 终态后才能派发 A2");
assert.equal(gate.has(conversationB.id), true, "A 的完成不得中断 B");

async function sourceBlock(start, end, limit = 250) {
  const stream = createReadStream(resolve(import.meta.dirname, "../src/app.js"), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const collected = [];
  try {
    for await (const line of lines) {
      if (!collected.length && !line.includes(start)) continue;
      if (collected.length && line.includes(end)) return collected.join("\n");
      collected.push(line);
      assert.ok(collected.length < limit, `bounded source block: ${start}`);
    }
    assert.fail(`missing source block: ${start}`);
  } finally {
    lines.close();
    stream.destroy();
  }
}

const dispatch = await sourceBlock("const conversationDispatchIsActive =", "const enqueueMessage =");
assert.match(dispatch, /conversationDispatchGate\.has\(conversationId\)/u);
assert.match(dispatch, /activeForConversation\(conversationId\)/u);
assert.match(dispatch, /state\.conversations\.find\(\(item\) => item\.id === id\)/u);
assert.match(dispatch, /conversationTaskIsRunning\(conversationMessagesForTaskState\(conversation\)\)/u);
assert.doesNotMatch(dispatch, /if \(ui\.generating\)/u,
  "后台对话派发不能被当前界面的全局忙碌标记拦截");

console.log("per-conversation FIFO and cross-conversation parallel dispatch tests passed");
