import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";

const waitForTerminal = async (service, id) => {
  for (let index = 0; index < 200; index += 1) {
    const status = await service.status(id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.status)) return status;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Conversation Agent media test timed out");
};

const root = await mkdtemp(join(tmpdir(), "shensi-agent-media-delivery-"));
try {
  let mediaCalls = 0;
  const successful = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "successful"),
    skillCatalog: async () => [],
    readRoute: async () => "按完整语义执行真实媒体任务。",
    media: async (args, { emit }) => {
      mediaCalls += 1;
      assert.equal(args.channel, "image");
      await emit("media_job", { jobId: "generation-test-image", messageId: "message-image", channel: "image", profileId: "image-profile" });
      await emit("media_saved", { jobId: "generation-test-image", messageId: "message-image", channel: "image", attachment: { id: "asset-image", mimeType: "image/png" } });
      return { jobId: "generation-test-image", attachment: { id: "asset-image", mimeType: "image/png" }, backedUpToAllAssets: true };
    },
    run: async ({ prompt, workspaceToolRuntime }) => {
      assert.equal(JSON.parse(prompt).mediaDispatch.channel, "image", "已确认的媒体意图必须进入 Agent 运行上下文");
      const falseConversation = await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "conversation", taskType: "general_qa", documentIds: [] } });
      assert.equal(falseConversation.success, false, "明确真实生图时不得降级为文字交付");
      const declaration = await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "media", taskType: "image_generation", documentIds: [], mediaChannels: ["image"] } });
      assert.equal(declaration.success, true, declaration.contentItems[0].text);
      const generated = await workspaceToolRuntime.invoke({ namespace: "media", tool: "generate", arguments: { channel: "image", prompt: "孙悟空3D国漫角色图", operationId: "image-one", quality: "2k", aspectRatio: "16:9" } });
      assert.equal(generated.success, true, generated.contentItems[0].text);
      return { text: "图片已经真实生成并完成下载验收。" };
    },
  });
  const mediaDispatch = { version: 1, kind: "media", channel: "image", plannedBatch: [{ code: "IMG01", prompt: "孙悟空3D国漫角色图" }] };
  const started = await successful.start({
    workspacePath: join(root, "workspace"),
    workspaceKind: "notebook",
    conversationId: "media-success",
    sourceMessageId: "media-success-message",
    messages: [{ role: "user", content: "生成对应图片" }],
    mediaDispatch,
    mediaProfiles: { image: [{ id: "image-profile", provider: "自定义兼容接口", model: "gpt-image-2.5" }], video: [] },
    settings: { id: "text-profile", agentEngine: "codex_api", model: "mock", apiKey: "test-secret" },
  });
  const completed = await waitForTerminal(successful, started.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(mediaCalls, 1, "一次明确图片交付只能提交一次媒体任务");
  assert.ok(completed.events.some((event) => event.type === "media_job"));
  assert.ok(completed.events.some((event) => event.type === "media_saved"));
  assert.ok(completed.events.some((event) => event.type === "delivery" && event.payload.taskType === "image_generation"));

  let falseCompletionCalls = 0;
  const falseCompletion = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "false-completion"),
    skillCatalog: async () => [],
    readRoute: async () => "真实媒体交付必须通过工具验收。",
    run: async ({ workspaceToolRuntime }) => {
      falseCompletionCalls += 1;
      await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "media", taskType: "image_generation", documentIds: [], mediaChannels: ["image"] } });
      return { text: "已生成图片。" };
    },
  });
  const falseStarted = await falseCompletion.start({
    workspacePath: join(root, "workspace"),
    workspaceKind: "notebook",
    conversationId: "media-false-completion",
    sourceMessageId: "media-false-completion-message",
    messages: [{ role: "user", content: "生成对应图片" }],
    mediaDispatch,
    settings: { id: "text-profile", agentEngine: "codex_api", model: "mock", apiKey: "test-secret" },
  });
  const failed = await waitForTerminal(falseCompletion, falseStarted.id);
  assert.equal(failed.status, "failed", "没有 media.generate 回执时不得把口头声明标记为完成");
  assert.match(failed.error, /图片生成/u);
  assert.equal(falseCompletionCalls, 3, "初次执行和两次交付纠正后必须明确失败，不能无限循环");

  console.log("Conversation Agent media dispatch, real tool delivery and false-completion rejection passed");
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
