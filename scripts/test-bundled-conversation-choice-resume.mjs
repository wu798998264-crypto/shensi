import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runBundledConversationAgent } from "../src/server/bundled-conversation-runtime.mjs";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-choice-resume-"));
let calls = 0;

try {
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => [],
    readRoute: async () => "按任务语义继续原任务。",
    run: (options) => options.deliveryReview
      ? Promise.resolve({ text: JSON.parse(options.prompt).result })
      : runBundledConversationAgent({
        ...options,
        appRoot: process.cwd(),
        machineRoot: root,
        nativeWebSearchEnabled: false,
        fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body);
        calls += 1;
        const toolOutputs = request.messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
        if (calls === 1) {
          assert.ok(request.tools.some((tool) => tool.function.name === "interaction_ask"));
          return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
            id: "ask-one",
            type: "function",
            function: { name: "interaction_ask", arguments: JSON.stringify({ question: "选择方向？", options: ["方向甲", "方向乙"] }) },
          }] } }] });
        }
        if (calls === 2) {
          assert.match(toolOutputs, /方向乙/u, "继续推理请求必须包含用户刚确认的选择");
          return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
            id: "delivery-one",
            type: "function",
            function: { name: "interaction_delivery", arguments: JSON.stringify({ mode: "conversation", documentIds: [] }) },
          }] } }] });
        }
        assert.match(toolOutputs, /conversation/u, "最终生成前必须收到真实交付工具回执");
        return Response.json({ choices: [{ message: { role: "assistant", content: "已根据方向乙完成最终生成。" } }] });
        },
      }),
  });

  const started = await service.start({
    workspacePath: join(root, "workspace"),
    workspaceKind: "notebook",
    conversationId: "choice-resume-conversation",
    sourceMessageId: "choice-resume-message",
    messages: [{ role: "user", content: "先让我选择方向，再根据选择完成生成。" }],
    settings: {
      id: "mock-profile",
      agentEngine: "codex_api",
      provider: "自定义兼容接口",
      adapter: "api",
      protocol: "chat_completions",
      baseUrl: "https://mock.invalid/v1",
      model: "mock-choice-model",
      apiKey: "mock-key",
      agentPermissionMode: "shensi_only",
    },
  });

  let question = null;
  let waitingStatus = null;
  for (let index = 0; index < 200 && !question; index += 1) {
    waitingStatus = await service.status(started.id);
    question = waitingStatus.events.find((event) => event.type === "question")?.payload || null;
    if (["completed", "failed", "cancelled", "interrupted"].includes(waitingStatus.status)) break;
    if (!question) await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(question, `内置运行器必须真正进入结构化选择等待状态：${waitingStatus?.error || waitingStatus?.status || "unknown"}`);
  await service.answer(started.id, question.id, "方向乙");

  let finalStatus = null;
  for (let index = 0; index < 300; index += 1) {
    finalStatus = await service.status(started.id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(finalStatus.status)) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(finalStatus.status, "completed", finalStatus.error);
  assert.equal(finalStatus.text, "已根据方向乙完成最终生成。");
  assert.equal(calls, 3, "选择回答后必须继续工具回执和最终生成，而不是停在最后一问");
  assert.ok(finalStatus.events.some((event) => event.type === "answer_accepted"));
  assert.ok(finalStatus.events.some((event) => event.type === "progress" && /继续生成/u.test(event.payload.message)));
  console.log("Bundled Codex choice -> answer -> continued inference -> final response passed");
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
