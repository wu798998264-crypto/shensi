import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  mergeWhiteboardGenerationDraftCaches,
  normalizeWhiteboardGenerationDraftCache,
  updateWhiteboardGenerationDraftCache,
} from "../src/whiteboard-generation-draft.js";
import { copyCanvasNode, createCanvasImageNode, normalizeCanvas, pasteCanvasNode } from "../src/whiteboard.js";
import { imageModelCapabilities } from "../src/model-presets.js";
import { publicGenerationJob } from "../src/server/generation-job-store.mjs";

const scope = { workspaceId: "w", documentId: "d", nodeId: "n", channel: "image" };
const older = updateWhiteboardGenerationDraftCache({}, scope, {
  prompt: "旧提示词",
  referenceOrder: ["ref-old"],
}, { updatedAt: 100 });
const newer = updateWhiteboardGenerationDraftCache({}, scope, {
  prompt: "刚刚输入的新提示词",
  referenceOrder: ["ref-new", "ref-second"],
  quality: "standard",
}, { updatedAt: 200 });
const merged = mergeWhiteboardGenerationDraftCaches(older, newer);
assert.equal(merged.entries["w::d::n::image"].values.prompt, "刚刚输入的新提示词");
assert.deepEqual(merged.entries["w::d::n::image"].values.referenceOrder, ["ref-new", "ref-second"]);
assert.equal(merged.entries["w::d::n::image"].values.quality, "standard");
assert.deepEqual(normalizeWhiteboardGenerationDraftCache(merged).entries["w::d::n::image"].values.referenceOrder, ["ref-new", "ref-second"]);

const source = normalizeCanvas({
  nodes: [createCanvasImageNode({
    id: "source",
    file: "media/image.png",
    mimeType: "image/png",
    generation: {
      channel: "image",
      prompt: "画面",
      profile: {
        connectionId: "image-libtv",
        model: "lib-image-2.5-s",
        aspectRatio: "16:9",
        quality: "standard",
        resolution: "2k",
        imageCount: 2,
      },
    },
  })],
});
const record = copyCanvasNode(source, "source");
const pasted = pasteCanvasNode(source, record, { id: "copy", x: 500, y: 40 });
assert.equal(pasted.canvas.nodes.find((node) => node.id === "copy")?.generation?.profile?.resolution, "2k");
assert.equal(pasted.canvas.nodes.find((node) => node.id === "copy")?.generation?.profile?.imageCount, 2);

const persistedJob = publicGenerationJob({
  id: "generation-profile-parameters", mode: "server", channel: "image", status: "queued",
  request: {
    aspectRatio: "16:9", quality: "standard", resolution: "2k", imageCount: 2, background: "opaque",
    generationProfile: { connectionId: "image-libtv", model: "lib-image-2.5-s", aspectRatio: "16:9", quality: "standard", resolution: "2k", imageCount: 2, background: "opaque" },
  },
});
assert.deepEqual(persistedJob.request.generationProfile, {
  connectionId: "image-libtv", model: "lib-image-2.5-s", aspectRatio: "16:9", quality: "standard",
  resolution: "2k", imageCount: 2, background: "opaque", speedMode: "default", agentSpeedMode: "default",
}, "任务公开回读必须保留生成参数，卡片重启后才能恢复完整选项");

const libtv = imageModelCapabilities("LibTV", "lib-image-2.5-s");
assert.deepEqual(libtv.qualityOptions, ["low", "standard", "high", "ultra", "max"]);
assert.ok(libtv.outputResolutions.includes("2k"), "LibTV 2.5 必须显示 2K 输出选项");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /mergeWhiteboardGenerationDraftCaches\(/u, "恢复必须合并本地与服务器草稿");
assert.match(app, /Object\.assign\(imageSettings[\s\S]{0,500}imageCount/u, "图片任务必须记录完整生成选项");
assert.match(app, /Object\.assign\(videoSettings[\s\S]{0,500}generateAudio/u, "视频任务必须记录完整生成选项");
assert.match(app, /generationParameterSnapshot\(job\.request\)/u, "卡片回写必须合并任务请求中的完整参数");
assert.doesNotMatch(app, /\(libTvImage25 \|\| \(preferGptImage25Defaults && gptImage25\)\)/u, "LibTV 刷新选项时不得覆盖用户已保存的画质与分辨率");

console.log("Reliable media and draft recovery regressions passed");
