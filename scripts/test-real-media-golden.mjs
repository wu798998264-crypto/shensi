import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createBlankProjectState } from "../src/data.js";

if (process.env.SHENSI_RUN_PAID_MEDIA_ACCEPTANCE !== "1"
  || process.env.SHENSI_PAID_MEDIA_CONFIRMATION !== "ONE_IMAGE_ONE_SHORTEST_VIDEO") {
  console.log("跳过真实媒体验收：缺少单图与最短视频的显式授权开关");
  process.exit(0);
}

const origin = String(process.env.SHENSI_ACCEPTANCE_ORIGIN || "").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u, "验收必须使用本机隔离服务");
const profileId = String(process.env.SHENSI_DREAMINA_ACCEPTANCE_PROFILE || "").trim();
const profileLabel = String(process.env.SHENSI_DREAMINA_ACCEPTANCE_LABEL || profileId).trim();
assert.ok(profileId && profileId !== "duanju-zuiqianxian", "真实验收必须指定非“短剧最前线”的现有配置");

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
  if (!response.ok || payload.ok === false) {
    throw new Error(`${pathname}: ${payload.code || response.status} ${payload.message || "请求失败"}`);
  }
  return payload;
};

const waitForTerminal = async (job) => {
  const deadline = Date.now() + 20 * 60_000;
  let current = job;
  while (!["complete", "failed", "retry_required", "reconciliation_required", "waiting_credentials", "cancelled"].includes(current.status)
    && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
    current = await request(`/api/generation/jobs/${encodeURIComponent(current.id)}`, undefined, "GET").then((result) => result.job);
  }
  assert.equal(current.status, "complete", `${current.channel} 真实任务未完成：${current.providerErrorCode || ""} ${current.error || current.status}`);
  assert.ok(current.result?.attachment?.relativePath, "完成任务必须返回已保存附件路径");
  assert.match(String(current.result.attachment.sha256 || ""), /^[a-f0-9]{64}$/u, "完成任务必须返回 SHA-256");
  return current;
};

const verifyAttachment = async ({ workspacePath, documentId, attachment }) => {
  const path = `/api/workspace/attachment-content?workspacePath=${encodeURIComponent(workspacePath)}&documentId=${encodeURIComponent(documentId)}&relativePath=${encodeURIComponent(attachment.relativePath)}`;
  const response = await fetch(`${origin}${path}`, { headers: { origin, "x-shensi-session": token } });
  assert.equal(response.ok, true, `无法回读生成附件：${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 0, "生成附件不能为空");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), attachment.sha256, "生成附件 SHA-256 必须通过独立回读验收");
  return bytes.byteLength;
};

const applyToCard = async ({ workspacePath, documentId, nodeId, job, type, name }) => {
  const loaded = await request("/api/workspace/load", { workspacePath });
  const assetId = `asset-${job.id}`;
  const canvas = loaded.state.documents[documentId].canvas;
  canvas.assets.push({
    id: assetId,
    name,
    type,
    source: "generation",
    relativePath: job.result.attachment.relativePath,
    sha256: job.result.attachment.sha256,
    generationJobId: job.id,
  });
  const card = canvas.nodes.find((item) => item.id === nodeId);
  card.assetId = assetId;
  card.generationJobId = job.id;
  card.relativePath = job.result.attachment.relativePath;
  card.name = name;
  await request("/api/workspace/save", {
    workspacePath,
    state: loaded.state,
    expectedStateStamp: loaded.stateStamp,
    operationDocumentIds: [documentId],
  });
  const reread = await request("/api/workspace/load", { workspacePath });
  const persistedCard = reread.state.documents[documentId].canvas.nodes.find((item) => item.id === nodeId);
  assert.equal(persistedCard.assetId, assetId);
  assert.equal(persistedCard.generationJobId, job.id);
  const applied = await request(`/api/generation/jobs/${encodeURIComponent(job.id)}/applied`, {
    resultAssetId: assetId,
    cardReadback: {
      verified: true,
      workspacePath,
      documentId,
      nodeId,
      generationJobId: job.id,
      resultAssetId: assetId,
      verifiedAt: new Date().toISOString(),
    },
  });
  assert.equal(applied.job?.cardReadbackVerified, true);
  return applied.job;
};

const runId = randomUUID().slice(0, 8);
let workspacePath = "";
try {
  const projectName = `白板黄金真实验收-${runId}`;
  const project = await request("/api/projects/create", { name: projectName });
  workspacePath = project.project?.path || project.project?.workspacePath;
  assert.ok(workspacePath);
  const documentId = "whiteboard-golden-real-media";
  const imageNodeId = "golden-image-card";
  const videoNodeId = "golden-video-card";
  const state = createBlankProjectState({ name: projectName, workspacePath });
  state.documents[documentId] = {
    title: "白板黄金真实验收",
    documentKind: "whiteboard",
    moduleId: "manuscript",
    workspaceView: "novel",
    placementOverride: true,
    canvas: {
      nodes: [
        { id: imageNodeId, type: "file", x: 24, y: 24, width: 320, height: 200, name: "等待验收图片", generationJobId: "", generationType: "image" },
        { id: videoNodeId, type: "file", x: 384, y: 24, width: 320, height: 200, name: "等待验收视频", generationJobId: "", generationType: "video" },
      ],
      edges: [], assets: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: { snapToGrid: true, gridSize: 20 },
    },
  };
  state.moduleItems.manuscript.push([documentId, "白板黄金真实验收", { workspaceView: "novel" }]);
  await request("/api/workspace/save", { workspacePath, state, operationDocumentIds: [documentId] });

  const imageSubmissionId = `golden-image-${runId}`;
  const imagePrompt = "一枚简洁的白色几何立方体置于浅灰背景中央，柔和棚拍光，无文字，无人物";
  const imagePayload = {
    channel: "image",
    submissionId: imageSubmissionId,
    target: { workspaceKind: "project", workspacePath, documentId, nodeId: imageNodeId, targetType: "whiteboard-node" },
    request: {
      prompt: imagePrompt,
      executionPrompt: imagePrompt,
      aspectRatio: "1:1",
      quality: "2k",
      imageCount: 1,
      settings: {
        id: `image-dreamina-cli-${profileId}`,
        connectionId: `image-dreamina-cli-${profileId}`,
        name: profileLabel,
        remarkName: profileLabel,
        adapter: "cli",
        provider: "即梦",
        protocol: "images",
        model: "5.0",
        dreaminaCliProfile: profileId,
        cliPath: "shensi-dreamina-image",
      },
    },
  };
  const imageSubmitted = await request("/api/generation/jobs/media", imagePayload);
  const imageDuplicate = await request("/api/generation/jobs/media", imagePayload);
  assert.equal(imageDuplicate.job?.id, imageSubmitted.job?.id, "重复图片提交必须复用同一收费任务");
  const imageJob = await waitForTerminal(imageSubmitted.job);
  const imageBytes = await verifyAttachment({ workspacePath, documentId, attachment: imageJob.result.attachment });
  const appliedImage = await applyToCard({ workspacePath, documentId, nodeId: imageNodeId, job: imageJob, type: "image", name: "黄金验收图片" });

  const videoSubmissionId = `golden-video-${runId}`;
  const videoPrompt = "一枚白色几何立方体在浅灰背景上缓慢旋转，固定镜头，动作平稳，无文字，无人物";
  const videoPayload = {
    channel: "video",
    submissionId: videoSubmissionId,
    target: { workspaceKind: "project", workspacePath, documentId, nodeId: videoNodeId, targetType: "whiteboard-node" },
    request: {
      prompt: videoPrompt,
      executionPrompt: videoPrompt,
      aspectRatio: "16:9",
      duration: "4",
      resolution: "720p",
      mode: "smart_params",
      settings: {
        id: `video-dreamina-cli-${profileId}`,
        connectionId: `video-dreamina-cli-${profileId}`,
        name: profileLabel,
        remarkName: profileLabel,
        adapter: "cli",
        provider: "即梦",
        protocol: "videos",
        model: "seedance2.5",
        dreaminaCliProfile: profileId,
        cliPath: "shensi-dreamina-video",
      },
    },
  };
  const videoSubmitted = await request("/api/generation/jobs/media", videoPayload);
  const videoDuplicate = await request("/api/generation/jobs/media", videoPayload);
  assert.equal(videoDuplicate.job?.id, videoSubmitted.job?.id, "重复视频提交必须复用同一收费任务");
  const videoJob = await waitForTerminal(videoSubmitted.job);
  assert.equal(videoJob.result?.attachment?.mimeType, "video/mp4", "真实视频必须保存为可播放的 MP4");
  assert.equal(videoJob.result?.attachment?.videoCodec, "h264", "真实视频必须通过 H.264 视频流解析");
  assert.ok(Number(videoJob.result?.attachment?.videoFrameCountRead || 0) > 0, "真实视频必须能够逐帧读取");
  assert.equal(Number(videoJob.result?.attachment?.videoWidth || 0), 1280, "720p 横屏视频宽度必须为 1280");
  assert.equal(Number(videoJob.result?.attachment?.videoHeight || 0), 720, "720p 横屏视频高度必须为 720");
  assert.ok(Number(videoJob.result?.attachment?.durationMs || 0) >= 3_500, "最短视频必须包含完整的有效时长");
  const videoBytes = await verifyAttachment({ workspacePath, documentId, attachment: videoJob.result.attachment });
  const appliedVideo = await applyToCard({ workspacePath, documentId, nodeId: videoNodeId, job: videoJob, type: "video", name: "黄金验收最短视频" });

  console.log(JSON.stringify({
    ok: true,
    profileId,
    profileLabel,
    image: { jobId: imageJob.id, bytes: imageBytes, sha256: imageJob.result.attachment.sha256, lifecycle: appliedImage.mediaResultLifecycleStage },
    video: { jobId: videoJob.id, bytes: videoBytes, sha256: videoJob.result.attachment.sha256, durationSeconds: 4, resolution: "720p", lifecycle: appliedVideo.mediaResultLifecycleStage },
  }, null, 2));
} finally {
  if (workspacePath) await request("/api/projects/delete", { workspacePath }).catch(() => {});
}
