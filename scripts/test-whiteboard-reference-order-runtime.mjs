import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  incomingCanvasNodes,
  normalizeCanvas,
  reorderCanvasIncomingEdges,
  replaceCanvasNodeWithGenerationAsset,
} from "../src/whiteboard.js";
import { whiteboardPromptReferenceSequenceAfterInsertion } from "../src/whiteboard-rich-prompt.js";

const node = (id, kind, file = "") => ({
  id,
  type: file ? "file" : "text",
  kind,
  name: id,
  text: file ? "" : id,
  file,
  mimeType: kind === "video" ? "video/mp4" : kind === "image" ? "image/png" : "",
  x: 0,
  y: 0,
  width: 240,
  height: 160,
});

const targetId = "target";
const expectedOrder = ["video-c", "image-a", "image-b"];
const canvas = normalizeCanvas({
  nodes: [
    node("image-a", "image", "assets/a.png"),
    node("image-b", "image", "assets/b.png"),
    node("video-c", "video", "assets/c.mp4"),
    node(targetId, "text"),
  ],
  edges: [
    { id: "edge-a", fromNode: "image-a", toNode: targetId, order: 0 },
    { id: "edge-b", fromNode: "image-b", toNode: targetId, order: 1 },
    { id: "edge-c", fromNode: "video-c", toNode: targetId, order: 2 },
  ],
});

const reordered = reorderCanvasIncomingEdges(canvas, targetId, expectedOrder);
assert.deepEqual(incomingCanvasNodes(reordered, targetId).map((item) => item.id), expectedOrder, "拖拽后的顶部参考顺序必须立即按入边顺序生效");

const restored = normalizeCanvas(JSON.parse(JSON.stringify(reordered)));
const restoredInputs = incomingCanvasNodes(restored, targetId);
assert.deepEqual(restoredInputs.map((item) => item.id), expectedOrder, "保存并重新载入白板后，顶部参考顺序不得回退");
assert.deepEqual(restoredInputs.filter((item) => item.file).map((item) => item.file), ["assets/c.mp4", "assets/a.png", "assets/b.png"], "实际提交媒体必须使用顶部可视顺序");

const stressReferenceIds = Array.from({ length: 50 }, (_, index) => `stress-image-${index + 1}`);
const stressCanvas = normalizeCanvas({
  nodes: [
    ...stressReferenceIds.map((id, index) => node(id, "image", `assets/stress-${index + 1}.png`)),
    node("stress-target", "text"),
  ],
  edges: stressReferenceIds.map((fromNode, order) => ({ id: `stress-edge-${order + 1}`, fromNode, toNode: "stress-target", order })),
});
assert.deepEqual(incomingCanvasNodes(stressCanvas, "stress-target").map((item) => item.id), stressReferenceIds, "50 项全新参考必须从第一项到最后一项保持连接顺序");
const stressRestored = normalizeCanvas(JSON.parse(JSON.stringify(stressCanvas)));
assert.deepEqual(incomingCanvasNodes(stressRestored, "stress-target").map((item) => item.id), stressReferenceIds, "50 项参考保存回读后不得发生后段错位");

const unchanged = reorderCanvasIncomingEdges(restored, targetId, ["image-a", "missing", "video-c"]);
assert.deepEqual(incomingCanvasNodes(unchanged, targetId).map((item) => item.id), expectedOrder, "不完整或失效的重排不得破坏现有顺序");

const promptOccurrences = [
  { id: "image-b", start: 0, end: 8 },
  { id: "video-c", start: 12, end: 20 },
  { id: "image-b", start: 24, end: 32 },
];
assert.deepEqual(
  whiteboardPromptReferenceSequenceAfterInsertion(promptOccurrences, 10, 10, "image-a"),
  ["image-b", "image-a", "video-c", "image-b"],
  "提示词引用必须按出现位置保存节点身份，并保留重复引用",
);

const applied = replaceCanvasNodeWithGenerationAsset(restored, targetId, {
  id: "asset-result",
  kind: "text",
  origin: "generated",
  nodeName: "生成结果",
  text: "结果",
  prompt: "@「图片3」与@「视频1」",
  generationJobId: "generation-runtime-order-test",
  referenceOrder: expectedOrder,
  createdAt: new Date().toISOString(),
});
const appliedTarget = applied.nodes.find((item) => item.id === targetId);
assert.deepEqual(appliedTarget.generation.referenceOrder, expectedOrder, "结果回填和历史元数据必须保留本次顶部参考顺序");

const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-reference-order-runtime-"));
try {
  process.env.SHENSI_DATA_ROOT = runtimeRoot;
  process.env.SHENSI_MACHINE_DATA_ROOT = runtimeRoot;
  const { createClientGenerationJob } = await import(`../src/server/generation-job-store.mjs?runtime-order=${Date.now()}`);
  const job = await createClientGenerationJob({
    channel: "image",
    target: {
      workspaceKind: "project",
      workspacePath: runtimeRoot,
      documentId: "whiteboard-document",
      nodeId: targetId,
    },
    request: {
      prompt: "生成测试",
      referenceOrder: expectedOrder,
      promptReferenceSequence: ["image-b", "image-b", "video-c"],
      referenceMedia: restoredInputs.map((item) => ({ id: item.id, relativePath: item.file, name: item.name, mimeType: item.mimeType })),
    },
  });
  assert.deepEqual(job.request.referenceOrder, expectedOrder, "服务端任务必须原样保存顶部参考顺序");
  assert.deepEqual(job.request.promptReferenceSequence, ["image-b", "image-b", "video-c"], "服务端任务必须保留重复的提示词引用身份");
  assert.deepEqual(job.request.referenceMedia.map((item) => item.id), expectedOrder, "服务端任务的参考媒体顺序必须与顶部顺序完全一致");
  const stressJob = await createClientGenerationJob({
    channel: "image",
    target: {
      workspaceKind: "project",
      workspacePath: runtimeRoot,
      documentId: "whiteboard-document",
      nodeId: "stress-target",
    },
    request: {
      prompt: "大量参考顺序测试",
      referenceOrder: stressReferenceIds,
      promptReferenceSequence: [...stressReferenceIds, ...stressReferenceIds.slice(10, 20)],
      referenceMedia: incomingCanvasNodes(stressRestored, "stress-target").map((item) => ({ id: item.id, relativePath: item.file, name: item.name, mimeType: item.mimeType })),
    },
  });
  assert.deepEqual(stressJob.request.referenceOrder, stressReferenceIds, "50 项顶部参考必须完整进入服务端任务");
  assert.deepEqual(stressJob.request.referenceMedia.map((item) => item.id), stressReferenceIds, "50 项实际媒体参数必须与可见序列逐项一致");
  assert.deepEqual(stressJob.request.promptReferenceSequence, [...stressReferenceIds, ...stressReferenceIds.slice(10, 20)], "大量提示词引用及重复引用必须保持稳定节点身份和原顺序");
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

console.log("白板顶部参考、提示词身份、持久化、提交与回填顺序运行时测试通过");
