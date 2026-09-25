import assert from "node:assert/strict";
import fs from "node:fs";
import {
  duplicateWhiteboardGenerationDraftEntries,
  updateWhiteboardGenerationDraftCache,
  whiteboardGenerationDraftKey,
} from "../src/whiteboard-generation-draft.js";

const appSource = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const capabilityStart = appSource.indexOf("const syncWhiteboardVideoCapabilityOptions");
const capabilityEnd = appSource.indexOf("const syncWhiteboardVideoModelOptions", capabilityStart);
assert.ok(capabilityStart >= 0 && capabilityEnd > capabilityStart, "视频能力同步函数必须存在");
const capabilitySource = appSource.slice(capabilityStart, capabilityEnd);
assert.match(capabilitySource, /preferDefaultDuration\s*=\s*false/u, "视频能力同步必须支持新建卡片的默认时长分支");
assert.match(capabilitySource, /durationOptions\.some\(\(value\) => String\(value\) === "4"\)/u, "默认时长必须优先选择 4 秒");
assert.match(capabilitySource, /preferDefaultDuration\)\s*form\.elements\.duration\.value\s*=\s*defaultDuration/u, "新建卡片必须强制应用默认时长");

const dialogStart = appSource.indexOf("const openWhiteboardVideoDialog");
const dialogEnd = appSource.indexOf("const openWhiteboardAudioDialog", dialogStart);
const dialogSource = appSource.slice(dialogStart, dialogEnd);
assert.match(dialogSource, /syncWhiteboardVideoModelOptions\([\s\S]{0,900}\{ preferDefaultDuration: !draftValues \}/u, "只有没有草稿的新视频卡片才应使用默认时长");

const pasteStart = appSource.indexOf("const pasteWhiteboardCard");
const pasteEnd = appSource.indexOf("document.querySelector(\"#addWhiteboardCard\")", pasteStart);
const pasteSource = appSource.slice(pasteStart, pasteEnd);
assert.match(pasteSource, /flushWhiteboardGenerationDrafts\(\)/u, "粘贴前必须持久化源卡片的最新参数");
assert.match(pasteSource, /duplicateWhiteboardGenerationDraftEntries\(/u, "复制粘贴必须复制生成参数草稿");
assert.match(pasteSource, /sourceDocumentId[\s\S]{0,260}targetDocumentId:\s*state\.activeDocument/u, "跨白板粘贴必须使用源文档和目标文档范围复制草稿");

let cache = {};
cache = updateWhiteboardGenerationDraftCache(cache, {
  workspaceId: "workspace-a",
  documentId: "board-a",
  nodeId: "video-source",
  channel: "video",
}, {
  connectionId: "video-dreamina",
  model: "seedance2.5",
  duration: "8",
  resolution: "1080p",
  aspectRatio: "16:9",
}, { updatedAt: 10 });
const copied = duplicateWhiteboardGenerationDraftEntries(cache, {
  workspaceId: "workspace-a",
  sourceDocumentId: "board-a",
  targetDocumentId: "board-b",
  sourceNodeId: "video-source",
  targetNodeId: "video-copy",
}, { updatedAt: 20 });
const copiedKey = whiteboardGenerationDraftKey({
  workspaceId: "workspace-a",
  documentId: "board-b",
  nodeId: "video-copy",
  channel: "video",
});
assert.equal(copied.entries[copiedKey]?.values.duration, "8", "复制到其他白板时必须继承原视频时长");
assert.equal(copied.entries[copiedKey]?.values.resolution, "1080p", "复制到其他白板时必须继承原视频清晰度");

console.log("Whiteboard video default duration tests passed");
