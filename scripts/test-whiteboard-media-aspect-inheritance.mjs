import assert from "node:assert/strict";
import {
  DEFAULT_WHITEBOARD_MEDIA_ASPECT_RATIO,
  normalizeWhiteboardGenerationPreferences,
  rememberWhiteboardGenerationPreference,
} from "../src/whiteboard-generation-preference.js";
import { addCanvasTextNode, normalizeCanvas, updateCanvasNode } from "../src/whiteboard.js";

const initial = normalizeWhiteboardGenerationPreferences({});
assert.equal(initial.lastMediaAspectRatio, DEFAULT_WHITEBOARD_MEDIA_ASPECT_RATIO);

const remembered = rememberWhiteboardGenerationPreference(initial, "image", {
  connectionId: "image-a", model: "model-a", aspectRatio: "9:16",
});
assert.equal(remembered.lastMediaAspectRatio, "9:16");
assert.equal(remembered.image.aspectRatio, "9:16");
assert.equal(remembered.image.connectionId, "image-a");

const videoRemembered = rememberWhiteboardGenerationPreference(remembered, "video", {
  aspectRatio: "4:3",
});
assert.equal(videoRemembered.lastMediaAspectRatio, "4:3");
assert.equal(videoRemembered.image.aspectRatio, "9:16", "更新视频比例不能抹掉图片配置");
assert.equal(videoRemembered.video.aspectRatio, "4:3");

let canvas = addCanvasTextNode({ nodes: [] }, {
  id: "image-intent", kind: "text", generationIntent: { channel: "image" },
  width: 260, height: 160, aspectRatio: 9 / 16,
});
let node = normalizeCanvas(canvas).nodes[0];
assert.equal(node.aspectRatio, 9 / 16);
assert.equal(Math.round(node.width), 180, "竖图卡片宽度应在画布可操作范围内收缩");
assert.equal(Math.round(node.height), 320, "竖图卡片高度不得随比例无限增长");
canvas = updateCanvasNode(canvas, "image-intent", { aspectRatio: 4 / 3 });
node = normalizeCanvas(canvas).nodes[0];
assert.equal(node.aspectRatio, 4 / 3);
assert.equal(Math.round(node.width), 260);
assert.equal(Math.round(node.height), 195);

for (const ratio of [9 / 21, 21 / 9, 3 / 4, 1]) {
  canvas = updateCanvasNode(canvas, "image-intent", { aspectRatio: ratio });
  node = normalizeCanvas(canvas).nodes[0];
  assert.equal(node.aspectRatio, ratio);
  assert.ok(node.width <= 420, `宽度不能超过可操作上限: ${node.width}`);
  assert.ok(node.height <= 320, `高度不能超过可操作上限: ${node.height}`);
  assert.ok(Math.abs((node.width / node.height) - ratio) < 0.02, `卡片外框仍应保持选定比例: ${node.width}x${node.height}`);
}

console.log("whiteboard media aspect inheritance tests passed");
