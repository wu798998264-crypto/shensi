import { mkdir, readFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initializeConfiguredDataRoot, persistentNotesRoot } from "../src/server/app-data.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const recover = process.argv.includes("--apply");
await initializeConfiguredDataRoot();
const workspacePath = join(persistentNotesRoot(), "我的笔记");
const internalRoot = join(workspacePath, ".shensi");
const historyRoot = join(internalRoot, "history-isolated");
const currentStatePath = join(internalRoot, "current-state.json");
const manifestPath = join(internalRoot, "manifest.json");
const index = JSON.parse(await readFile(join(historyRoot, "index.json"), "utf8"));
const loaded = await loadWorkspaceState({ appRoot: process.cwd(), requestedPath: workspacePath });
if (!loaded.state) throw new Error("没有找到可恢复的我的笔记工作区");

const objectCache = new Map();
const readObject = async (hash) => {
  if (!/^[a-f0-9]{64}$/u.test(String(hash || ""))) return null;
  if (!objectCache.has(hash)) {
    const target = join(historyRoot, "objects", hash.slice(0, 2), `${hash}.json`);
    objectCache.set(hash, existsSync(target) ? readFile(target, "utf8").then(JSON.parse) : Promise.resolve(null));
  }
  return objectCache.get(hash);
};

const textFrom = (value) => String(value?.markdown || value?.content || value?.html || "").trim();
const isAttachment = (id, title) => /^library-attachment-/u.test(String(id)) || /^附件[:：]/u.test(String(title));
const timestampScore = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const recovered = [];
for (const [documentId, relativePath] of Object.entries(index.documents || {})) {
  if (loaded.state.documents?.[documentId]) continue;
  const shard = JSON.parse(await readFile(join(historyRoot, relativePath), "utf8"));
  const candidates = [];
  for (let indexInShard = 0; indexInShard < (shard.entries || []).length; indexInShard += 1) {
    const entry = shard.entries[indexInShard];
    const document = entry.storageDocumentRef
      ? await readObject(entry.storageDocumentRef)
      : (entry.document && typeof entry.document === "object" ? entry.document : null);
    const content = entry.storageDocumentContentRef
      ? await readObject(entry.storageDocumentContentRef)
      : entry;
    const text = textFrom(document) || textFrom(content) || textFrom(entry);
    const title = String(document?.title || entry.title || entry.name || documentId).trim();
    if (!text || isAttachment(documentId, title)) continue;
    candidates.push({ entry, document, content, text, title, indexInShard });
  }
  candidates.sort((left, right) => (
    timestampScore(right.entry.time || right.entry.createdAt) - timestampScore(left.entry.time || left.entry.createdAt)
    || left.indexInShard - right.indexInShard
  ));
  const selected = candidates[0];
  if (!selected) continue;
  const base = selected.document && typeof selected.document === "object" ? structuredClone(selected.document) : {};
  const next = {
    ...base,
    title: selected.title,
    moduleId: String(base.moduleId || selected.entry.moduleId || "library"),
    workspaceView: String(base.workspaceView || "default"),
    contextDomain: String(base.contextDomain || "general"),
    treeGroup: String(base.treeGroup || "recovered"),
    markdown: String(base.markdown || selected.content?.markdown || selected.entry.markdown || selected.text),
    html: String(base.html || selected.content?.html || selected.entry.html || ""),
    recovery: {
      source: "history-isolated",
      sourceDocumentId: documentId,
      sourceVersionId: String(selected.entry.versionId || selected.entry.id || ""),
      recoveredAt: new Date().toISOString(),
    },
  };
  if (!next.html && next.markdown) next.html = next.markdown.split(/\n{2,}/u).map((part) => `<p>${part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`).join("");
  loaded.state.documents[documentId] = next;
  loaded.state.moduleItems ??= {};
  loaded.state.moduleItems.library ??= [];
  if (!loaded.state.moduleItems.library.some((item) => Array.isArray(item) && item[0] === documentId)) {
    loaded.state.moduleItems.library.push([documentId, selected.title, { workspaceView: next.workspaceView, contextDomain: next.contextDomain, treeGroup: next.treeGroup }]);
  }
  recovered.push({ documentId, title: selected.title, characters: next.markdown.length, sourceVersionId: next.recovery.sourceVersionId });
}

console.log(JSON.stringify({ workspacePath, mode: recover ? "apply" : "dry-run", recoveredCount: recovered.length, recovered }, null, 2));
if (!recover || !recovered.length) process.exit(0);

const backupRoot = join(persistentNotesRoot(), `.recovery-backup-${new Date().toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14)}`);
await mkdir(backupRoot, { recursive: true });
await copyFile(currentStatePath, join(backupRoot, "current-state.json"));
await copyFile(manifestPath, join(backupRoot, "manifest.json"));
const saved = await saveWorkspaceState({
  appRoot: process.cwd(),
  requestedPath: workspacePath,
  state: loaded.state,
  expectedStateStamp: loaded.stateStamp,
  historySource: "history-recovery",
});
console.log(JSON.stringify({ saved: true, backupRoot, recoveredCount: recovered.length, stateStamp: saved.stateStamp }, null, 2));
