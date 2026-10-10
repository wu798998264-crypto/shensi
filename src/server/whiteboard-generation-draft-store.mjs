import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appDataRoot } from "./app-data.mjs";
import { loadWorkspaceRecoveryCheckpoint } from "./recovery-store.mjs";
import { readWhiteboardGenerationDraftJournal } from "./whiteboard-generation-draft-journal.mjs";
import { mergeWhiteboardGenerationDraftCaches, normalizeWhiteboardGenerationDraftCache } from "../whiteboard-generation-draft.js";

const queues = new Map();
const identity = ({ workspaceKind, workspacePath }) => `${workspaceKind === "notebook" ? "notebook" : "project"}:${String(workspacePath || "").trim().toLowerCase()}`;
const storePath = (options) => {
  if (!String(options.workspacePath || "").trim()) throw new Error("生成操作栏草稿缺少工作区路径");
  const key = `${options.workspaceKind === "notebook" ? "notebook" : "project"}:${resolve(options.workspacePath).toLowerCase()}`;
  return join(appDataRoot(), "recovery", "generation-drafts", `${createHash("sha256").update(key).digest("hex")}.json`);
};
const scopedCache = (cache, options) => {
  const normalized = normalizeWhiteboardGenerationDraftCache(cache);
  const workspaceId = identity(options);
  return normalizeWhiteboardGenerationDraftCache({ ...normalized,
    entries: Object.fromEntries(Object.entries(normalized.entries).filter(([, entry]) => entry.workspaceId === workspaceId)),
    active: normalized.active?.workspaceId === workspaceId ? normalized.active : null,
  });
};
const readRecord = async (path) => {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    try { return JSON.parse(await readFile(`${path}.previous`, "utf8")); }
    catch (backupError) {
      if (error instanceof SyntaxError || backupError instanceof SyntaxError) throw new Error("生成操作栏草稿文件损坏，已禁止用空草稿覆盖；请从本地备份恢复");
      if (backupError.code !== "ENOENT") throw backupError;
      return null;
    }
  }
};
const atomicWrite = async (path, record) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(record), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    // Keep the previous valid record as a local recovery copy. Never truncate
    // the live file: a process exit must expose either whole version, not half.
    try { await rename(path, `${path}.previous`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, path);
  } catch (error) {
    await rename(`${path}.previous`, path).catch(() => {});
    throw error;
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
};

export const loadWhiteboardGenerationDrafts = async (options) => {
  const path = storePath(options);
  if (queues.has(path)) await queues.get(path);
  const record = await readRecord(path);
  const journal = readWhiteboardGenerationDraftJournal({ ...options, root: appDataRoot() });
  if (record) {
    const cache = mergeWhiteboardGenerationDraftCaches(record.cache, journal.cache);
    const newest = journal.sessionUpdatedAt >= Number(record.sessionUpdatedAt || 0) ? journal : record;
    cache.active = newest.cache.active;
    cache.openSessions = cache.active ? [cache.active] : [];
    return { cache: scopedCache(cache, options), sessionUpdatedAt: Math.max(journal.sessionUpdatedAt, Number(record.sessionUpdatedAt) || 0) };
  }
  // Legacy checkpoints remain read-only. Drafts can be recovered even when a
  // canonical save cleared dirty or changed its state stamp; NO document state
  // is imported here, so deleted documents cannot be resurrected by this path.
  const legacy = await loadWorkspaceRecoveryCheckpoint({ workspacePath: options.workspacePath });
  const cache = mergeWhiteboardGenerationDraftCaches(legacy?.whiteboardGenerationDrafts, journal.cache);
  if (journal.sessionUpdatedAt) { cache.active = journal.cache.active; cache.openSessions = cache.active ? [cache.active] : []; }
  return { cache: scopedCache(cache, options), sessionUpdatedAt: journal.sessionUpdatedAt };
};

export const saveWhiteboardGenerationDrafts = async (options) => {
  const path = storePath(options);
  const previous = queues.get(path) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const stored = await readRecord(path);
    const incoming = scopedCache(options.cache, options);
    const cache = mergeWhiteboardGenerationDraftCaches(stored?.cache, incoming);
    const sessionUpdatedAt = Math.max(0, Number(options.sessionUpdatedAt) || 0);
    if (sessionUpdatedAt >= (Number(stored?.sessionUpdatedAt) || 0)) {
      cache.active = incoming.active;
      cache.openSessions = incoming.active ? [incoming.active] : [];
    } else {
      cache.active = stored?.cache?.active || null;
      cache.openSessions = cache.active ? [cache.active] : [];
    }
    const record = { version: 1, workspaceId: identity(options), cache,
      sessionUpdatedAt: Math.max(sessionUpdatedAt, Number(stored?.sessionUpdatedAt) || 0), updatedAt: new Date().toISOString() };
    await atomicWrite(path, record);
    return record;
  });
  queues.set(path, operation);
  try { return await operation; }
  finally { if (queues.get(path) === operation) queues.delete(path); }
};
