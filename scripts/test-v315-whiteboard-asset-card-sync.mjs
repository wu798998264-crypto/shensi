import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  canvasNodeDisplaysGenerationContent,
  normalizeCanvas,
  replaceCanvasNodeContent,
} from "../src/whiteboard.js";

const content = {
  kind: "image",
  prompt: "云海中的御兽师",
  generationJobId: "generation-card-sync-0001",
  generationCreatedAt: "2026-08-26T01:00:00.000Z",
  attachment: {
    relativePath: "assets/generated/card-sync.png",
    mimeType: "image/png",
  },
  aspectRatio: 1,
};
const placeholderCanvas = normalizeCanvas({
  nodes: [{
    id: "card-1",
    type: "text",
    kind: "text",
    text: "正在生成图片",
    x: 40,
    y: 40,
    width: 320,
    height: 180,
  }],
  assets: [{
    id: "asset-1",
    kind: "image",
    origin: "generated",
    generationJobId: content.generationJobId,
    sourceNodeId: "card-1",
    attachment: content.attachment,
    createdAt: content.generationCreatedAt,
  }],
});

assert.equal(
  canvasNodeDisplaysGenerationContent(placeholderCanvas.nodes[0], content),
  false,
  "资产已存在不代表原生成卡片已经显示结果",
);
const synchronizedCanvas = replaceCanvasNodeContent(placeholderCanvas, "card-1", content);
assert.equal(
  canvasNodeDisplaysGenerationContent(synchronizedCanvas.nodes[0], content),
  true,
  "把既有资产绑定回原卡片后必须能够通过严格显示校验",
);
assert.equal(synchronizedCanvas.nodes[0].file, content.attachment.relativePath);
assert.equal(
  canvasNodeDisplaysGenerationContent(synchronizedCanvas.nodes[0], {
    ...content,
    attachment: { ...content.attachment, relativePath: "assets/generated/other.png" },
  }),
  false,
  "同一任务编号但文件不一致时不得误报同步完成",
);

const [appSource, storeSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8"),
]);

assert.doesNotMatch(
  appSource,
  /if \(duplicate\) return \{ documentState, asset: existingAssets\[0\]/u,
  "发现重复资产时不得在同步卡片之前提前返回",
);
assert.match(
  appSource,
  /landingChanged = !duplicate \|\| recoveredTarget \|\| cardSynchronized/u,
  "卡片同步必须作为独立的工作区变更保存",
);
assert.match(
  appSource,
  /forceDurableCardWrite/u,
  "保存失败后的重试必须强制把内存中的结果重新写回磁盘",
);
assert.match(
  appSource,
  /assetMetadataRepaired[\s\S]{0,900}generationJobId: content\.generationJobId/u,
  "旧资产只有文件路径时必须补齐任务归属，而不是再创建一份重复资产",
);
assert.match(
  appSource,
  /appliedWhiteboardJobCanSynchronizeCard[\s\S]{0,900}repairAppliedWhiteboardCardDisplay/u,
  "已应用任务若只有资产而卡片未显示，启动恢复必须自动同步原卡片",
);
assert.match(
  appSource,
  /synchronizeLegacyWhiteboardAssetCards[\s\S]{0,3000}replaceCanvasNodeWithGenerationAsset/u,
  "即使旧任务账本已清理，也必须能根据全部资产中的原卡片归属修复文字占位卡",
);
assert.match(
  appSource,
  /if \(node\.file\) continue;[\s\S]{0,260}currentJobId !== asset\.generationJobId/u,
  "旧资产自动同步不得覆盖当前媒体或属于另一更新任务的卡片",
);
assert.match(
  appSource,
  /if \(!canvasNodeDisplaysGenerationContent\(persistedNode, persistedContent\)\)[\s\S]{0,180}自动同步到卡片/u,
  "任务 applied 前必须回读确认原生成卡片真正显示了结果",
);
assert.match(
  storeSource,
  /const resultLimit = includeApplied && targetPath \? 500 : 100/u,
  "工作区恢复必须覆盖超过 100 条的历史应用任务",
);

console.log("v3.1.5 白板资产到原生成卡片自动同步测试通过");
