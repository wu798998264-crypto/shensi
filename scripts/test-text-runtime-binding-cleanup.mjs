import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-text-binding-cleanup-"));
process.env.SHENSI_MACHINE_DATA_ROOT = runtimeRoot;

try {
  const runtime = await import(`../src/server/generation-runtime-store.mjs?text-cleanup=${Date.now()}`);
  const binding = (channel, profileId) => ({
    channel,
    profileId,
    adapter: "api",
    provider: channel === "text" ? "自定义兼容接口" : "媒体配置哨兵",
    protocol: channel === "text" ? "responses" : "images",
    baseUrl: "https://example.invalid/v1",
    model: `${channel}-model`,
  });
  await runtime.saveGenerationRuntimeBindings({
    bindings: [
      binding("text", "text-old-free"),
      binding("text", "text-old-deepseek"),
      binding("image", "image-protected"),
      binding("video", "video-protected"),
    ],
  });
  await runtime.saveGenerationRuntimeBindings({
    bindings: [binding("text", "text-aggregate"), binding("text", "text-deepseek-agent")],
    replaceChannels: ["text"],
  });
  const saved = await runtime.listGenerationRuntimeBindings();
  assert.deepEqual(saved.bindings.filter((item) => item.channel === "text").map((item) => item.profileId),
    ["text-aggregate", "text-deepseek-agent"]);
  assert.equal(saved.bindings.some((item) => item.channel === "image" && item.profileId === "image-protected"), true,
    "替换文字绑定不得删除图片绑定");
  assert.equal(saved.bindings.some((item) => item.channel === "video" && item.profileId === "video-protected"), true,
    "替换文字绑定不得删除视频绑定");
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

console.log("Text runtime binding cleanup contracts passed");
