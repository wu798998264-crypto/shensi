import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBlankProjectState } from "../src/data.js";

if (process.env.SHENSI_RUN_PAID_MEDIA_ACCEPTANCE !== "1") {
  console.log("跳过真实图片配置验收：需显式设置 SHENSI_RUN_PAID_MEDIA_ACCEPTANCE=1");
  process.exit(0);
}

const origin = String(process.env.SHENSI_ACCEPTANCE_ORIGIN || "").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u, "验收必须使用本机安装版服务");
const profileStorePath = String(process.env.SHENSI_ACCEPTANCE_PROFILE_STORE || "E:\\ShensiUserData\\config\\generation-profiles-v1.json");
const brokerLeasePath = join(dirname(profileStorePath), "dreamina-broker-lease-v1.json");
const jobTimeoutMs = Math.max(60_000, Number(process.env.SHENSI_ACCEPTANCE_JOB_TIMEOUT_MS) || 15 * 60_000);
const pollMs = Math.max(500, Number(process.env.SHENSI_ACCEPTANCE_POLL_MS) || 2_500);
const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const terminalStatuses = new Set(["complete", "failed", "retry_required", "cancelled"]);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const stored = JSON.parse(await readFile(profileStorePath, "utf8"));
const imageProfiles = new Map((stored.settings?.imageConnections || []).map((profile) => [profile.id, profile]));
const defaultPlan = [
  { id: "image-dreamina-cli-xiaoyujie", count: 1, phase: "second-pass" },
  { id: "image-dreamina-cli-guobazai", count: 2, phase: "two-per-profile" },
  { id: "image-dreamina-cli-chenan", count: 2, phase: "two-per-profile" },
  { id: "image-dreamina-cli-tashuo-juyougeng", count: 2, phase: "two-per-profile" },
  { id: "image-dreamina-cli-duanju-zuiqianxian", count: 2, phase: "two-per-profile" },
  { id: "image-dreamina-cli-yinou-shijie", count: 2, phase: "two-per-profile" },
  { id: "image-libtv", count: 2, phase: "two-per-profile" },
  { id: "image-dreamina-cli-xiaoyujie", count: 5, phase: "five-image-persistence" },
];
const plan = process.env.SHENSI_ACCEPTANCE_PLAN
  ? JSON.parse(process.env.SHENSI_ACCEPTANCE_PLAN)
  : defaultPlan;
for (const entry of plan) assert.ok(imageProfiles.has(entry.id), `图片配置不存在：${entry.id}`);

let sessionToken = "";
const refreshSession = async () => {
  const html = await fetch(`${origin}/?acceptance=${Date.now()}`).then((response) => response.text());
  sessionToken = html.match(/name="shensi-session-token" content="([^"]+)"/u)?.[1] || "";
  assert.ok(sessionToken, "安装版服务未返回本地会话令牌");
};
await refreshSession();

const api = async (pathname, { method = "POST", body } = {}, retried = false) => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin,
      "x-shensi-session": sessionToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${pathname} 返回非 JSON：${text.slice(0, 500)}`); }
  if (response.status === 403 && payload.code === "LOCAL_SESSION_EXPIRED" && !retried) {
    await refreshSession();
    return api(pathname, { method, body }, true);
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(`${pathname}: ${payload.message || payload.code || response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
};

const projectName = `7.7.6-图片配置串行持久化验收-${runId}`;
const created = await api("/api/projects/create", { body: { name: projectName } });
const workspacePath = created.project?.workspacePath || created.project?.path;
assert.ok(workspacePath, "安装版未返回验收作品路径");
const documentId = "installed-image-profile-acceptance";
const cases = plan.flatMap((entry) => Array.from({ length: entry.count }, (_, index) => ({
  ...entry,
  index: index + 1,
  nodeId: `acceptance-${entry.phase}-${entry.id}-${index + 1}`,
})));
const state = createBlankProjectState({ name: projectName, workspacePath });
state.documents[documentId] = {
  title: "安装版图片配置串行验收",
  documentKind: "whiteboard",
  moduleId: "manuscript",
  workspaceView: "novel",
  placementOverride: true,
  canvas: {
    nodes: cases.map((item, index) => ({
      id: item.nodeId,
      type: "file",
      kind: "image",
      x: 24 + (index % 4) * 360,
      y: 24 + Math.floor(index / 4) * 360,
      width: 320,
      height: 320,
      name: `${imageProfiles.get(item.id)?.remarkName || item.id}-${item.phase}-${item.index}`,
      generationJobId: "",
      generationType: "image",
    })),
    edges: [],
    assets: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { snapToGrid: true, gridSize: 20 },
  },
};
state.moduleItems.manuscript.push([documentId, "安装版图片配置串行验收", { workspaceView: "novel" }]);
await api("/api/workspace/save", { body: { workspacePath, state, operationDocumentIds: [documentId] } });

const waitForDreaminaLockRelease = async (profile) => {
  if (!(profile.provider === "即梦" && profile.adapter === "cli")) return { released: true, waitedMs: 0 };
  const startedAt = Date.now();
  let quietSince = 0;
  while (Date.now() - startedAt < 60_000) {
    const occupants = await api("/api/dreamina-profiles/lock-occupants", { method: "GET" });
    const brokerLease = await readFile(brokerLeasePath, "utf8").then((value) => JSON.parse(value)).catch((error) => {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    });
    const taskLocksEmpty = !Array.isArray(occupants.jobs) || occupants.jobs.length === 0;
    if (taskLocksEmpty && !brokerLease) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 5_000) return { released: true, waitedMs: Date.now() - startedAt };
    } else {
      quietSince = 0;
    }
    await sleep(500);
  }
  return { released: false, waitedMs: Date.now() - startedAt };
};

const readCardReceipt = async ({ nodeId, jobId, attachment }) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const loaded = await api("/api/workspace/load", { body: { workspacePath } });
    const canvas = loaded.state?.documents?.[documentId]?.canvas;
    const card = canvas?.nodes?.find((item) => item.id === nodeId);
    const asset = canvas?.assets?.find((item) => item.generationJobId === jobId);
    const fileMatches = String(card?.file || "").replaceAll("\\", "/") === String(attachment?.relativePath || "").replaceAll("\\", "/");
    if (card?.generation?.jobId === jobId && asset?.attachment?.sha256 === attachment?.sha256 && fileMatches) {
      return { verified: true, card, asset, stateStamp: loaded.stateStamp };
    }
    await sleep(500);
  }
  return { verified: false };
};

const publicSettings = (profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => !/key|secret|token|authorization/iu.test(key)));
const results = [];
let stopReason = "";
for (let caseIndex = 0; caseIndex < cases.length && !stopReason; caseIndex += 1) {
  const item = cases[caseIndex];
  const profile = imageProfiles.get(item.id);
  const label = String(profile.remarkName || profile.name || profile.id);
  const submissionId = `installed-${runId}-${caseIndex + 1}-${randomUUID()}`;
  const prompt = `神思安装版串行验收图 ${label} ${item.phase} ${item.index}：白色摄影棚内一个${caseIndex % 2 ? "青绿色圆环" : "银色方块"}，旁边放一颗红色五角星，写实产品摄影，无文字无水印。`;
  const startedAt = Date.now();
  let job;
  let duplicateReused = false;
  try {
    const request = {
      prompt,
      executionPrompt: prompt,
      aspectRatio: "1:1",
      quality: profile.provider === "即梦" ? "1k" : "standard",
      resolution: profile.provider === "即梦" ? "1k" : "standard",
      imageCount: 1,
      settings: publicSettings(profile),
    };
    const target = { workspaceKind: "project", workspacePath, documentId, nodeId: item.nodeId, targetType: "whiteboard-node" };
    const submitted = await api("/api/generation/jobs/media", { body: { channel: "image", submissionId, target, request } });
    job = submitted.job;
    const duplicate = await api("/api/generation/jobs/media", { body: { channel: "image", submissionId, target, request } });
    duplicateReused = duplicate.job?.id === job.id && duplicate.reused === true;
    const deadline = Date.now() + jobTimeoutMs;
    while (!terminalStatuses.has(job.status) && Date.now() < deadline) {
      await sleep(pollMs);
      job = (await api(`/api/generation/jobs/${encodeURIComponent(job.id)}`, { method: "GET" })).job;
    }
    if (!terminalStatuses.has(job.status)) {
      stopReason = `${label} 的任务 ${job.id} 在 ${Math.ceil(jobTimeoutMs / 60_000)} 分钟内没有返回终态`;
      results.push({ profileId: profile.id, label, phase: item.phase, index: item.index, jobId: job.id, status: "timeout", providerTaskId: job.providerTaskId || "", elapsedMs: Date.now() - startedAt });
      break;
    }
    const lock = await waitForDreaminaLockRelease(profile);
    const base = {
      profileId: profile.id,
      label,
      provider: profile.provider,
      phase: item.phase,
      index: item.index,
      jobId: job.id,
      providerTaskId: job.providerTaskId || "",
      status: job.status,
      providerStatus: job.providerStatus || "",
      providerErrorCode: job.providerErrorCode || "",
      error: job.error || "",
      identityKey: job.profileIdentityKey || "",
      identityVerified: job.profileIdentityVerified === true,
      duplicateReused,
      creditCount: Number(job.providerCreditCount) || 0,
      elapsedMs: Date.now() - startedAt,
      lockReleased: lock.released,
      lockReleaseWaitMs: lock.waitedMs,
    };
    if (job.status !== "complete") {
      results.push(base);
      if (!lock.released || job.billingRisk === "submission_outcome_unknown") stopReason = `${label} 存在未释放锁或提交结果不明，停止账号切换`;
      continue;
    }
    const attachment = job.result?.attachment;
    assert.ok(attachment?.relativePath && attachment?.sha256, `${label} 完成任务缺少附件收据`);
    const absolutePath = join(workspacePath, attachment.relativePath);
    const bytes = await readFile(absolutePath);
    const metadata = await stat(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const cardReceipt = await readCardReceipt({ nodeId: item.nodeId, jobId: job.id, attachment });
    results.push({
      ...base,
      bytes: metadata.size,
      sha256,
      sha256Matches: sha256 === attachment.sha256,
      width: Number(attachment.imageWidth) || 0,
      height: Number(attachment.imageHeight) || 0,
      relativePath: attachment.relativePath,
      cardReadbackVerified: cardReceipt.verified,
      appliedAt: job.appliedAt || "",
    });
    if (!lock.released) stopReason = `${label} 已完成但即梦锁未释放，停止账号切换`;
  } catch (error) {
    const lock = await waitForDreaminaLockRelease(profile).catch(() => ({ released: false, waitedMs: 0 }));
    results.push({
      profileId: profile.id,
      label,
      provider: profile.provider,
      phase: item.phase,
      index: item.index,
      jobId: job?.id || "",
      status: "acceptance_error",
      providerTaskId: job?.providerTaskId || "",
      error: error.message,
      response: error.payload || null,
      elapsedMs: Date.now() - startedAt,
      lockReleased: lock.released,
      lockReleaseWaitMs: lock.waitedMs,
    });
    if (!lock.released || job?.billingRisk === "submission_outcome_unknown") stopReason = `${label} 验收异常且无法确认安全切换账号`;
  }
  console.log(JSON.stringify({ progress: caseIndex + 1, total: cases.length, result: results.at(-1), stopReason }));
}

const report = {
  ok: !stopReason && results.length === cases.length && results.every((item) => item.status === "complete" && item.sha256Matches && item.cardReadbackVerified && item.lockReleased),
  runId,
  origin,
  projectName,
  workspacePath,
  planned: cases.length,
  completed: results.length,
  stopReason,
  results,
};
const reportPath = join(workspacePath, ".shensi", `installed-image-profile-acceptance-${runId}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (!report.ok) process.exitCode = 1;
