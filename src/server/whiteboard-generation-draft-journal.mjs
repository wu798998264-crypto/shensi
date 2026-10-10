import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeWhiteboardGenerationDraftCache, whiteboardGenerationDraftKey, whiteboardGenerationDraftScope } from "../whiteboard-generation-draft.js";

const journalDirectory = ({ root, workspaceKind, workspacePath }) => {
  if (!root || !String(workspacePath || "").trim()) throw new Error("草稿日志缺少本地资料目录或工作区路径");
  const identity = `${workspaceKind === "notebook" ? "notebook" : "project"}:${resolve(workspacePath).toLowerCase()}`;
  return join(root, "recovery", "generation-drafts", createHash("sha256").update(identity).digest("hex"));
};
const readRecord = path => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    try { return JSON.parse(readFileSync(`${path}.previous`, "utf8")); }
    catch (backupError) {
      if (error instanceof SyntaxError || backupError instanceof SyntaxError) throw new Error("草稿日志损坏，禁止用空值覆盖");
      if (backupError.code !== "ENOENT") throw backupError;
      return null;
    }
  }
};

// Desktop input uses this small per-card journal synchronously. fsync finishes
// BEFORE returning to the renderer; a refresh, new origin or killed backend
// therefore cannot outrun the final prompt/reference/parameter input event.
export const writeWhiteboardGenerationDraftJournal = options => {
  const { entry } = options;
  const key = whiteboardGenerationDraftKey(entry);
  const workspaceId = `${options.workspaceKind === "notebook" ? "notebook" : "project"}:${String(options.workspacePath || "").trim().toLowerCase()}`;
  if (!key || entry.workspaceId !== workspaceId) throw new Error("生成草稿工作区身份不一致");
  const cache = normalizeWhiteboardGenerationDraftCache({ version: 9, entries: { [key]: entry }, active: options.active });
  const path = join(journalDirectory(options), `${createHash("sha256").update(key).digest("hex")}.json`);
  const previous = readRecord(path);
  if (Number(previous?.entry?.updatedAt || 0) > Number(cache.entries[key].updatedAt)) return { ok: true, updatedAt: previous.entry.updatedAt };
  mkdirSync(journalDirectory(options), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const activeScope = whiteboardGenerationDraftScope(options.active);
  const activeKey = whiteboardGenerationDraftKey(activeScope);
  const active = activeKey && activeScope.workspaceId === workspaceId ? { ...activeScope, key: activeKey, updatedAt: Number(options.active.updatedAt) || 0 } : null;
  const record = { entry: cache.entries[key], active, sessionUpdatedAt: Math.max(Date.now(), Number(cache.entries[key].updatedAt) || 0) };
  const descriptor = openSync(temporary, "wx");
  try { writeFileSync(descriptor, JSON.stringify(record), "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try {
    if (existsSync(path)) renameSync(path, `${path}.previous`);
    renameSync(temporary, path);
  } catch (error) {
    if (!existsSync(path) && existsSync(`${path}.previous`)) renameSync(`${path}.previous`, path);
    throw error;
  } finally { if (existsSync(temporary)) rmSync(temporary); }
  return { ok: true, updatedAt: record.entry.updatedAt };
};

export const readWhiteboardGenerationDraftJournal = options => {
  const directory = journalDirectory(options);
  if (!existsSync(directory)) return { cache: normalizeWhiteboardGenerationDraftCache({}), sessionUpdatedAt: 0 };
  let latest = null;
  const entries = {};
  const names = readdirSync(directory).filter(name => /^[a-f\d]{64}\.json(?:\.previous)?$/u.test(name));
  for (const name of new Set(names.map(name => name.replace(/\.previous$/u, "")))) {
    const record = readRecord(join(directory, name));
    if (!record?.entry) continue;
    const key = whiteboardGenerationDraftKey(record.entry);
    if (key) entries[key] = record.entry;
    if (!latest || Number(record.sessionUpdatedAt) > Number(latest.sessionUpdatedAt)) latest = record;
  }
  return { cache: normalizeWhiteboardGenerationDraftCache({ version: 9, entries, active: latest?.active }), sessionUpdatedAt: Number(latest?.sessionUpdatedAt) || 0 };
};
