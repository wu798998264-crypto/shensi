import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appDataRoot } from "./app-data.mjs";
import { portableGenerationSettings } from "../generation-profiles.js";

const RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_FULL_MODE = "full-v1";
const RECOVERY_OVERLAY_MODE = "overlay-v1";
const RECOVERY_DOCUMENT_OVERLAY_MODE = "document-overlay-v2";
const RECOVERY_STATE_MODES = new Set([
  RECOVERY_FULL_MODE,
  RECOVERY_OVERLAY_MODE,
  RECOVERY_DOCUMENT_OVERLAY_MODE,
]);
const SECRET_FIELD = /^(?:api|imageApi|videoApi)?key$|secret|authorization|accessToken|refreshToken/i;

const recoveryRoot = () => join(appDataRoot(), "recovery");
const checkpointRoot = () => join(recoveryRoot(), "workspace-checkpoints");
const resumeStatePath = () => join(recoveryRoot(), "resume-state.json");

const pathWriteQueues = new Map();
const writeQueueKey = (path) => process.platform === "win32" ? String(path).toLowerCase() : String(path);
const withPathWriteLock = (path, operation) => {
  const key = writeQueueKey(path);
  const previous = pathWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pathWriteQueues.set(key, current);
  return current.finally(() => {
    if (pathWriteQueues.get(key) === current) pathWriteQueues.delete(key);
  });
};

const renameWithRetry = async (source, target, attempts = 6) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === attempts) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 40));
    }
  }
};

const atomicWriteUnlocked = async (path, content) => {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const swap = `${path}.${process.pid}.${randomUUID()}.swap`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let movedExisting = false;
  try {
    await renameWithRetry(path, swap);
    movedExisting = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await renameWithRetry(temporary, path);
    if (movedExisting) await rm(swap, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (movedExisting) await renameWithRetry(swap, path);
    throw error;
  }
};

const atomicWrite = (path, content) => withPathWriteLock(path, () => atomicWriteUnlocked(path, content));

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const scrubSecrets = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, seen));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELD.test(key))
    .map(([key, item]) => [key, scrubSecrets(item, seen)]));
};

const scrubCheckpoint = (value) => {
  const checkpoint = scrubSecrets(value);
  if (checkpoint?.state?.settings) {
    checkpoint.state = { ...checkpoint.state, settings: portableGenerationSettings(checkpoint.state.settings) };
    delete checkpoint.state.settings.workspacePath;
  }
  return checkpoint;
};

const normalizedWorkspacePath = (workspacePath) => resolve(String(workspacePath || "").trim()).toLowerCase();
const checkpointIdentity = (workspacePath) => createHash("sha256").update(normalizedWorkspacePath(workspacePath)).digest("hex");
const checkpointClientIdentity = (clientId) => createHash("sha256").update(String(clientId || "anonymous")).digest("hex").slice(0, 24);
const checkpointPath = (workspacePath, clientId = "") => join(checkpointRoot(), `${checkpointIdentity(workspacePath)}-${checkpointClientIdentity(clientId)}.json`);
const legacyCheckpointPath = (workspacePath) => join(checkpointRoot(), `${checkpointIdentity(workspacePath)}.json`);

const validWorkspacePath = (workspacePath) => {
  const value = String(workspacePath || "").trim();
  if (!value) throw new Error("恢复检查点缺少工作区路径");
  return resolve(value);
};

const normalizedRecoveryStateMode = (stateMode) => (
  RECOVERY_STATE_MODES.has(stateMode) ? stateMode : RECOVERY_FULL_MODE
);

const normalizedRecoveryDocumentIds = (documentIds, state = {}) => {
  const source = Array.isArray(documentIds) ? documentIds : Object.keys(state?.documents ?? {});
  return [...new Set(source
    .map((documentId) => String(documentId || "").trim())
    .filter(Boolean))]
    .slice(0, 20_000);
};

export const saveWorkspaceRecoveryCheckpoint = async ({
  workspacePath,
  workspaceKind = "project",
  projectName = "",
  state,
  stateMode = RECOVERY_FULL_MODE,
  documentIds = [],
  omittedStateKeys = [],
  revision = 0,
  baseSavedAt = "",
  baseStateStamp = "",
  baseWorkspaceCommitId = "",
  clientId = "",
  whiteboardGenerationDrafts = null,
  deletedDocumentIds = [],
} = {}) => {
  const resolvedWorkspacePath = validWorkspacePath(workspacePath);
  if (!state || typeof state !== "object") throw new Error("恢复检查点缺少工作区状态");
  const normalizedClientId = String(clientId || "");
  const path = checkpointPath(resolvedWorkspacePath, normalizedClientId);
  const nextRevision = Math.max(0, Number(revision) || 0);
  const normalizedStateMode = normalizedRecoveryStateMode(stateMode);
  const normalizedDocumentIds = normalizedStateMode === RECOVERY_DOCUMENT_OVERLAY_MODE
    ? normalizedRecoveryDocumentIds(documentIds, state)
    : [];
  if (normalizedStateMode === RECOVERY_DOCUMENT_OVERLAY_MODE
    && (!state.documents || typeof state.documents !== "object" || Array.isArray(state.documents))) {
    throw new Error("单文档恢复检查点缺少 documents 映射");
  }
  const checkpoint = scrubCheckpoint({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    workspacePath: resolvedWorkspacePath,
    workspaceKind: workspaceKind === "notebook" ? "notebook" : "project",
    projectName: String(projectName || state.projectName || ""),
    clientId: normalizedClientId,
    revision: nextRevision,
    baseSavedAt: String(baseSavedAt || state.savedAt || ""),
    baseStateStamp: String(baseStateStamp || ""),
    baseWorkspaceCommitId: String(baseWorkspaceCommitId || ""),
    updatedAt: new Date().toISOString(),
    dirty: true,
    stateMode: normalizedStateMode,
    ...(normalizedStateMode === RECOVERY_DOCUMENT_OVERLAY_MODE
      ? { documentIds: normalizedDocumentIds }
      : {}),
    deletedDocumentIds: [...new Set((Array.isArray(deletedDocumentIds) ? deletedDocumentIds : [])
      .map((documentId) => String(documentId || "").trim())
      .filter(Boolean))].slice(0, 20_000),
    omittedStateKeys: Array.isArray(omittedStateKeys)
      ? omittedStateKeys.filter((key) => typeof key === "string").slice(0, 32)
      : [],
    state,
    whiteboardGenerationDrafts,
  });
  return withPathWriteLock(path, async () => {
    const previous = await readJson(path);
    if (previous?.dirty === true
      && previous.clientId === normalizedClientId
      && Number(previous.revision) > nextRevision) return previous;
    await atomicWriteUnlocked(path, JSON.stringify(checkpoint));
    return checkpoint;
  });
};

export const loadWorkspaceRecoveryCheckpoint = async ({ workspacePath, clientId = "", baseStateStamp = "" } = {}) => {
  const resolvedWorkspacePath = validWorkspacePath(workspacePath);
  await mkdir(checkpointRoot(), { recursive: true });
  const normalizedClientId = String(clientId || "");
  const normalizedPath = normalizedWorkspacePath(resolvedWorkspacePath);
  const ownPath = normalizedClientId ? checkpointPath(resolvedWorkspacePath, normalizedClientId) : "";
  const legacyPath = legacyCheckpointPath(resolvedWorkspacePath);
  const prefix = `${checkpointIdentity(resolvedWorkspacePath)}-`;
  const entries = await readdir(checkpointRoot(), { withFileTypes: true });
  const candidateEntries = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => join(checkpointRoot(), entry.name));

  // Checkpoint files contain complete workspace snapshots and can be tens of
  // megabytes each.  Read only a bounded, mtime-sorted window of headers first;
  // this is enough to discover a dirty overlay or deletion tombstone without
  // parsing every historical client snapshot during startup.  The active client
  // and legacy paths are always included even when they fall outside the window.
  const recentPaths = (await Promise.all(candidateEntries.map(async (path) => ({
    path,
    mtimeMs: (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs || 0,
  })))).sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 32).map(({ path }) => path);
  const paths = [...new Set([ownPath, legacyPath, ...recentPaths].filter(Boolean))];
  const readHeader = async (path) => {
    let handle;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(128 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.toString("utf8", 0, bytesRead);
      const stateMarker = text.indexOf(',"state":');
      if (stateMarker < 0) return null;
      return JSON.parse(`${text.slice(0, stateMarker)}}`);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  };
  const headers = await Promise.all(paths.map(async (path) => ({ path, header: await readHeader(path) })));
  const validHeaders = headers.filter(({ header }) => (
    header && normalizedWorkspacePath(header.workspacePath) === normalizedPath
  ));
  const headerUpdatedAt = (header) => {
    const parsed = Date.parse(header?.updatedAt || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const hasProtectiveData = ({ header }) => Boolean(
    header?.dirty === true
    && (!baseStateStamp || String(header.baseStateStamp || "") === String(baseStateStamp)),
  );
  // Another renderer's newer, compatible unsaved edit must not be hidden by an
  // own-client clean checkpoint.  The canonical stamp is still authoritative:
  // an old dirty overlay must never roll back a later committed workspace.
  const protective = validHeaders.filter(hasProtectiveData).sort((left, right) => (
    headerUpdatedAt(right.header) - headerUpdatedAt(left.header)
  ));
  if (baseStateStamp) {
    const matching = validHeaders
      .filter(({ header }) => String(header.baseStateStamp || "") === String(baseStateStamp))
      .sort((left, right) => (
        Number(right.header.dirty === true) - Number(left.header.dirty === true)
        || headerUpdatedAt(right.header) - headerUpdatedAt(left.header)
      ));
    for (const { path: matchingPath } of matching) {
      const selected = await readJson(matchingPath);
      if (!selected || normalizedWorkspacePath(selected.workspacePath) !== normalizedPath) continue;
      return scrubCheckpoint(selected);
    }
    return null;
  }
  const fallback = validHeaders.sort((left, right) => headerUpdatedAt(right.header) - headerUpdatedAt(left.header));
  const selectedPaths = [...new Set([...protective, ...fallback].map(({ path }) => path))];
  for (const selectedPath of selectedPaths) {
    const selected = await readJson(selectedPath);
    // A complete header alone is not enough: a truncated body must not replace
    // the previous valid snapshot, even if it has the newest timestamp.
    if (!selected || normalizedWorkspacePath(selected.workspacePath) !== normalizedPath) continue;
    return scrubCheckpoint(selected);
  }
  return null;
};

export const commitWorkspaceRecoveryCheckpoint = async ({ workspacePath, clientId = "", revision = 0, savedAt = "", stateStamp = "" } = {}) => {
  const resolvedWorkspacePath = validWorkspacePath(workspacePath);
  const path = checkpointPath(resolvedWorkspacePath, clientId);
  return withPathWriteLock(path, async () => {
    const checkpoint = await readJson(path);
    if (!checkpoint) return null;
    if (clientId && checkpoint.clientId && checkpoint.clientId !== clientId) return checkpoint;
    if (Number(revision) && Number(checkpoint.revision) > Number(revision)) return checkpoint;
    const committed = {
      ...checkpoint,
      dirty: false,
      committedAt: new Date().toISOString(),
      canonicalSavedAt: String(savedAt || ""),
      stateStamp: String(stateStamp || ""),
    };
    await atomicWriteUnlocked(path, JSON.stringify(committed));
    return committed;
  });
};

const normalizedResumeState = (value = {}) => ({
  schemaVersion: RECOVERY_SCHEMA_VERSION,
  activeWorkspace: value.activeWorkspace && typeof value.activeWorkspace === "object"
    ? {
        workspaceKind: value.activeWorkspace.workspaceKind === "notebook" ? "notebook" : "project",
        workspacePath: String(value.activeWorkspace.workspacePath || ""),
        projectName: String(value.activeWorkspace.projectName || ""),
        activeModule: String(value.activeWorkspace.activeModule || ""),
        activeDocument: String(value.activeWorkspace.activeDocument || ""),
        resumeRevision: Math.max(0, Number(value.activeWorkspace.resumeRevision) || 0),
        empty: value.activeWorkspace.empty === true,
      }
    : null,
  updatedAt: String(value.updatedAt || ""),
});

export const loadRecoveryResumeState = async () => normalizedResumeState(await readJson(resumeStatePath()) ?? {});

export const saveRecoveryResumeState = async ({ activeWorkspace, force = false } = {}) => {
  const next = normalizedResumeState({ activeWorkspace, updatedAt: new Date().toISOString() });
  const path = resumeStatePath();
  return withPathWriteLock(path, async () => {
    const current = normalizedResumeState(await readJson(path) ?? {});
    const currentRevision = Math.max(0, Number(current.activeWorkspace?.resumeRevision) || 0);
    const nextRevision = Math.max(0, Number(next.activeWorkspace?.resumeRevision) || 0);
    if (!force && currentRevision && nextRevision < currentRevision) return current;
    await atomicWriteUnlocked(path, JSON.stringify(next, null, 2));
    return next;
  });
};
