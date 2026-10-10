import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "shensi-libtv-reference-job-"));
process.env.SHENSI_DATA_ROOT = root;
try {
  const { createMediaGenerationJob } = await import("../src/server/generation-job-store.mjs");
  const target = { workspacePath: join(root, "board"), documentId: "board", nodeId: "target", documentKind: "whiteboard" };
  const request = { prompt: "角色@「图片1」再次@「图片1」", displayPrompt: "角色@「图片1」再次@「图片1」", providerPromptReferenceTokens: ["@「图片1」"], promptReferenceSequence: ["a", "a"], settings: { provider: "LibTV", adapter: "cli", model: "star-video2-mini" }, duration: "4", resolution: "720p", aspectRatio: "16:9" };
  const video = await createMediaGenerationJob({ channel: "video", target, request });
  assert.equal(video.request.libTvReferencePrompt, request.prompt);
  assert.deepEqual(video.request.promptReferenceSequence, ["a", "a"]);
  const image = await createMediaGenerationJob({ channel: "image", target: { ...target, nodeId: "image" }, request: { ...request, settings: { ...request.settings, model: "gpt-image-1" } } });
  assert.equal(image.request.libTvReferencePrompt, undefined);
  assert.equal(image.request.executionPrompt, "角色再次", "图片原始执行提示词清理不变");
  console.log("LibTV raw video insertions survive durable job normalization; image path unchanged");
} finally { await rm(root, { recursive: true, force: true }); }
