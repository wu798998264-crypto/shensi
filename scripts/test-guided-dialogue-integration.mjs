import assert from "node:assert/strict";
import {
  creativeGuidanceChoiceContinuation,
  creativeGuidanceSessionMessages,
  latestCreativeGuidanceSessionState,
} from "../src/creative-guidance-session.js";
import { structuredCreativeGuidanceChoice } from "../src/conversation-choice-panel.js";

const messages = [
  { id: "old-user", role: "user", content: "另一个旧任务" },
  { id: "guided-user-1", role: "user", content: "我想写爽文", guidanceSessionId: "guidance-1" },
  {
    id: "guided-assistant-1",
    role: "assistant",
    content: "先确认主角最核心的爽点。",
    guidanceSessionId: "guidance-1",
    execution: { guidanceState: { deliverableType: "novel", questionCluster: "core_appeal", turnCount: 1 } },
  },
  { id: "panel-copy", role: "assistant", content: "请选择一个方向" },
  { id: "guided-user-2", role: "user", content: "扮猪吃虎", guidanceSessionId: "guidance-1" },
  { id: "other-session", role: "assistant", content: "另一场引导", guidanceSessionId: "guidance-2", execution: { guidanceState: { turnCount: 9 } } },
];

assert.deepEqual(
  creativeGuidanceSessionMessages({
    messages,
    sessionId: "guidance-1",
    session: { sessionId: "guidance-1", startIndex: 1 },
  }).map((message) => message.id),
  ["guided-user-1", "guided-assistant-1", "guided-user-2"],
  "持续引导只能携带同一 session 的消息，不能混入旧任务、选择面板副本或其他引导",
);

assert.deepEqual(
  creativeGuidanceSessionMessages({
    messages: messages.slice(0, 4).map(({ guidanceSessionId: _session, ...message }) => message),
    sessionId: "legacy-guidance",
    session: { sessionId: "legacy-guidance", startIndex: 1 },
  }).map((message) => message.id),
  ["guided-user-1", "guided-assistant-1", "panel-copy"],
  "旧数据没有逐条 session 标记时，应从持久化 startIndex 恢复而不是丢失引导",
);

assert.deepEqual(
  creativeGuidanceSessionMessages({
    messages,
    sessionId: "unknown-guidance",
    session: { sessionId: "guidance-1", startIndex: 1 },
  }),
  [],
  "不属于当前会话的 sessionId 不得借用当前引导上下文",
);

assert.equal(
  latestCreativeGuidanceSessionState({
    messages,
    sessionId: "guidance-1",
    session: { sessionId: "guidance-1", startIndex: 1, guidanceState: { turnCount: 0 } },
  }).turnCount,
  1,
  "下一轮应优先续接本会话最近一次服务端 guidanceState",
);

assert.equal(
  latestCreativeGuidanceSessionState({
    messages: [{ id: "user", role: "user", guidanceSessionId: "guidance-cache" }],
    sessionId: "guidance-cache",
    session: { sessionId: "guidance-cache", startIndex: 0, guidanceState: { turnCount: 3 } },
  }).turnCount,
  3,
  "消息尚未恢复完整时，应使用会话内持久化的 guidanceState 续接",
);

const continuation = creativeGuidanceChoiceContinuation({
  pending: { conversationId: "conversation-1", guidanceSessionId: "guidance-1" },
  option: { id: "direction-1", label: "扮猪吃虎" },
});
assert.deepEqual(continuation, {
  content: "扮猪吃虎",
  conversationId: "conversation-1",
  guidanceSessionId: "guidance-1",
  guidanceDialog: true,
}, "选择卡点击必须回到原对话和原引导 session，而不是作为新任务发送");

assert.equal(creativeGuidanceChoiceContinuation({
  pending: { conversationId: "conversation-1" },
  option: { label: "只保留在对话区" },
}).guidanceDialog, false, "非引导选择不能被误标为创作引导续接");

const choice = structuredCreativeGuidanceChoice({
  choiceQuestion: "哪一种爽点更接近你真正想写的？",
  guidanceState: {
    interactionMode: "choice_fallback",
    candidateOptions: [
      { id: "a", label: "身份反转", impact: "强调落差" },
      { id: "b", label: "实力碾压", impact: "强调即时反馈" },
    ],
  },
});
assert.equal(choice.question, "哪一种爽点更接近你真正想写的？");
assert.deepEqual(choice.options.map((option) => option.id), ["a", "b"]);
assert.equal(structuredCreativeGuidanceChoice({
  guidanceState: { interactionMode: "discussion", candidateOptions: [{ id: "a", label: "不该出现" }] },
}), null, "开放讨论不得无节制弹出固定选项");

console.log("guided dialogue integration tests passed");
