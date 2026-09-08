import assert from "node:assert/strict";
import { appendGenerationAsset, assetEventTimestamp, canonicalAssetEventIso, normalizeGenerationAsset } from "../src/whiteboard.js";

const uploadOnly = normalizeGenerationAsset({
  id: "upload-1",
  kind: "image",
  origin: "upload",
  uploadedAt: "2026-08-20T01:02:03.000Z",
  sourceEventAt: "2026-08-20T01:02:03.000Z",
  attachment: { relativePath: "assets/a.png", mimeType: "image/png" },
});
assert.equal(uploadOnly.createdAt, "2026-08-20T01:02:03.000Z", "上传资产必须以真实上传时间作为稳定排序时间");

const generatedOnly = normalizeGenerationAsset({
  id: "generated-1",
  kind: "video",
  origin: "generated",
  generationJobId: "job-1",
  completedAt: "2026-08-21T04:05:06.000Z",
  attachment: { relativePath: "assets/a.mp4", mimeType: "video/mp4" },
});
assert.equal(generatedOnly.createdAt, "2026-08-21T04:05:06.000Z", "生成资产必须以真实厂商完成时间作为稳定排序时间");

const original = normalizeGenerationAsset({
  id: "stable-1",
  kind: "image",
  origin: "upload",
  createdAt: "2026-08-01T00:00:00.000Z",
  uploadedAt: "2026-08-20T01:02:03.000Z",
  attachment: { relativePath: "assets/stable.png", mimeType: "image/png" },
});
assert.equal(original.createdAt, "2026-08-01T00:00:00.000Z", "已有真实时间不能因刷新、补绑或更新而被覆盖");
assert.equal(assetEventTimestamp(original), Date.parse("2026-08-01T00:00:00.000Z"));
assert.equal(assetEventTimestamp({}), 0, "未知时间不能伪造成当前时间");

const legacyMigrationTime = normalizeGenerationAsset({
  id: "conversation-asset-conversation-1784993311389-typm1-pending-image-1785003180160-q4pju-image-1",
  kind: "image",
  origin: "generated",
  createdAt: "2026-08-26T15:38:03.389Z",
  attachment: { relativePath: "assets/result.png", mimeType: "image/png" },
});
assert.equal(legacyMigrationTime.createdAt, "2026-07-25T18:13:00.160Z", "旧资产缺少事件时间时必须从稳定 ID 恢复，不得使用覆盖安装时间");

assert.equal(canonicalAssetEventIso({
  id: "pending-video-1785003180160-abcd",
  createdAt: "2026-07-25T23:13:00.160Z",
}), "2026-07-25T23:13:00.160Z", "正常的长时生成完成时间不得被 ID 时间覆盖");

assert.equal(canonicalAssetEventIso({
  id: "pending-image-1785003180160-abcd",
  createdAt: "2026-08-26T15:38:03.389Z",
  completedAt: "2026-07-25T18:18:00.160Z",
}), "2026-07-25T18:18:00.160Z", "明确的厂商完成时间必须高于 ID 恢复时间");

const originalEntry = normalizeGenerationAsset({
  id: "same-id",
  kind: "image",
  origin: "generated",
  createdAt: "2026-07-25T18:13:00.160Z",
  attachment: { relativePath: "assets/locked.png", mimeType: "image/png" },
});
const rewrittenEntry = appendGenerationAsset([originalEntry], {
  id: "same-id",
  kind: "image",
  origin: "generated",
  createdAt: "2026-08-26T15:38:03.389Z",
  attachment: { relativePath: "assets/locked.png", mimeType: "image/png" },
});
assert.equal(rewrittenEntry[0].createdAt, originalEntry.createdAt, "同一资产 ID 的重建不能覆盖已锁定的创建时间");

const attachmentStamped = normalizeGenerationAsset({
  id: "generated-with-attachment-time",
  kind: "image",
  origin: "generated",
  attachment: {
    relativePath: "assets/stamped.png",
    mimeType: "image/png",
    createdAt: "2026-08-21T04:05:06.000Z",
    sourceEventAt: "2026-08-21T04:05:06.000Z",
  },
});
assert.equal(attachmentStamped.createdAt, "2026-08-21T04:05:06.000Z", "附件自身的持久化时间必须能恢复资产时间");

console.log("v3.0 资产真实时间稳定性测试通过");
