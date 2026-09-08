import assert from "node:assert/strict";
import {
  isConversationVideoBatchRequest,
  parseStructuredVideoAssetItems,
  planConversationImageBatch,
  planConversationVideoBatch,
} from "../src/conversation-media-batch.js";
import { createConversationMediaDispatchContract } from "../src/conversation-media-dispatch.js";
import { decideConversationMediaRoute } from "../src/conversation-media-routing.js";

const structuredVideoText = [
  "根据以下视频提示词分别生成视频：",
  "V01｜雨夜追逐",
  "镜头从街角推进，人物在雨中冲刺，跟拍保持节奏和空间连续。",
  "V02｜山谷日出",
  "航拍山谷，云海翻涌，镜头缓慢上升并保持晨光色彩统一。",
].join("\n");

const parsed = parseStructuredVideoAssetItems(structuredVideoText);
assert.equal(parsed.length, 2, "V01/V02 headings must produce two video items");
assert.deepEqual(parsed.map((item) => item.code), ["V01", "V02"]);
assert.ok(parsed.every((item) => item.prompt.length >= 20));
assert.equal(isConversationVideoBatchRequest(structuredVideoText), true);

const planned = planConversationVideoBatch({ instruction: structuredVideoText });
assert.equal(planned.length, 2, "video batch planner must retain every structured item");
const contract = createConversationMediaDispatchContract({ text: structuredVideoText });
assert.equal(contract?.channel, "video");
assert.equal(contract?.plannedBatch.length, 2, "dispatch contract must carry the video batch");

const contextual = planConversationVideoBatch({
  instruction: "请把上面的分镜分别生成视频",
  messages: [{ role: "assistant", content: structuredVideoText }],
});
assert.equal(contextual.length, 2, "anaphoric request must read the prior confirmed video prompts");

const textOnly = [
  "我想了解视频生成的原理",
  "请生成一份视频生成方案",
  "今天讨论视频制作流程",
  "生成视频提示词",
  "视频生成失败，分析原因",
  "帮我写一个视频脚本",
  "写一份图片生成方案",
];
for (const instruction of textOnly) {
  const route = decideConversationMediaRoute({ text: instruction });
  assert.equal(route.directMediaChannel, "", `text-only request must not trigger media: ${instruction}`);
}

for (const instruction of ["制作一个视频", "根据提示词生成视频", "生成一张图片"]) {
  const route = decideConversationMediaRoute({ text: instruction });
  assert.ok(route.directMediaChannel, `explicit media request must remain executable: ${instruction}`);
}

assert.equal(planConversationVideoBatch({ instruction: "讨论两个视频的剪辑区别" }).length, 0, "ordinary discussion must not become a video batch");
assert.equal(planConversationVideoBatch({ instruction: "请生成两个视频" }).length, 2, "explicit video count must remain executable");
assert.equal(planConversationVideoBatch({ instruction: "请生成三张图片" }).length, 0, "image count must not leak into video batching");

const repeatedImage = planConversationImageBatch({
  instruction: "再来一张",
  messages: [
    { role: "user", content: "生成一张雨夜城门前的黑甲剑客图片" },
    { role: "assistant", content: "图片已生成", execution: { strength: "image", status: "completed" } },
  ],
});
assert.equal(repeatedImage.length, 1, "repeat image request must reuse the previous successful visual instruction");
assert.match(repeatedImage[0].prompt, /雨夜城门前的黑甲剑客/u);

console.log("conversation media batch tests passed");
