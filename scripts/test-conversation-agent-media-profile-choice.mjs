import assert from "node:assert/strict";
import { createConversationAgentTools } from "../src/server/conversation-agent-tools.mjs";

const questions = [];
const mediaCalls = [];
const tools = createConversationAgentTools({
  instruction: "更换即梦配置生成图片",
  signal: new AbortController().signal,
  mediaProfiles: {
    image: [
      { id: "dreamina-a", provider: "即梦", remarkName: "账号A", model: "seedream-4.0" },
      { id: "dreamina-b", provider: "即梦", remarkName: "账号B", model: "seedream-4.0" },
    ],
    video: [],
  },
  ask: async (decision) => {
    questions.push(decision);
    return { answer: "账号B（即梦 · seedream-4.0）" };
  },
  media: async (args) => {
    mediaCalls.push(args);
    return { jobId: "generation-image-dreamina-b", attachment: { mimeType: "image/png" }, backedUpToAllAssets: true };
  },
});

const result = await tools.invoke({ namespace: "media", tool: "generate", arguments: {
  channel: "image", prompt: "验收图片", operationId: "profile-choice-once",
}});

assert.equal(result.success, true, result.contentItems?.[0]?.text);
assert.equal(questions.length, 1, "切换多个即梦配置时必须只询问一次");
assert.equal(questions[0].presentation, "media_profile");
assert.deepEqual(questions[0].options, [
  "账号A（即梦 · seedream-4.0）",
  "账号B（即梦 · seedream-4.0）",
]);
assert.equal(mediaCalls.length, 1, "用户选择后只允许提交一次媒体任务");
assert.equal(mediaCalls[0].profileId, "dreamina-b");
assert.equal(tools.deliveryStatus().missing.length, 0);
console.log("Conversation Agent media profile selection and explicit profile handoff passed");
