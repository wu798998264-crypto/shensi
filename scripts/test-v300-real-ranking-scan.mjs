import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Opt-in external acceptance.  It requests only public pages, uses no login
// state, and records a candidate-only report in the isolated runtime.
if (process.env.SHENSI_RUN_NETWORK_ACCEPTANCE !== "1") {
  console.log("跳过真实扫榜验收：需显式设置 SHENSI_RUN_NETWORK_ACCEPTANCE=1");
  process.exit(0);
}

const origin = String(process.env.SHENSI_ACCEPTANCE_ORIGIN || "").replace(/\/$/, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u, "验收必须使用本机隔离服务");
const index = await fetch(`${origin}/`).then((response) => response.text());
const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(token, "服务会话令牌缺失");
const headers = { "content-type": "application/json", origin, "x-shensi-session": token };
const post = async (path, body) => {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(`${path}: ${payload.message || payload.code || response.status}`);
  return payload;
};
const get = async (path) => {
  const response = await fetch(`${origin}${path}`, { headers: { origin, "x-shensi-session": token } });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(`${path}: ${payload.message || payload.code || response.status}`);
  return payload;
};

const sources = await get("/api/ranking-scan/sources");
assert.ok(sources.sources.some((item) => item.id === "qidian" && item.requiresLogin === false), "公开扫榜来源目录不完整");
// Select Codex only inside this isolated server data root.  No user profile,
// project, credential, or model-setting file is touched.
const acceptanceProject = await post("/api/projects/create", { name: `v3.0-扫榜验收-${randomUUID().slice(0, 8)}` });
const acceptanceCwd = acceptanceProject.project?.path || acceptanceProject.project?.workspacePath;
assert.ok(acceptanceCwd, "隔离扫榜验收项目必须创建成功");
await post("/api/codex-agent/project", { cwd: acceptanceCwd, selectionMode: "workspace" });
await post("/api/codex-agent/engine", { engine: "codex" });
await post("/api/codex-agent/model", { model: "gpt-5.6-sol" });
const agentProfile = {
  id: "v300-codex-network-acceptance", connectionId: "v300-codex-network-acceptance",
  provider: "OpenAI", adapter: "cli", protocol: "responses", executionMode: "agent", executionModes: ["agent"],
  agentEngine: "codex", model: "gpt-5.6-sol", cliPath: "codex",
};
const started = await post("/api/ranking-scan/start", {
  id: `v300-live-ranking-${randomUUID().slice(0, 8)}`,
  workspaceId: "v300-isolated-network-acceptance", sourceMessageId: "v300-operator-approved",
  userStarted: true, scanType: "long", platforms: ["qidian"], rankings: ["monthly"], topN: 15,
  acquisitionMode: "direct", allowBrowserAccess: true, allowSnapshotWrite: true,
  requestedAgentProfileId: agentProfile.id,
  requestedAgentEngine: agentProfile.agentEngine,
  agentSettings: { ...agentProfile, textConnections: [agentProfile], activeTextConnectionId: agentProfile.id, activeTextAgentConnectionId: agentProfile.id },
});
const taskId = started.task?.taskId;
assert.ok(taskId, "扫榜任务必须返回任务标识");
let task = started.task;
const deadline = Date.now() + 8 * 60_000;
while (!["completed", "partial", "failed", "cancelled"].includes(task.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  task = (await get(`/api/ranking-scan/status?taskId=${encodeURIComponent(taskId)}`)).task;
}
assert.ok(["completed", "partial", "failed", "cancelled"].includes(task.status), "扫榜任务未在有限时间内返回终态");
assert.equal(task.skillReceipt?.fullText, true, "真实扫榜必须记录完整 Skill 收据");
assert.equal(task.contract?.allowWorkspaceMutation, undefined, "公开接口不得泄露内部可写合同");
const success = task.sourceLedger?.filter((item) => item.status === "success") || [];
for (const source of success) {
  assert.ok(source.snapshotId && source.route, "成功来源必须含快照和执行路由");
  assert.ok(Array.isArray(source.chapterEvidence), "成功来源必须返回正文覆盖账本");
}
console.log(JSON.stringify({
  ok: true, status: task.status, skillFullText: task.skillReceipt?.fullText === true,
  successfulSources: success.length, failedSources: task.failedPlatforms?.length || 0,
  coverageLevel: task.coverageLedger?.analysisLevel || "", candidateOnly: task.report?.authorizationState === "candidate_only",
  failureSummary: String(task.error || task.analysisFailure || task.failedPlatforms?.[0]?.reason || "").slice(0, 180),
}));
