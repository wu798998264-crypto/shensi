import { copyFile, cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { appDataRoot, initializeConfiguredDataRoot, persistentNotesRoot } from "../src/server/app-data.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

// Recovery is intentionally additive: current documents are never replaced.
// Checkpoints are treated as evidence only; the user's live workspace remains
// the source of truth for anything that already exists.
const apply = process.argv.includes("--apply");
await initializeConfiguredDataRoot();
const workspacePath = join(persistentNotesRoot(), "我的笔记");
const internalRoot = join(workspacePath, ".shensi");
const loaded = await loadWorkspaceState({ appRoot: process.cwd(), requestedPath: workspacePath });
if (!loaded.state) throw new Error("没有找到可恢复的“我的笔记”工作区");

const checkpointRoot = join(appDataRoot(), "recovery", "workspace-checkpoints");
const workspaceKey = workspacePath.replaceAll("/", "\\").toLocaleLowerCase();
const currentIds = new Set(Object.keys(loaded.state.documents || {}));
const candidates = new Map();
const score = (document = {}) => Number(Boolean(document.canvas)) * 10_000
  + String(document.markdown || document.html || "").length
  + JSON.stringify(document).length;
const consider = (id, document, source, updatedAt, sourceState) => {
  if (!id || currentIds.has(id) || !document || typeof document !== "object") return;
  if (document.creativeGuidanceWorkspace === true || document.systemSlotId) return;
  const next = { id, document, source, updatedAt: String(updatedAt || ""), sourceState, score: score(document) };
  const previous = candidates.get(id);
  if (!previous || next.score > previous.score || (next.score === previous.score && next.updatedAt > previous.updatedAt)) candidates.set(id, next);
};

const checkpointFiles = existsSync(checkpointRoot)
  ? (await readdir(checkpointRoot)).filter((name) => name.endsWith(".json"))
  : [];
for (const name of checkpointFiles) {
  const file = join(checkpointRoot, name);
  let payload;
  try { payload = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
  if (String(payload.workspacePath || "").replaceAll("/", "\\").toLocaleLowerCase() !== workspaceKey) continue;
  const state = payload.state && typeof payload.state === "object" ? payload.state : null;
  if (!state) continue;
  for (const [id, document] of Object.entries(state.documents || {})) consider(id, document, `checkpoint:${name}`, payload.updatedAt || state.savedAt, state);
}

// Keep the explicitly created pre-task backup in the evidence set too. It has
// placement metadata for the lost “向天垂钓” folder, while older checkpoints
// carry the inline canvas bodies.
const backupFiles = existsSync(internalRoot)
  ? (await readdir(internalRoot)).filter((name) => name.startsWith("current-state.json.bak-"))
  : [];
for (const name of backupFiles) {
  let state;
  try { state = JSON.parse(await readFile(join(internalRoot, name), "utf8")); } catch { continue; }
  for (const [id, document] of Object.entries(state.documents || {})) consider(id, document, `backup:${name}`, state.savedAt, state);
}

const recovered = [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
const report = {
  workspacePath,
  mode: apply ? "apply" : "dry-run",
  currentDocumentCount: currentIds.size,
  recoveredDocumentCount: recovered.length,
  recovered: recovered.map(({ id, document, source }) => ({ id, title: document.title || id, kind: document.documentKind || document.kind || "document", nodes: document.canvas?.nodes?.length || 0, source })),
};
console.log(JSON.stringify(report, null, 2));
if (!apply || !recovered.length) process.exit(0);

const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
const backupRoot = join(persistentNotesRoot(), `recovery-backup-checkpoint-${stamp}`);
await mkdir(backupRoot, { recursive: true });
await copyFile(join(internalRoot, "current-state.json"), join(backupRoot, "current-state.json"));
if (existsSync(join(internalRoot, "manifest.json"))) await copyFile(join(internalRoot, "manifest.json"), join(backupRoot, "manifest.json"));
if (existsSync(join(internalRoot, "history-isolated"))) await cp(join(internalRoot, "history-isolated"), join(backupRoot, "history-isolated"), { recursive: true });

const beforeExisting = new Map(Object.entries(loaded.state.documents || {}).map(([id, document]) => [id, createHash("sha256").update(JSON.stringify(document)).digest("hex")]));
const nextState = structuredClone(loaded.state);
nextState.documents ??= {};
nextState.moduleItems ??= {};
nextState.directoryOrders ??= {};
nextState.customFolders ??= [];
const placementEntries = new Map();
for (const item of recovered) {
  nextState.documents[item.id] = structuredClone(item.document);
  const sourceState = item.sourceState || {};
  const moduleId = String(item.document.moduleId || "library");
  const sourceItem = (sourceState.moduleItems?.[moduleId] || []).find((entry) => String(entry?.[0] || "") === item.id);
  const fallbackOptions = {
    workspaceView: item.document.workspaceView || "default",
    contextDomain: item.document.contextDomain || "general",
    ...(item.document.customFolderPath ? { customFolderPath: item.document.customFolderPath } : {}),
  };
  const moduleItem = sourceItem || [item.id, item.document.title || item.id, fallbackOptions];
  nextState.moduleItems[moduleId] ??= [];
  if (!nextState.moduleItems[moduleId].some((entry) => String(entry?.[0] || "") === item.id)) nextState.moduleItems[moduleId].push(structuredClone(moduleItem));
  placementEntries.set(item.id, { moduleId, item: structuredClone(moduleItem), sourceState });
  for (const folder of sourceState.customFolders || []) {
    if (folder?.id && !nextState.customFolders.some((current) => current.id === folder.id)) nextState.customFolders.push(structuredClone(folder));
  }
}

// Merge only directory entries that point to a recovered document/folder; no
// current ordering is replaced. This restores the old notebook tree without
// moving the user's existing files.
for (const { sourceState } of placementEntries.values()) {
  for (const [location, entries] of Object.entries(sourceState.directoryOrders || {})) {
    if (!Array.isArray(entries)) continue;
    const relevant = entries.filter((entry) => {
      const token = String(entry || "");
      return recovered.some((item) => token.includes(item.id)) || nextState.customFolders.some((folder) => token.includes(folder.id));
    });
    if (!relevant.length) continue;
    nextState.directoryOrders[location] ??= [];
    for (const entry of relevant) if (!nextState.directoryOrders[location].includes(entry)) nextState.directoryOrders[location].push(entry);
  }
}

const saved = await saveWorkspaceState({
  appRoot: process.cwd(),
  requestedPath: workspacePath,
  state: nextState,
  expectedStateStamp: loaded.stateStamp,
  historySource: "checkpoint-additive-recovery",
});
const verified = await loadWorkspaceState({ appRoot: process.cwd(), requestedPath: workspacePath });
const missingAfterSave = recovered.filter((item) => !verified.state?.documents?.[item.id]).map((item) => item.id);
const changedExisting = [...beforeExisting.entries()].filter(([id, hash]) => {
  const current = verified.state?.documents?.[id];
  return current && createHash("sha256").update(JSON.stringify(current)).digest("hex") !== hash;
}).map(([id]) => id);
if (missingAfterSave.length || changedExisting.length) {
  throw new Error(`检查点恢复验收失败：缺失 ${missingAfterSave.join(",") || "无"}；现有文档内容变化 ${changedExisting.join(",") || "无"}`);
}
console.log(JSON.stringify({ saved: true, backupRoot, stateStamp: saved.stateStamp, recoveredCount: recovered.length, missingAfterSave, changedExisting }, null, 2));
