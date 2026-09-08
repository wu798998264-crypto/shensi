import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const text = (value = "") => String(value ?? "").trim();
const dataRoot = resolve(process.env.SHENSI_BASELINE_DATA_ROOT || process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData");
const outputPath = resolve(process.env.SHENSI_BASELINE_OUTPUT || "artifacts/v300-readonly-baseline.json");

const safeProfile = (profile = {}) => ({
  id: text(profile.id || profile.connectionId),
  provider: text(profile.provider),
  adapter: text(profile.adapter),
  protocol: text(profile.protocol),
  executionMode: text(profile.executionMode),
  executionModes: Array.isArray(profile.executionModes) ? profile.executionModes.map(text).filter(Boolean) : [],
  agentEngine: text(profile.agentEngine),
  model: text(profile.model),
  agentModelId: text(profile.agentModelId),
  credentialSource: text(profile.credentialSource),
  cliExecutable: text(profile.cliPath) ? basename(text(profile.cliPath)) : "",
  cliArgsHash: text(profile.cliArgs) ? hash(text(profile.cliArgs)) : "",
  baseUrlHash: text(profile.baseUrl) ? hash(text(profile.baseUrl).replace(/\/+$/u, "")) : "",
  credentialPresent: Boolean(text(profile.apiKey) || text(profile.credentialRef) || text(profile.secretRef)),
});

const safeSettings = (settings = {}) => ({
  activeTextConnectionId: text(settings.activeTextConnectionId),
  activeTextChatConnectionId: text(settings.activeTextChatConnectionId),
  activeTextAgentConnectionId: text(settings.activeTextAgentConnectionId),
  activeImageConnectionId: text(settings.activeImageConnectionId),
  activeVideoConnectionId: text(settings.activeVideoConnectionId),
  activeAudioConnectionId: text(settings.activeAudioConnectionId),
  textConnections: (Array.isArray(settings.textConnections) ? settings.textConnections : []).map(safeProfile),
  imageConnections: (Array.isArray(settings.imageConnections) ? settings.imageConnections : []).map(safeProfile),
  videoConnections: (Array.isArray(settings.videoConnections) ? settings.videoConnections : []).map(safeProfile),
  audioConnections: (Array.isArray(settings.audioConnections) ? settings.audioConnections : []).map(safeProfile),
});

const countHistoryIndex = async (workspaceRoot) => {
  const path = join(workspaceRoot, ".shensi", "history-isolated", "index.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(parsed)) return parsed.length;
    if (Array.isArray(parsed?.entries)) return parsed.entries.length;
    return Object.keys(parsed?.entries || parsed?.versions || parsed || {}).length;
  } catch {
    return 0;
  }
};

const workspaceRoots = async () => {
  const roots = [];
  for (const bucket of ["作品", "笔记"]) {
    const bucketPath = join(dataRoot, bucket);
    let entries = [];
    try {
      entries = await readdir(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) roots.push({ bucket, path: join(bucketPath, entry.name) });
  }
  return roots;
};

const snapshotWorkspace = async ({ bucket, path }) => {
  const statePath = join(path, ".shensi", "current-state.json");
  const before = await stat(statePath);
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw);
  const after = await stat(statePath);
  assert.equal(after.size, before.size, `只读基线期间文件大小发生变化：${statePath}`);
  assert.equal(after.mtimeMs, before.mtimeMs, `只读基线期间文件时间发生变化：${statePath}`);
  return {
    bucket,
    workspaceId: hash(resolve(path)).slice(0, 20),
    stateBytes: before.size,
    stateModifiedAt: before.mtime.toISOString(),
    stateHash: hash(raw),
    workspaceKind: text(parsed.workspaceKind),
    schemaVersion: parsed.schemaVersion ?? null,
    documentCount: Object.keys(parsed.documents || {}).length,
    conversationCount: Object.keys(parsed.conversations || {}).length,
    assetCount: Array.isArray(parsed.workspaceAssets) ? parsed.workspaceAssets.length : Object.keys(parsed.workspaceAssets || {}).length,
    trashCount: Array.isArray(parsed.trash) ? parsed.trash.length : Object.keys(parsed.trash || {}).length,
    historyCount: await countHistoryIndex(path),
    settings: safeSettings(parsed.settings || {}),
  };
};

const roots = await workspaceRoots();
assert.ok(roots.length, `未在 ${dataRoot} 找到可建立基线的作品或笔记工作区`);
const workspaces = [];
for (const entry of roots) {
  try {
    workspaces.push(await snapshotWorkspace(entry));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
assert.ok(workspaces.length, "没有找到任何 .shensi/current-state.json，已停止修改");

const baseline = {
  format: "shensi-v300-readonly-baseline-v1",
  generatedAt: new Date().toISOString(),
  dataRootHash: hash(dataRoot),
  workspaceCount: workspaces.length,
  totals: workspaces.reduce((sum, item) => ({
    documents: sum.documents + item.documentCount,
    conversations: sum.conversations + item.conversationCount,
    assets: sum.assets + item.assetCount,
    trash: sum.trash + item.trashCount,
    histories: sum.histories + item.historyCount,
  }), { documents: 0, conversations: 0, assets: 0, trash: 0, histories: 0 }),
  workspaces,
};
let previous = null;
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
} catch {}
if (previous?.format === baseline.format) {
  const previousById = new Map((previous.workspaces || []).map((item) => [item.workspaceId, item]));
  const settingsChanged = [];
  const stateChanged = [];
  for (const item of baseline.workspaces) {
    const earlier = previousById.get(item.workspaceId);
    if (!earlier) continue;
    if (JSON.stringify(item.settings) !== JSON.stringify(earlier.settings)) settingsChanged.push(item.workspaceId);
    if (item.stateHash !== earlier.stateHash) stateChanged.push(item.workspaceId);
  }
  if (settingsChanged.length && process.env.SHENSI_BASELINE_ACCEPT_CURRENT !== "1") {
    assert.fail(`已有模型配置发生非预期变化：${settingsChanged.join(", ")}`);
  }
  baseline.comparison = {
    previousGeneratedAt: previous.generatedAt || "",
    settingsChanged: settingsChanged.length,
    acceptedCurrentSettings: settingsChanged.length > 0 && process.env.SHENSI_BASELINE_ACCEPT_CURRENT === "1",
    liveWorkspaceStateChanged: stateChanged.length,
  };
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  outputPath,
  workspaceCount: baseline.workspaceCount,
  totals: baseline.totals,
  textProfileCount: workspaces.reduce((sum, item) => sum + item.settings.textConnections.length, 0),
  imageProfileCount: workspaces.reduce((sum, item) => sum + item.settings.imageConnections.length, 0),
  videoProfileCount: workspaces.reduce((sum, item) => sum + item.settings.videoConnections.length, 0),
  audioProfileCount: workspaces.reduce((sum, item) => sum + item.settings.audioConnections.length, 0),
  comparison: baseline.comparison || null,
}));
