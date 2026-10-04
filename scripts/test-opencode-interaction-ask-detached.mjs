import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-opencode-ask-"));
try {
  let calls = 0;
  let taskCalls = 0;
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => [],
    readRoute: async () => "",
    run: async ({ workspaceToolRuntime, prompt, deliveryReview }) => {
      calls += 1;
      if (deliveryReview) return { text: "已按方向乙完成" };
      taskCalls += 1;
      if (calls === 1) {
        await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: {
          mode: "conversation", taskType: "general_qa", routingMode: "general",
          routingReason: "测试 OpenCode 选择恢复", documentIds: [],
        } });
        const asked = await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "ask", arguments: {
          question: "请选择方向", options: ["方向甲", "方向乙"],
        } });
        const payload = JSON.parse(asked.contentItems[0].text);
        assert.equal(payload.waitingForUser, true, "OpenCode ask 必须立即返回可恢复标记");
        assert.equal(payload.metadata?.detachedResume, true, "OpenCode ask 必须声明回答恢复同一任务");
        // A real OpenCode build may exit after the short marker without a
        // final assistant message. The service must still remain waiting and
        // resume this same task after the answer.
        throw new Error("OpenCode Agent 已结束，但没有返回可用文本");
      }
      const continuation = JSON.parse(prompt);
      assert.equal(continuation.userAnswer, "方向乙", "回答必须回到同一任务继续执行");
      return { text: "已按方向乙完成" };
    },
  });
  const started = await service.start({
    workspacePath: root,
    workspaceKind: "notebook",
    conversationId: "opencode-conversation",
    sourceMessageId: "opencode-message",
    messages: [{ role: "user", content: "请帮我选择方向" }],
    settings: { agentEngine: "opencode", model: "openai/gpt-4o" },
  });
  let waiting;
  for (let index = 0; index < 100; index += 1) {
    waiting = await service.status(started.id);
    if (waiting.status === "waiting_input") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (waiting.status !== "waiting_input") console.error(JSON.stringify(waiting, null, 2));
  assert.equal(waiting.status, "waiting_input", "短 MCP 请求后任务必须在神思侧等待用户");
  const question = waiting.question;
  assert.ok(question?.id, "等待状态必须保留可回答的问题");
  assert.deepEqual(await service.answer(started.id, question.id, "方向乙"), { accepted: true });
  let completed;
  for (let index = 0; index < 200; index += 1) {
    completed = await service.status(started.id);
    if (["completed", "failed"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.text, "已按方向乙完成");
  assert.equal(taskCalls, 2, "回答后必须复用同一任务继续一次，不得重复询问或重复派发");
  console.log("OpenCode interaction.ask detached wait/resume passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
