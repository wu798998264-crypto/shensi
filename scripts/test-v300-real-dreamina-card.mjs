import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createBlankProjectState } from "../src/data.js";

// This is intentionally opt-in: it creates one real, billable Dreamina image
// only when the operator explicitly supplies both switches and an isolated
// server origin.  It never loads or writes the user's normal workspace.
if (process.env.SHENSI_RUN_PAID_MEDIA_ACCEPTANCE !== "1") {
  console.log("跳过真实即梦验收：需显式设置 SHENSI_RUN_PAID_MEDIA_ACCEPTANCE=1");
  process.exit(0);
}

const origin = String(process.env.SHENSI_ACCEPTANCE_ORIGIN || "").replace(/\/$/, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u, "验收必须使用本机隔离服务");
const profileId = String(process.env.SHENSI_DREAMINA_ACCEPTANCE_PROFILE || "default").trim() || "default";
const connectionId = String(process.env.SHENSI_DREAMINA_ACCEPTANCE_CONNECTION || "image-dreamina-cli").trim() || "image-dreamina-cli";
const profileLabel = String(process.env.SHENSI_DREAMINA_ACCEPTANCE_LABEL || profileId).trim() || profileId;
const model = String(process.env.SHENSI_DREAMINA_ACCEPTANCE_MODEL || "5.0").trim() || "5.0";
const resolution = model === "5.0Pro" ? "1.5k" : model === "3.0" || model === "3.1" ? "1k" : "2k";

const index = await fetch(`${origin}/`).then((response) => response.text());
const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(token, "隔离服务必须提供会话令牌");
const headers = { "content-type": "application/json", origin, "x-shensi-session": token };
const request = async (pathname, body = undefined, method = "POST") => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(`${pathname}: ${payload.message || payload.code || response.status}`);
  return payload;
};

const runId = randomUUID().slice(0, 8);
const project = await request("/api/projects/create", { name: `v3.0-即梦闭环验收-${profileId}-${runId}` });
const workspacePath = project.project?.path || project.project?.workspacePath;
assert.ok(workspacePath, "隔离验收作品必须有工作区路径");
const documentId = "v300-real-whiteboard";
const nodeId = "v300-real-image-card";
const state = createBlankProjectState({ name: `v3.0-即梦闭环验收-${profileId}-${runId}`, workspacePath });
state.documents[documentId] = {
  title: "即梦闭环验收白板",
  documentKind: "whiteboard",
  moduleId: "manuscript",
  workspaceView: "novel",
  placementOverride: true,
  canvas: {
    nodes: [{ id: nodeId, type: "file", x: 24, y: 24, width: 320, height: 200, name: "等待验收图片", generationJobId: "", generationType: "image" }],
    edges: [], assets: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: { snapToGrid: true, gridSize: 20 },
  },
};
state.moduleItems.manuscript.push([documentId, "即梦闭环验收白板", { workspaceView: "novel" }]);
await request("/api/workspace/save", { workspacePath, state, operationDocumentIds: [documentId] });

const submissionId = `v300-real-${runId}`;
const payload = {
  channel: "image",
  submissionId,
  target: { workspaceKind: "project", workspacePath, documentId, nodeId, targetType: "whiteboard-node" },
  request: {
    prompt: `用于软件功能验收的一张极简白色几何方块图片，纯色背景，无文字、无人像。配置标识：${profileId}。`,
    executionPrompt: `用于软件功能验收的一张极简白色几何方块图片，纯色背景，无文字、无人像。配置标识：${profileId}。`,
    aspectRatio: "1:1", quality: resolution, imageCount: 1,
    settings: {
      id: connectionId, connectionId, name: profileLabel, adapter: "cli", provider: "即梦", protocol: "images",
      model, dreaminaCliProfile: profileId, cliPath: "shensi-dreamina-image",
    },
  },
};
const submitted = await request("/api/generation/jobs/media", payload);
const duplicate = await request("/api/generation/jobs/media", payload);
assert.equal(duplicate.job?.id, submitted.job?.id, "同一 submissionId 必须复用原收费任务");
const jobId = submitted.job?.id;
assert.ok(jobId, "必须创建后台任务");

let job = submitted.job;
const deadline = Date.now() + 20 * 60_000;
while (!["complete", "failed", "retry_required", "cancelled"].includes(job.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  job = await request(`/api/generation/jobs/${encodeURIComponent(jobId)}`, undefined, "GET").then((result) => result.job);
}
assert.equal(job.status, "complete", `真实即梦任务未完成：${job.error || job.status}`);
assert.ok(job.result?.attachment?.relativePath && job.result?.attachment?.sha256, "完成任务必须保存媒体附件收据");

// Reproduce the production landing sequence: persist the card reference,
// reload the workspace, and use that real readback as the applied receipt.
const loaded = await request("/api/workspace/load", { workspacePath });
const assetId = `asset-${jobId}`;
const attachment = job.result.attachment;
const canvas = loaded.state.documents[documentId].canvas;
canvas.assets.push({ id: assetId, name: "即梦闭环验收图片", type: "image", source: "generation", relativePath: attachment.relativePath, sha256: attachment.sha256, generationJobId: jobId });
const card = canvas.nodes.find((item) => item.id === nodeId);
card.assetId = assetId;
card.generationJobId = jobId;
card.relativePath = attachment.relativePath;
card.name = "即梦闭环验收图片";
await request("/api/workspace/save", { workspacePath, state: loaded.state, expectedStateStamp: loaded.stateStamp, operationDocumentIds: [documentId] });
const reread = await request("/api/workspace/load", { workspacePath });
const persistedCard = reread.state.documents[documentId].canvas.nodes.find((item) => item.id === nodeId);
assert.equal(persistedCard.assetId, assetId, "卡片资产引用必须完成持久化回读");
assert.equal(persistedCard.generationJobId, jobId, "卡片必须保留原任务标识");
const applied = await request(`/api/generation/jobs/${encodeURIComponent(jobId)}/applied`, {
  resultAssetId: assetId,
  cardReadback: { verified: true, workspacePath, documentId, nodeId, generationJobId: jobId, resultAssetId: assetId, verifiedAt: new Date().toISOString() },
});
assert.ok(applied.job?.cardReadbackVerified && applied.job?.appliedAt, "只有卡片回读后才能报告用户完成");
const attachmentHash = createHash("sha256").update(String(attachment.sha256)).digest("hex").slice(0, 12);
console.log(JSON.stringify({
  ok: true, profileId, profileLabel, connectionId, model, resolution, jobId,
  duplicateReused: duplicate.reused === true, providerTerminal: Boolean(applied.job?.providerTerminalAt),
  assetSaved: Boolean(applied.job?.assetSavedAt), cardReadbackVerified: applied.job?.cardReadbackVerified === true,
  lifecycle: applied.job?.mediaResultLifecycleStage || "", attachmentHash,
}));
