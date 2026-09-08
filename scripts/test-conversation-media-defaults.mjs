import assert from "node:assert/strict";
import {
  conversationMediaDefaultIntent,
  conversationMediaEffectiveSelection,
  explicitConversationVideoDuration,
  normalizeConversationMediaDefaults,
} from "../src/conversation-media-defaults.js";

assert.deepEqual(conversationMediaDefaultIntent("把默认图片配置改成锅巴仔"), {
  channel: "image",
  instruction: "把默认图片配置改成锅巴仔",
});
assert.equal(conversationMediaDefaultIntent("以后生成图片"), null);
assert.equal(conversationMediaDefaultIntent("以后生成图片都用锅巴仔").channel, "image");
assert.equal(conversationMediaDefaultIntent("把默认视频模型设为 Seedance 2.5").channel, "video");
assert.equal(explicitConversationVideoDuration("生成一个 4 秒视频"), 4);
assert.equal(explicitConversationVideoDuration("沿用默认视频参数"), 0);
assert.deepEqual(normalizeConversationMediaDefaults({ video: { profileId: " v1 ", resolution: "1080P", duration: 30 } }).video, {
  profileId: "v1",
  model: "",
  aspectRatio: "",
  resolution: "1080p",
});
assert.deepEqual(conversationMediaEffectiveSelection({
  defaults: { image: { profileId: "default-image", quality: "high" } },
  successful: { profileId: "last-image", model: "gpt-image-2", aspectRatio: "1:1", quality: "standard" },
  channel: "image",
}), { profileId: "default-image", model: "gpt-image-2", aspectRatio: "1:1", quality: "high" });

console.log("conversation media default tests passed");
