import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  loadWorkspaceState,
  saveWorkspaceAttachmentFromPath,
  saveWorkspaceState,
  upsertWorkspaceWhiteboardMediaIndex,
} from "../src/server/workspace.mjs";
import {
  addCanvasEdge,
  addCanvasImageNode,
  appendCanvasAsset,
  normalizeCanvas,
  replaceCanvasNodeContent,
  snapshotCanvasNodeVersion,
} from "../src/whiteboard.js";

const [workspaceArgument, documentId, nodeId, artifactArgument] = process.argv.slice(2);
assert.ok(workspaceArgument && documentId && nodeId && artifactArgument,
  "用法：node scripts/apply-dreamina-card-verification.mjs <workspacePath> <documentId> <nodeId> <artifactRoot>");

const appRoot = process.cwd();
const workspacePath = resolve(workspaceArgument);
const artifactRoot = resolve(artifactArgument);
const imageEvidence = JSON.parse(await readFile(join(artifactRoot, "shensi-default-card-3images-20260904.json"), "utf8"));
const videoEvidence = JSON.parse(await readFile(join(artifactRoot, "shensi-default-card-video4s-20260904.json"), "utf8"));
assert.equal(imageEvidence.ok, true);
assert.equal(videoEvidence.ok, true);
assert.equal(imageEvidence.cardId, nodeId);
assert.equal(videoEvidence.cardId, nodeId);
assert.equal(imageEvidence.returnedImageCount, 3);
assert.ok(videoEvidence.durationSeconds >= 3.5 && videoEvidence.durationSeconds <= 5.5);

const imageJobId = `generation-dreamina-live-${imageEvidence.providerTaskId}`;
const videoJobId = `generation-dreamina-live-${videoEvidence.providerTaskId}`;
const normalizePath = (value) => String(value || "").replaceAll("\\", "/").toLocaleLowerCase();
const assetExists = (canvas, jobId, attachment) => normalizeCanvas(canvas).assets.some((asset) => (
  asset.generationJobId === jobId
  && normalizePath(asset.attachment?.relativePath) === normalizePath(attachment.relativePath)
));
const appendAssetOnce = (canvas, asset) => assetExists(canvas, asset.generationJobId, asset.attachment)
  ? normalizeCanvas(canvas)
  : appendCanvasAsset(canvas, asset);
const generatedAsset = ({ id, kind, prompt, elapsedMs, createdAt, attachment, jobId, nodeName, aspectRatio }) => ({
  id,
  kind,
  origin: "generated",
  text: "",
  prompt,
  elapsedMs,
  createdAt,
  sourceNodeId: nodeId,
  nodeName,
  source: "whiteboard",
  generationJobId: jobId,
  mediaBatchId: "",
  mediaBatchIndex: 1,
  mediaBatchTotal: 1,
  mediaBatchLabel: "",
  mediaBatchDirectory: relativeMediaDirectory,
  mediaBatchIndexPath: relativeMediaIndex,
  whiteboardMediaDirectory: relativeMediaDirectory,
  whiteboardMediaIndexPath: relativeMediaIndex,
  aspectRatio,
  attachment,
});

const imageAttachments = [];
for (let index = 0; index < imageEvidence.outputPaths.length; index += 1) {
  imageAttachments.push(await saveWorkspaceAttachmentFromPath({
    appRoot,
    requestedPath: workspacePath,
    sourcePath: imageEvidence.outputPaths[index],
    name: `神思生图-${imageJobId}${index ? `-${index + 1}` : ""}.png`,
    mimeType: "image/png",
    requireValidImage: true,
    stableName: true,
    whiteboardDocumentId: documentId,
    whiteboardMediaKind: "image",
  }));
}
const videoAttachment = await saveWorkspaceAttachmentFromPath({
  appRoot,
  requestedPath: workspacePath,
  sourcePath: videoEvidence.outputPath,
  name: `神思视频-${videoJobId}.mp4`,
  mimeType: "video/mp4",
  expectedDurationMs: Math.round(videoEvidence.durationSeconds * 1000),
  requirePlayableMedia: true,
  stableName: true,
  whiteboardDocumentId: documentId,
  whiteboardMediaKind: "video",
});

const imageIndex = await upsertWorkspaceWhiteboardMediaIndex({
  appRoot, requestedPath: workspacePath, documentId, nodeId, jobId: imageJobId,
  channel: "image", prompt: "一只白色小兔坐在晨光草地上，电影级写实动画质感，细节清晰，无文字无水印。",
  attachments: imageAttachments, completedAt: imageEvidence.completedAt,
});
const videoIndex = await upsertWorkspaceWhiteboardMediaIndex({
  appRoot, requestedPath: workspacePath, documentId, nodeId, jobId: videoJobId,
  channel: "video", prompt: "电影感雨夜街道，一盏暖色路灯照亮细雨，镜头缓慢向前推进，画面稳定、自然，无文字无水印。",
  attachments: [videoAttachment], completedAt: videoEvidence.completedAt,
});
const relativeMediaDirectory = String(videoIndex?.whiteboardMediaDirectory || imageIndex?.whiteboardMediaDirectory || "");
const relativeMediaIndex = String(videoIndex?.whiteboardMediaIndexPath || imageIndex?.whiteboardMediaIndexPath || "");
assert.ok(relativeMediaDirectory && relativeMediaIndex, "白板媒体索引未返回正式落盘位置");

let loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
assert.ok(loaded.state?.documents?.[documentId], "找不到目标白板文档");
assert.ok(normalizeCanvas(loaded.state.documents[documentId].canvas).nodes.some((node) => node.id === nodeId), "找不到目标卡片");
const imageExtraIds = [2, 3].map((index) => `${nodeId}-result-${imageJobId.slice(-8)}-${index}`);
const finalCanvas = normalizeCanvas(loaded.state.documents[documentId].canvas);
const finalTarget = finalCanvas.nodes.find((node) => node.id === nodeId);
const alreadyComplete = imageAttachments.every((attachment) => assetExists(finalCanvas, imageJobId, attachment))
  && imageExtraIds.every((id) => finalCanvas.nodes.some((node) => node.id === id))
  && assetExists(finalCanvas, videoJobId, videoAttachment)
  && finalTarget?.kind === "video"
  && normalizePath(finalTarget.file) === normalizePath(videoAttachment.relativePath);

if (!alreadyComplete) {
  assert.ok(!assetExists(finalCanvas, videoJobId, videoAttachment), "卡片回填处于非预期的部分完成状态，请先人工复核");
  const documentState = loaded.state.documents[documentId];
  let canvas = snapshotCanvasNodeVersion(documentState.canvas, nodeId, {
    id: `canvas-version-${imageJobId}`,
    createdAt: imageEvidence.completedAt,
    source: "whiteboard",
  });
  const imagePrompt = "一只白色小兔坐在晨光草地上，电影级写实动画质感，细节清晰，无文字无水印。";
  const imageNames = ["图片节点 131", "图片节点 132", "图片节点 133"];
  for (let index = 0; index < imageAttachments.length; index += 1) {
    canvas = appendAssetOnce(canvas, generatedAsset({
      id: `canvas-asset-${imageJobId}-${index + 1}`,
      kind: "image", prompt: imagePrompt,
      elapsedMs: Date.parse(imageEvidence.completedAt) - Date.parse(imageEvidence.submittedAt),
      createdAt: imageEvidence.completedAt, attachment: imageAttachments[index], jobId: imageJobId,
      nodeName: imageNames[index], aspectRatio: 1,
    }));
  }
  canvas = replaceCanvasNodeContent(canvas, nodeId, {
    kind: "image", name: imageNames[0], prompt: imagePrompt,
    elapsedMs: Date.parse(imageEvidence.completedAt) - Date.parse(imageEvidence.submittedAt),
    generationJobId: imageJobId, generationCreatedAt: imageEvidence.completedAt,
    generationProfile: { connectionId: "image-dreamina-default", model: imageEvidence.model },
    attachment: imageAttachments[0], aspectRatio: 1,
    mediaBatchDirectory: relativeMediaDirectory, mediaBatchIndexPath: relativeMediaIndex,
    whiteboardMediaDirectory: relativeMediaDirectory, whiteboardMediaIndexPath: relativeMediaIndex,
  });
  const anchor = normalizeCanvas(canvas).nodes.find((node) => node.id === nodeId);
  const incomingEdges = normalizeCanvas(canvas).edges.filter((edge) => edge.toNode === nodeId);
  for (let index = 1; index < imageAttachments.length; index += 1) {
    const extraNodeId = imageExtraIds[index - 1];
    if (!normalizeCanvas(canvas).nodes.some((node) => node.id === extraNodeId)) {
      canvas = addCanvasImageNode(canvas, {
        id: extraNodeId, file: imageAttachments[index].relativePath, name: imageNames[index],
        mimeType: "image/png", aspectRatio: 1,
        x: Number(anchor.x) + (Number(anchor.width) + 28) * index, y: Number(anchor.y), width: Number(anchor.width),
        generation: { channel: "image", prompt: imagePrompt,
          elapsedMs: Date.parse(imageEvidence.completedAt) - Date.parse(imageEvidence.submittedAt),
          jobId: imageJobId, createdAt: imageEvidence.completedAt,
          profile: { connectionId: "image-dreamina-default", model: imageEvidence.model } },
      });
      for (const edge of incomingEdges) canvas = addCanvasEdge(canvas, { ...edge, id: `${edge.id}-${extraNodeId}`, toNode: extraNodeId });
    }
  }
  documentState.canvas = canvas;
  documentState.updatedAt = imageEvidence.completedAt;
  await saveWorkspaceState({
    appRoot, requestedPath: workspacePath, state: loaded.state, expectedStateStamp: loaded.stateStamp,
    operationDocumentIds: [documentId],
  });

  loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  const videoDocument = loaded.state.documents[documentId];
  canvas = snapshotCanvasNodeVersion(videoDocument.canvas, nodeId, {
    id: `canvas-version-${videoJobId}`,
    createdAt: videoEvidence.completedAt,
    source: "whiteboard",
  });
  const videoPrompt = "电影感雨夜街道，一盏暖色路灯照亮细雨，镜头缓慢向前推进，画面稳定、自然，无文字无水印。";
  canvas = appendAssetOnce(canvas, generatedAsset({
    id: `canvas-asset-${videoJobId}`,
    kind: "video", prompt: videoPrompt,
    elapsedMs: Date.parse(videoEvidence.completedAt) - Date.parse(videoEvidence.submittedAt),
    createdAt: videoEvidence.completedAt, attachment: videoAttachment, jobId: videoJobId,
    nodeName: "视频节点 2", aspectRatio: 16 / 9,
  }));
  canvas = replaceCanvasNodeContent(canvas, nodeId, {
    kind: "video", name: "视频节点 2", prompt: videoPrompt,
    elapsedMs: Date.parse(videoEvidence.completedAt) - Date.parse(videoEvidence.submittedAt),
    generationJobId: videoJobId, generationCreatedAt: videoEvidence.completedAt,
    generationProfile: { connectionId: "video-dreamina-default", model: videoEvidence.model },
    attachment: videoAttachment, aspectRatio: 16 / 9,
    mediaBatchDirectory: relativeMediaDirectory, mediaBatchIndexPath: relativeMediaIndex,
    whiteboardMediaDirectory: relativeMediaDirectory, whiteboardMediaIndexPath: relativeMediaIndex,
  });
  videoDocument.canvas = canvas;
  videoDocument.updatedAt = videoEvidence.completedAt;
  await saveWorkspaceState({
    appRoot, requestedPath: workspacePath, state: loaded.state, expectedStateStamp: loaded.stateStamp,
    operationDocumentIds: [documentId],
  });
}

const reread = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
const persistedCanvas = normalizeCanvas(reread.state.documents[documentId].canvas);
const persistedTarget = persistedCanvas.nodes.find((node) => node.id === nodeId);
assert.equal(persistedTarget?.kind, "video");
assert.equal(normalizePath(persistedTarget.file), normalizePath(videoAttachment.relativePath));
assert.ok(imageAttachments.every((attachment) => assetExists(persistedCanvas, imageJobId, attachment)));
assert.ok(imageExtraIds.every((id) => persistedCanvas.nodes.some((node) => node.id === id)));
assert.ok(assetExists(persistedCanvas, videoJobId, videoAttachment));
process.stdout.write(`${JSON.stringify({
  ok: true, workspacePath, documentId, nodeId, imageJobId, videoJobId,
  imagePaths: imageAttachments.map((attachment) => attachment.relativePath),
  videoPath: videoAttachment.relativePath,
  finalNodeKind: persistedTarget.kind,
  finalNodeName: persistedTarget.name,
  finalNodeFile: persistedTarget.file,
  finalNodeDurationMs: persistedTarget.durationMs,
  assetCount: persistedCanvas.assets.length,
  readbackStateStamp: reread.stateStamp,
  sourceEvidence: [basename(imageEvidence.outputPath), basename(videoEvidence.outputPath)],
}, null, 2)}\n`);
