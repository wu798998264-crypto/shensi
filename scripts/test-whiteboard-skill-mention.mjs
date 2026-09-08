import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  addCanvasEdge,
  createCanvasTextNode,
  whiteboardGenerationSources,
} from "../src/whiteboard.js";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(appSource, /const whiteboardGenerationReferenceSemanticLabel[\s\S]{0,700}reference\.title/u, "@ 引用应优先显示 Skill 的正式名称");
assert.match(appSource, /const whiteboardGenerationReferenceSearchText[\s\S]{0,900}selection\?\.name[\s\S]{0,300}selection\?\.relativePath/u, "@ 搜索应覆盖 Skill 名、ID 和路径");
assert.match(appSource, /whiteboardGenerationReferenceSearchText\(node, aliases\.get\(node\.id\)\)/u, "候选筛选必须使用 Skill 语义搜索文本");
assert.match(appSource, /\["skill", "capability"\]\.includes\(node\.reference\?\.type\) \? icon\("\\uE943"\)/u, "Skill 候选必须显示独立图标");
assert.match(appSource, /escapeHtml\(whiteboardGenerationReferenceTypeLabel\(node\)\)/u, "Skill 候选必须显示正确引用类型");

const skillNode = createCanvasTextNode({
  id: "skill-node",
  name: "文本节点 4",
  text: "Skill 全文",
  kind: "skill",
  reference: {
    type: "skill",
    id: "official:prompt-writer",
    title: "提示词主笔",
    skillSelections: [{ id: "official:prompt-writer", name: "提示词主笔", requestedRole: "primary" }],
  },
});
const targetNode = createCanvasTextNode({ id: "target-node", name: "生成结果" });
const canvas = addCanvasEdge({ nodes: [skillNode, targetNode], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, {
  id: "edge-skill-target",
  fromNode: skillNode.id,
  toNode: targetNode.id,
});
const sources = whiteboardGenerationSources(canvas, targetNode.id);
assert.equal(sources.upstream[0]?.reference?.title, "提示词主笔", "Skill 卡片必须作为真实上游保留正式名称");
assert.equal(sources.selectedSkills[0]?.id, "official:prompt-writer", "插入 @Skill 后生成链路必须继续获得 selectedSkills");
assert.equal(sources.selectedSkills[0]?.source, "whiteboard_explicit", "Skill 必须保持用户显式授权来源");

console.log("白板生成操作栏 @Skill 名称、搜索、显示与执行链路测试通过");
