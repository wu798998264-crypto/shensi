import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { createConversationDispatchGate, conversationTaskIsRunning, conversationImmediateInstructionBlocksDispatch, dequeueReadyConversationInstruction } from "../src/conversation-task-queue.js";
import { AGENT_OPERATION_KINDS, extractConversationSkillText } from "../src/agent-operation-protocol.js";

async function block(start, end) {
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
    assert.fail(`Missing ${start}`);
  } finally { lines.close(); stream.destroy(); }
}

const a = { id: "A", messages: [], queue: [] };
const b = { id: "B", messages: [], queue: [] };
const state = { activeConversationId: "A", messages: a.messages, conversations: [a, b], settings: { workspacePath: "test" }, workspaceKind: "project" };
const gate = createConversationDispatchGate();
const requests = [];
const acked = [];
const painted = [];
const unifiedDispatches = [];
const ui = { conversationDispatchGate: gate, conversationPreparations: { activeForConversation: () => [] },
  immediateConversationInstructions: new Map(), agentCandidateLandingConversations: new Set(), agentOperationProposal: null };
let sequence = 0;
const env = {
  state, ui, AGENT_OPERATION_KINDS, conversationTaskIsRunning, conversationImmediateInstructionBlocksDispatch,
  extractConversationSkillText,
  conversationById: (id) => state.conversations.find((c) => c.id === id),
  activeConversation: () => state.conversations.find((c) => c.id === state.activeConversationId),
  captureTaskContextSnapshot: () => ({ workspaceKind: "project", workspacePath: "test", workspaceName: "test", activeDocumentId: "chapter-1" }),
  conversationMessagesForTaskState: (c) => c.messages,
  conversationComposerReferenceScope: () => ({ attachments: [] }),
  deletedContentRequestMentioned: () => false, isExplicitStructuralOnlyWorkspaceOperation: () => false,
  uid: () => `token-${++sequence}`, clone: structuredClone, persist: () => {}, showToast: () => {},
  removeImmediateConversationInstruction: () => {},
  sendMessage: async (content, options = {}) => {
    const conversation = state.conversations.find((item) => item.id === options.conversationId);
    unifiedDispatches.push({ content, options });
    if (conversation && !options.queuedItem && (gate.has(conversation.id) || conversation.agentOperationProposal)) {
      conversation.queue.push({ id: `unified-${++sequence}`, content, state: "queued" });
    }
    return true;
  },
  enqueueMessage: (content, options) => { const c = env.conversationById(options.conversationId); c.queue.push({ id: `q-${++sequence}`, content, state: "queued" }); },
  ackQueuedConversationItem: (c, item) => { acked.push(item.id); c.queue = c.queue.filter((q) => q.id !== item.id); },
  nackQueuedConversationItem: () => assert.fail("Unexpected queue nack"),
  persistAgentRuntimeView: () => {},
  renderMessages: () => {}, renderAgentOperationProposal: (p) => painted.push(p.conversationId),
  elements: { agentOperationProposal: { hidden: true, scrollIntoView: () => {} } },
  fetch: async (_url, options) => { const body = JSON.parse(options.body); requests.push(body); return { ok: true, json: async () => ({ ok: true, operationId: `operation-${requests.length}`, proposal: { title: body.prompt } }) }; },
};
const dispatch = await block("const conversationDispatchIsActive =", "const ackQueuedConversationItem =");
const request = await block("const requestAgentOperationProposal =", "const executeAgentOperationProposal =");
const close = await block("const closeAgentOperationProposal =", "const appendAgentOperationMessage =");
const presenter = await block("const presentAgentOperationProposalFromDecision =", "let activeAgentProfileSwitchPromise");
const sendHead = await block("const sendCodexAgentMessage =", '  let pendingId = "";');
assert.match(sendHead, /if \(!confirmedSelfRepair\)[\s\S]{0,500}return await sendMessage\(prompt/u);
assert.doesNotMatch(sendHead, /isConversationSkillInstallRequest|isSelfRepairRequest|presentAgentOperationProposal/u,
  "原生执行入口不得在统一 Agent 前识别高影响操作");
runInNewContext([dispatch, request, close, presenter, `${sendHead}\nreturn 'model-dispatch';\n};`,
  "globalThis.fns = {conversationDispatchIsActive, requestAgentOperationProposal, closeAgentOperationProposal, presentAgentOperationProposalFromDecision, sendCodexAgentMessage};"].join("\n"), env);
const { fns } = env;

assert.equal(gate.claim("A", "running-A"), true);
await fns.sendCodexAgentMessage("修复神思按钮", { conversationId: "A" });
assert.equal(requests.length, 0, "自修复不能在A忙时提出确认");
assert.equal(a.queue.length, 1);
assert.equal(unifiedDispatches.length, 1, "忙碌时也先交给统一发送入口决定排队");
await fns.sendCodexAgentMessage("分析第二个问题", { conversationId: "B" });
assert.equal(unifiedDispatches.length, 2, "普通任务误入原生入口时必须回流统一 Agent");
assert.equal(unifiedDispatches[1].content, "分析第二个问题");
gate.release("A", "running-A");
const queued = a.queue[0];
await fns.sendCodexAgentMessage(queued.content, { conversationId: "A", queuedItem: queued });
assert.equal(requests.length, 0, "轮到队列项后仍须先经过统一 Agent，而不是按文字弹提案");
await fns.presentAgentOperationProposalFromDecision({
  prompt: queued.content,
  conversation: a,
  kind: AGENT_OPERATION_KINDS.SELF_REPAIR,
  attachments: queued.attachments || [],
  workspaceState: state,
});
assert.equal(requests.length, 1);
assert.ok(a.agentOperationProposal);
env.ackQueuedConversationItem(a, queued);
assert.deepEqual(acked, [queued.id], "提案已经接收后应确认原队列项，不能到期重提");
await fns.sendCodexAgentMessage("下一项普通任务", { conversationId: "A" });
assert.equal(a.queue.length, 1, "A确认未结束，后续任务仍排队");
assert.equal(unifiedDispatches.length, 4, "确认面板期间的普通任务也必须保留统一入口语义");

state.activeConversationId = "B";
state.messages = b.messages;
const skillItem = { id: "queued-skill", attachments: [{ name: "example.md", text: "# Example\nSkill instruction" }] };
await fns.presentAgentOperationProposalFromDecision({
  prompt: "安装这个Skill",
  conversation: b,
  kind: AGENT_OPERATION_KINDS.SKILL_INSTALL,
  attachments: skillItem.attachments,
  workspaceState: state,
});
assert.ok(b.agentOperationProposal);
assert.ok(a.agentOperationProposal, "B提案不能覆盖A提案");
assert.equal(requests[1].content, skillItem.attachments[0].text, "排队提案必须使用入队附件，不用当前编辑器附件");
assert.equal(ui.agentOperationProposal.conversationId, "B");
fns.closeAgentOperationProposal({ conversationId: "A" });
assert.equal(a.agentOperationProposal, undefined);
assert.equal(ui.agentOperationProposal.conversationId, "B", "关闭A不能藏掉当前B提案");
assert.equal(fns.conversationDispatchIsActive(a), false);
assert.equal(fns.conversationDispatchIsActive(b), true);
const next = dequeueReadyConversationInstruction({ conversation: a, messages: a.messages });
assert.equal(next.content, "下一项普通任务");
assert.equal(JSON.parse(JSON.stringify(b)).agentOperationProposal.operationId, b.agentOperationProposal.operationId, "待确认提案随对话持久化");

const unload = await block('window.addEventListener("beforeunload"', 'elements.chatInput.addEventListener("keydown"');
assert.doesNotMatch(unload, /interrupt|controller\.abort|cancelConversationRun|shutdownLocalRuntime/u, "导航/关闭页面不能显式终止其他任务");
console.log("Agent proposal FIFO, per-conversation parallelism, queued attachment and ownership checks passed");
