import assert from "node:assert/strict";
import {
  addCanvasTextNode,
  createCanvasTextNode,
  normalizeCanvas,
  replaceCanvasNodeContent,
  updateCanvasNode,
} from "../src/whiteboard.js";

const channels = ["text", "image", "video", "audio"];
for (const channel of channels) {
  const node = createCanvasTextNode({ id: `intent-${channel}`, generationIntent: { channel } });
  assert.deepEqual(node.generationIntent, { channel }, `${channel} 生成意图应持久化在节点上`);
  const restored = normalizeCanvas(JSON.parse(JSON.stringify({ nodes: [node], edges: [] })));
  assert.deepEqual(restored.nodes[0].generationIntent, { channel }, `${channel} 重启恢复后生成意图不能丢失`);
}

let canvas = normalizeCanvas({ nodes: [], edges: [] });
canvas = addCanvasTextNode(canvas, { id: "image-target", generationIntent: { channel: "image" } });
canvas = updateCanvasNode(canvas, "image-target", { text: "用户稍后再填写" });
assert.deepEqual(canvas.nodes[0].generationIntent, { channel: "image" }, "关闭操作栏或编辑文本不应清掉生成意图");

const completed = replaceCanvasNodeContent(canvas, "image-target", {
  kind: "image",
  prompt: "一张测试图片",
  attachment: { relativePath: "generated/test.png", mimeType: "image/png" },
});
assert.equal(completed.nodes[0].kind, "image", "生成完成后应转换为媒体卡片");
assert.equal(completed.nodes[0].generationIntent, undefined, "生成完成后不应继续显示待生成类型意图");

console.log("whiteboard generation intent persistence passed");
