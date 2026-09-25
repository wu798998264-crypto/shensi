import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  arrangeCanvasNodes,
  duplicateCanvasNodeRight,
  normalizeCanvas,
} from "../src/whiteboard.js";

const canvas = normalizeCanvas({
  nodes: [
    { id: "upstream", type: "text", kind: "text", name: "上游", text: "上游", x: -260, y: 40, width: 160, height: 100 },
    { id: "source", type: "text", kind: "text", name: "源卡片", text: "源", x: 40, y: 40, width: 200, height: 120 },
    { id: "blocker-1", type: "text", kind: "text", name: "右侧卡片", text: "挡住", x: 280, y: 40, width: 200, height: 120 },
    { id: "blocker-2", type: "text", kind: "text", name: "更右侧卡片", text: "继续挡住", x: 520, y: 40, width: 200, height: 120 },
    { id: "downstream", type: "text", kind: "text", name: "下游", text: "下游", x: 760, y: 40, width: 160, height: 100 },
  ],
  edges: [
    { id: "incoming", fromNode: "upstream", toNode: "source" },
    { id: "outgoing", fromNode: "source", toNode: "downstream" },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { snapToGrid: false, gridSize: 20 },
});

const duplicated = duplicateCanvasNodeRight(canvas, "source", { id: "copy" });
const copy = duplicated.canvas.nodes.find((node) => node.id === "copy");
assert.ok(copy, "应创建右侧副本");
assert.ok(copy.x > 720, `右侧副本必须跳过连续遮挡卡片，实际 x=${copy.x}`);
assert.equal(copy.y, 40, "右侧副本应保持原卡片的垂直位置");
const copiedIncoming = duplicated.canvas.edges.filter((edge) => edge.toNode === "copy");
assert.equal(copiedIncoming.length, 1, "副本应保留上游连接");
assert.equal(copiedIncoming[0].fromNode, "upstream", "副本上游连接来源必须保持不变");
assert.equal(duplicated.canvas.edges.some((edge) => edge.fromNode === "copy"), false, "副本不得复制下游连接");

const horizontal = arrangeCanvasNodes(canvas, { layoutMode: "horizontal", horizontalGap: 32 });
assert.ok(horizontal.nodes[1].x > horizontal.nodes[0].x, "水平排列应按 x 递增");
assert.equal(horizontal.nodes.every((node, index, nodes) => index === 0 || node.x >= nodes[index - 1].x + nodes[index - 1].width + 32), true,
  "水平排列的卡片之间应保留间距");

const vertical = arrangeCanvasNodes(canvas, { layoutMode: "vertical", verticalGap: 24 });
assert.ok(vertical.nodes[1].y > vertical.nodes[0].y, "垂直排列应按 y 递增");
assert.equal(vertical.nodes.every((node, index, nodes) => index === 0 || node.y >= nodes[index - 1].y + nodes[index - 1].height + 24), true,
  "垂直排列的卡片之间应保留间距");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /const localWhiteboardArrangeLayout = \(canvas, nodeIds = \[\], layoutMode = "grid"\)/u,
  "局部整理必须使用选中卡片子集计算预览");
assert.match(appSource, /未选卡片位置保持不变/u,
  "局部整理界面必须明确未选卡片不会移动");
assert.match(appSource, /if \(decision === "adopt"\)[\s\S]{0,500}pushWhiteboardHistory/u,
  "只有采用整理方案时才写入历史记录");
assert.match(appSource, /if \(ui\.whiteboardArrangePreview\) return resolveWhiteboardArrangePreview\("restore"\)/u,
  "还原整理预览不得写入布局");

console.log("whiteboard right-duplicate and arrange-layout tests passed");
