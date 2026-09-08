import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
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
  clientId = "",
  whiteboardGenerationDrafts = null,
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
    updatedAt: new Date().toISOString(),
    dirty: true,
    stateMode: normalizedStateMode,
    ...(normalizedStateMode === RECOVERY_DOCUMENT_OVERLAY_MODE
      ? { documentIds: normalizedDocumentIds }
      : {}),
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

export const loadWorkspaceRecoveryCheckpoint = async ({ workspacePath, clientId = "" } = {}) => {
  const resolvedWorkspacePath = validWorkspacePath(workspacePath);
  await mkdir(checkpointRoot(), { recursive: true });
  const normalizedClientId = String(clientId || "");

  // A checkpoint can contain the complete workspace state (including whiteboard
  // prompt/reference drafts), so older installations may have hundreds of
  // multi-megabyte files for one workspace.  Never scan and JSON-parse every
  // client file during startup.  The active client is the only authoritative
  // checkpoint for this session; read it directly first.
  if (normalizedClientId) {
    const ownCheckpoint = await readJson(checkpointPath(resolvedWorkspacePath, normalizedClientId));
    if (ownCheckpoint && normalizedWorkspacePath(ownCheckpoint.workspacePath) === normalizedWorkspacePath(resolvedWorkspacePath)) {
      return scrubCheckpoint(ownCheckpoint);
    }
  }

  const legacyCheckpoint = await readJson(legacyCheckpointPath(resolvedWorkspacePath));
  if (legacyCheckpoint && normalizedWorkspacePath(legacyCheckpoint.workspacePath) === normalizedWorkspacePath(resolvedWorkspacePath)) {
    return scrubCheckpoint(legacyCheckpoint);
  }

  const prefix = `${checkpointIdentity(resolvedWorkspacePath)}-`;
  const entries = await readdir(checkpointRoot(), { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    // Limit fallback recovery to a small bounded sample.  This path is only
    // for sessions whose client checkpoint no longer exists; parsing every
    // historical snapshot would block the renderer and can exhaust memory.
    .slice(-8)
    .map((entry) => join(checkpointRoot(), entry.name));
  const checkpoints = (await Promise.all(paths.map((path) => readJson(path))))
    .filter((checkpoint) => checkpoint && normalizedWorkspacePath(checkpoint.workspacePath) === normalizedWorkspacePath(resolvedWorkspacePath))
    .map((checkpoint) => scrubCheckpoint(checkpoint))
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  const dirty = checkpoints.filter((checkpoint) => checkpoint.dirty === true);
  const sameClientDirty = normalizedClientId
    ? dirty.find((checkpoint) => checkpoint.clientId === normalizedClientId)
    : null;
  if (sameClientDirty) return sameClientDirty;
  if (dirty.length) return dirty[0];
  return checkpoints.find((checkpoint) => checkpoint.clientId === normalizedClientId) ?? checkpoints[0] ?? null;
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
