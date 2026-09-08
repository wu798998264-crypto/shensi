import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const readBlock = async (start, end) => {
  const stream = createReadStream(resolve(import.meta.dirname, "../src/app.js"), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const collected = [];
  try {
    for await (const line of lines) {
      if (!collected.length && !line.includes(start)) continue;
      if (collected.length && line.includes(end)) return collected.join("\n");
      collected.push(line);
      assert.ok(collected.length < 250, `Read bounded block: ${start}`);
    }
    assert.fail(`Missing block: ${start}`);
  } finally {
    lines.close();
    stream.destroy();
  }
};

const closed = [];
const drained = [];
const toasts = [];
const operation = { operationId: "stale-operation", conversationId: "conversation-a", kind: "skill_install" };
const button = () => ({ disabled: false, isConnected: true });
const env = {
  ui: { agentOperationProposal: operation },
  elements: {
    agentOperationProposalConfirm: button(),
    agentOperationProposalCancel: button(),
    agentOperationProposalPlan: button(),
  },
  fetch: async () => ({
    ok: false,
    json: async () => ({ ok: false, code: "AGENT_OPERATION_EXPIRED", message: "该操作方案已过期" }),
  }),
  closeAgentOperationProposal: (options) => closed.push(options),
  scheduleConversationQueueDrain: (conversationId) => drained.push(conversationId),
  showToast: (message) => toasts.push(message),
};

const source = await readBlock("const executeAgentOperationProposal = async", "const discardAgentOperation = async");
runInNewContext(`${source}\nglobalThis.executeAgentOperationProposal = executeAgentOperationProposal;`, env);
await env.executeAgentOperationProposal();

assert.equal(closed.length, 1, "失效提案必须从所属对话清除");
assert.equal(closed[0]?.conversationId, "conversation-a");
assert.deepEqual(drained, ["conversation-a"], "失效提案清除后必须恢复该对话队列");
assert.deepEqual(toasts, ["该确认方案已失效，请重新发送原要求后再确认"]);
assert.equal(env.elements.agentOperationProposalConfirm.disabled, false);
assert.equal(env.elements.agentOperationProposalCancel.disabled, false);
assert.equal(env.elements.agentOperationProposalPlan.disabled, false);

console.log("agent operation restart-expiry UI recovery passed");
