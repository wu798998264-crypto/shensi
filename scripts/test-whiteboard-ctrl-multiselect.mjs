import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, styleSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

assert.match(appSource, /whiteboardModifierSelectionPointer:\s*null/u, "白板需要保留修饰键点击的瞬时指针状态");
assert.match(
  appSource,
  /const toggleWhiteboardNodeSelection = \(nodeId\) =>[\s\S]{0,700}selectWhiteboardNodes\(next\)/u,
  "Ctrl+点击必须复用现有多选状态，而不是创建另一套组数据",
);
assert.match(
  appSource,
  /const modifierSelection = Boolean\(card && \(event\.ctrlKey \|\| event\.metaKey\)[\s\S]{0,700}toggleWhiteboardNodeSelection\(card\.dataset\.canvasNode\)/u,
  "白板卡片点击必须支持 Ctrl/Command 累积或取消选择",
);
assert.match(
  appSource,
  /const modifierSelection = Boolean\(card && \(event\.ctrlKey \|\| event\.metaKey\)[\s\S]{0,700}ui\.whiteboardModifierSelectionPointer = \{/u,
  "修饰键点击不能进入普通拖动或生成栏打开流程",
);
assert.match(
  appSource,
  /whiteboardMultiSelection[\s\S]{0,500}data-whiteboard-multi-handle="output"/u,
  "多选结果必须继续暴露聚合输出连接节点",
);
assert.match(
  appSource,
  /const createWhiteboardSelectionGenerationTarget = \(nodeIds = \[\], channel = "text"/u,
  "多选卡片必须继续支持从聚合节点创建生成卡片",
);
assert.match(
  appSource,
  /mode: "multi-edge"[\s\S]{0,300}nodeIds/u,
  "聚合节点拖拽必须继续按选中卡片批量建立连接",
);
assert.match(
  appSource,
  /if \(!group\?\.isConnected\) \{[\s\S]{0,260}data-canvas-edge=[\s\S]{0,180}record\.group = group/u,
  "拖拽期间白板重绘后必须重新绑定可见连线元素",
);
assert.match(
  appSource,
  /const activeDrag = ui\.whiteboardDrag[\s\S]{0,420}if \(activeDrag\) updateWhiteboardConnectedEdgePreview\(activeDrag\)/u,
  "白板重绘必须在同一帧恢复正在拖拽的连线位置",
);
assert.match(
  appSource,
  /id="whiteboardNodeCreateMenu"[\s\S]{0,1200}data-whiteboard-node-create="plain"[\s\S]{0,300}data-whiteboard-node-create="text"[\s\S]{0,300}data-whiteboard-node-create="image"[\s\S]{0,300}data-whiteboard-node-create="video"[\s\S]{0,300}data-whiteboard-node-create="audio" hidden/u,
  "空白落点选择器必须按顺序提供普通、文本、图片和视频，并隐藏尚未接通的音频入口",
);
assert.match(
  appSource,
  /data-whiteboard-action="create" data-whiteboard-target="canvas"[\s\S]{0,220}data-whiteboard-action="create-text"[\s\S]{0,260}data-whiteboard-action="create-image"[\s\S]{0,260}data-whiteboard-action="create-video"[\s\S]{0,260}data-whiteboard-action="create-audio"/u,
  "空白白板右键菜单必须在添加节点下方直接平铺文本、图片、视频和音频生成入口",
);
assert.match(
  appSource,
  /const canvasCreateKind = \{[\s\S]{0,260}create: "plain"[\s\S]{0,260}"create-text": "text"[\s\S]{0,260}"create-image": "image"[\s\S]{0,260}"create-video": "video"[\s\S]{0,260}"create-audio": "audio"[\s\S]{0,500}commitWhiteboardNodeCreateIntent\(canvasCreateKind\)/u,
  "添加节点必须直接创建普通卡片，四个生成入口必须直接创建各自类型卡片",
);
assert.match(
  appSource,
  /querySelectorAll\("\[data-whiteboard-canvas-create\]"\)[\s\S]{0,300}button\.hidden = target !== "canvas" \|\| !whiteboardNodeCreateChannelAvailable\(kind\)/u,
  "空白白板最外层生成入口必须按当前本机能力动态隐藏",
);
assert.match(
  appSource,
  /button\.hidden = kind !== "plain" && !available/u,
  "本机没有对应生成能力时必须隐藏该类型，而不是留下不可用入口",
);
assert.match(
  appSource,
  /const blankCanvasDrop[\s\S]{0,500}pendingNodeCreateIntent = \{[\s\S]{0,300}direction: drag\.mode === "multi-edge" && drag\.direction === "input" \? "input" : "output"/u,
  "空白落点只能建立临时意图，并保留单卡或聚合节点的连接方向",
);
assert.match(
  appSource,
  /if \(!pendingNodeCreateIntent\) ui\.whiteboardEdgeDraft = null/u,
  "四选项显示期间必须保留落点临时连线",
);
assert.match(
  appSource,
  /const closeWhiteboardNodeCreateMenu = \(\) => \{[\s\S]{0,420}ui\.whiteboardEdgeDraft = null;[\s\S]{0,180}\.whiteboard-edge\.draft/u,
  "取消四选项时必须同时清理待创建意图和临时连线",
);
assert.match(
  appSource,
  /const commitWhiteboardNodeCreateIntent[\s\S]{0,1500}intent\.direction === "input"[\s\S]{0,700}checkWhiteboardReferenceCapacity[\s\S]{0,900}persist\(\{ documentIds: \[state\.activeDocument\] \}\)/u,
  "选择卡片类型后必须原子校验、创建、连接并定向保存",
);
assert.match(
  appSource,
  /if \(kind === "text"\) openWhiteboardGenerateDialog\(nodeId\);[\s\S]{0,160}else if \(kind === "image"\) openWhiteboardImageDialog\(nodeId\);[\s\S]{0,160}else if \(kind === "video"\) openWhiteboardVideoDialog\(nodeId\);/u,
  "三类生成卡片创建后必须立即打开对应生成操作栏",
);
assert.match(appSource, /if \(!event\.target\.closest\("#whiteboardNodeCreateMenu"\)\) closeWhiteboardNodeCreateMenu\(\)/u, "点击选择器外部必须取消待创建意图");
assert.match(styleSource, /\.whiteboard-node-create-menu\s*\{[\s\S]{0,260}width:\s*184px/u, "落点选择器必须使用紧凑稳定的菜单布局");

console.log("Whiteboard Ctrl multi-select contracts passed");
