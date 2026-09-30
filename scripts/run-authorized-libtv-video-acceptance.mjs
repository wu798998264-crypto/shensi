import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readFile as readText } from "node:fs/promises";
import { createBlankProjectState } from "../src/data.js";

const origin = String(process.env.SHENSI_ACCEPTANCE_ORIGIN || "").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
const profilesPath = String(process.env.SHENSI_ACCEPTANCE_PROFILE_STORE || "E:\\ShensiUserData\\config\\generation-profiles-v1.json");
const stored = JSON.parse(await readText(profilesPath, "utf8"));
const profile = (stored.settings?.videoConnections || []).find((item) => item.id === "video-libtv");
assert.ok(profile, "video-libtv 配置不存在");
const sessionHtml = await fetch(`${origin}/?acceptance=${Date.now()}`).then((response) => response.text());
const sessionToken = sessionHtml.match(/name="shensi-session-token" content="([^"]+)"/u)?.[1] || "";
assert.ok(sessionToken, "未取得本机会话令牌");
const api = async (pathname, body, method = "POST") => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { origin, "x-shensi-session": sessionToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(`${pathname}: ${payload.message || payload.code || response.status}`);
  return payload;
};
const created = await api("/api/projects/create", { name: `LibTV 4秒视频验收-${Date.now()}` });
const workspacePath = created.project?.workspacePath || created.project?.path;
assert.ok(workspacePath);
const documentId = "authorized-libtv-video-acceptance";
const nodeId = "authorized-libtv-video-node";
const state = createBlankProjectState({ name: "LibTV 4秒视频验收", workspacePath });
state.documents[documentId] = { title: "LibTV 4秒视频验收", documentKind: "whiteboard", moduleId: "manuscript", workspaceView: "novel", canvas: { nodes: [{ id: nodeId, type: "file", kind: "video", x: 20, y: 20, width: 320, height: 220, name: "LibTV 4秒视频", generationJobId: "", generationType: "video" }], edges: [], assets: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: { snapToGrid: true, gridSize: 20 } } };
state.moduleItems.manuscript.push([documentId, state.documents[documentId].title, { workspaceView: "novel" }]);
await api("/api/workspace/save", { workspacePath, state, operationDocumentIds: [documentId] });
const settings = Object.fromEntries(Object.entries(profile).filter(([key]) => !/key|secret|token|authorization/iu.test(key)));
settings.model = String(process.env.SHENSI_ACCEPTANCE_VIDEO_MODEL || "wanx3.0");
const submissionId = `authorized-libtv-video-${randomUUID()}`;
const submitted = await api("/api/generation/jobs/media", { channel: "video", submissionId, target: { workspaceKind: "project", workspacePath, documentId, nodeId, targetType: "whiteboard-node" }, request: { prompt: "白色摄影棚中的银色方块缓慢旋转，产品展示，稳定镜头，无文字无水印", executionPrompt: "白色摄影棚中的银色方块缓慢旋转，产品展示，稳定镜头，无文字无水印", aspectRatio: "16:9", resolution: "720p", duration: 4, generateAudio: false, settings } });
let job = submitted.job;
const deadline = Date.now() + Math.max(180_000, Number(process.env.SHENSI_ACCEPTANCE_JOB_TIMEOUT_MS) || 15 * 60_000);
while (!["complete", "failed", "retry_required", "cancelled"].includes(job.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  job = (await api(`/api/generation/jobs/${encodeURIComponent(job.id)}`, undefined, "GET")).job;
}
const result = { jobId: job.id, status: job.status, providerTaskId: job.providerTaskId || "", providerStatus: job.providerStatus || "", providerErrorCode: job.providerErrorCode || "", error: job.error || "", elapsedMs: Date.now() - (job.createdAt ? new Date(job.createdAt).getTime() : Date.now()), result: job.result || null };
if (job.status === "complete" && job.result?.attachment?.relativePath) {
  const bytes = await readFile(`${workspacePath}\\${job.result.attachment.relativePath}`);
  result.bytes = bytes.length;
  result.sha256 = createHash("sha256").update(bytes).digest("hex");
  result.sha256Matches = result.sha256 === job.result.attachment.sha256;
}
console.log(JSON.stringify({ ok: job.status === "complete" && result.sha256Matches === true, workspacePath, profileId: profile.id, requestedModel: settings.model, ...result }, null, 2));
process.exitCode = job.status === "complete" && result.sha256Matches === true ? 0 : 1;
