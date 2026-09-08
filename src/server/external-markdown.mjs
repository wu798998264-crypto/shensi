import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createBlankNotebookState } from "../data.js";
import { markdownToHtml, readWorkspaceAttachmentContent, resolveWorkspaceRoot, saveWorkspaceAttachmentFromPath, saveWorkspaceState, loadWorkspaceState } from "./workspace.mjs";
import { machineLocalDataRoot } from "./app-data.mjs";

export const TEMPORARY_NOTEBOOK_PATH = "shensi://temporary-notebook";
export const TEMPORARY_NOTEBOOK_ID = "temporary-markdown-notebook";
export const TEMPORARY_NOTEBOOK_NAME = "临时笔记本";

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;
const MAX_TEMPORARY_DOCUMENTS = 5_000;
const manifestDirectory = () => join(machineLocalDataRoot(), "external-markdown");
const manifestPath = () => join(manifestDirectory(), "manifest.json");
let manifestWriteQueue = Promise.resolve();

const normalizePathKey = (value) => {
  const normalized = resolve(String(value || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isInside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const atomicWrite = async (targetPath, content) => {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  const directoryHandle = await open(dirname(targetPath), "r").catch(() => null);
  if (directoryHandle) {
    try { await directoryHandle.sync().catch(() => {}); } finally { await directoryHandle.close(); }
  }
};

const readManifest = async () => {
  try {
    const payload = JSON.parse(await readFile(manifestPath(), "utf8"));
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      activeDocumentId: String(payload?.activeDocumentId || ""),
      entries: entries
        .filter((entry) => entry?.id && entry?.path)
        .map((entry) => ({
          id: String(entry.id),
          path: resolve(String(entry.path)),
          openedAt: String(entry.openedAt || ""),
          lastOpenedAt: String(entry.lastOpenedAt || entry.openedAt || ""),
        })),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { schemaVersion: MANIFEST_SCHEMA_VERSION, activeDocumentId: "", entries: [] };
    throw error;
  }
};

const writeManifest = (updater) => {
  const operation = manifestWriteQueue.then(async () => {
    const current = await readManifest();
    const next = await updater(current);
    await atomicWrite(manifestPath(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  manifestWriteQueue = operation.catch(() => {});
  return operation;
};

const markdownDocumentId = (filePath) => `external-md-${createHash("sha256").update(normalizePathKey(filePath)).digest("hex").slice(0, 24)}`;

const decodeMarkdown = (bytes) => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
  }
  const source = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(source);
};

const readableExternalMarkdown = async (requestedPath) => {
  if (!isAbsolute(String(requestedPath || ""))) throw new Error("Markdown 文件路径必须是绝对路径");
  const canonicalPath = await realpath(resolve(String(requestedPath)));
  if (extname(canonicalPath).toLowerCase() !== ".md") throw new Error("临时笔记本只接受 .md 文件");
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) throw new Error("目标不是可读取的 Markdown 文件");
  if (!metadata.size) throw new Error("Markdown 文件为空");
  if (metadata.size > MAX_MARKDOWN_BYTES) throw new Error("Markdown 文件超过 32 MiB，无法作为单篇笔记预览");
  const markdown = decodeMarkdown(await readFile(canonicalPath));
  return { canonicalPath, metadata, markdown };
};

const markdownBodyForPreview = (markdown) => String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

const externalPreviewMarkdown = (markdown) => markdownBodyForPreview(markdown).replace(
  /^!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)\n]+))(?:\s+['"][^'"\n]*['"])?\)\s*$/gm,
  (source, wrappedPath, plainPath) => {
    const rawPath = decodeURIComponent(String(wrappedPath || plainPath || "")).trim();
    return rawPath && !/^[a-z][a-z\d+.-]*:/i.test(rawPath) && !rawPath.startsWith("//") ? `![[${rawPath}]]` : source;
  },
);

const escapeExternalHtml = (value) => String(value || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const unavailableExternalDocument = (entry, error) => ({
  title: basename(entry.path, extname(entry.path)) || "外部 Markdown",
  html: `<p>外部 Markdown 暂时无法读取：${escapeExternalHtml(error?.message || error || "文件不存在")}</p>`,
  markdown: "",
  updatedAt: "无法读取",
  moduleId: "library",
  workspaceView: "default",
  contextDomain: "general",
  placementOverride: true,
  documentKind: "note",
  externalMarkdown: true,
  externalMissing: true,
  externalSourcePath: entry.path,
  readOnly: true,
});

const externalDocument = async (entry) => {
  try {
    const { canonicalPath, metadata, markdown } = await readableExternalMarkdown(entry.path);
    return {
      title: basename(canonicalPath, extname(canonicalPath)) || "外部 Markdown",
      html: markdownToHtml(externalPreviewMarkdown(markdown)),
      markdown,
      updatedAt: new Date(metadata.mtimeMs).toISOString(),
      moduleId: "library",
      workspaceView: "default",
      contextDomain: "general",
      placementOverride: true,
      documentKind: "note",
      externalMarkdown: true,
      externalSourcePath: canonicalPath,
      externalSize: metadata.size,
      externalModifiedAt: new Date(metadata.mtimeMs).toISOString(),
      readOnly: true,
    };
  } catch (error) {
    return unavailableExternalDocument(entry, error);
  }
};

export const isTemporaryNotebookPath = (value) => String(value || "").toLowerCase() === TEMPORARY_NOTEBOOK_PATH;

export const temporaryNotebookEntry = async () => {
  const manifest = await readManifest();
  if (!manifest.entries.length) return null;
  return {
    id: TEMPORARY_NOTEBOOK_ID,
    name: TEMPORARY_NOTEBOOK_NAME,
    workspacePath: TEMPORARY_NOTEBOOK_PATH,
    managed: false,
    temporary: true,
    documentCount: manifest.entries.length,
    savedAt: manifest.entries.map((entry) => entry.lastOpenedAt).sort().at(-1) || "",
  };
};

export const temporaryNotebookStateStamp = async () => {
  const manifest = await readManifest();
  const parts = await Promise.all(manifest.entries.map(async (entry) => {
    const metadata = await stat(entry.path).catch(() => null);
    return `${entry.id}:${normalizePathKey(entry.path)}:${metadata?.size ?? -1}:${Math.trunc(metadata?.mtimeMs ?? 0)}`;
  }));
  return createHash("sha256").update(`${manifest.activeDocumentId}\n${parts.join("\n")}`).digest("hex");
};

export const loadTemporaryNotebookState = async ({ activeDocumentId = "" } = {}) => {
  const manifest = await readManifest();
  const documents = Object.fromEntries(await Promise.all(manifest.entries.map(async (entry) => [entry.id, await externalDocument(entry)])));
  const requestedActive = String(activeDocumentId || manifest.activeDocumentId || "");
  const selectedId = documents[requestedActive] ? requestedActive : Object.keys(documents).at(-1) || null;
  const state = createBlankNotebookState({ name: TEMPORARY_NOTEBOOK_NAME, workspacePath: TEMPORARY_NOTEBOOK_PATH });
  state.temporaryNotebook = true;
  state.readOnly = true;
  state.projectName = TEMPORARY_NOTEBOOK_NAME;
  state.activeModule = "library";
  state.activeDocument = selectedId;
  state.moduleItems = { manuscript: [], outline: [], canon: [], memory: [], reports: [], library: manifest.entries.filter((entry) => documents[entry.id]).map((entry) => [entry.id, documents[entry.id].title, { workspaceView: "default", contextDomain: "general", placementOverride: true }]), index: [] };
  state.customFolders = [];
  state.documents = documents;
  state.histories = Object.fromEntries(Object.keys(documents).map((id) => [id, []]));
  state.viewHistories = {};
  state.volumeHistories = {};
  state.moduleHistories = { manuscript: [], outline: [], canon: [], memory: [], reports: [], library: [], index: [] };
  state.projectHistories = [];
  state.activities = [];
  state.trash = [];
  state.savedAt = manifest.entries.map((entry) => entry.lastOpenedAt).sort().at(-1) || new Date(0).toISOString();
  if (state.conversations?.[0]) state.conversations[0].boundDocumentId = selectedId;
  return { workspaceRoot: TEMPORARY_NOTEBOOK_PATH, state, stateStamp: await temporaryNotebookStateStamp(), temporary: true, readOnly: true };
};

export const registerExternalMarkdown = async ({ filePath }) => {
  const { canonicalPath } = await readableExternalMarkdown(filePath);
  const id = markdownDocumentId(canonicalPath);
  const now = new Date().toISOString();
  await writeManifest((current) => {
    const existing = current.entries.find((entry) => normalizePathKey(entry.path) === normalizePathKey(canonicalPath));
    const entries = current.entries.filter((entry) => entry !== existing);
    entries.push({ id, path: canonicalPath, openedAt: existing?.openedAt || now, lastOpenedAt: now });
    if (entries.length > MAX_TEMPORARY_DOCUMENTS) throw new Error(`临时笔记本最多保存 ${MAX_TEMPORARY_DOCUMENTS} 个外部文件索引`);
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, activeDocumentId: id, entries };
  });
  return { ...(await loadTemporaryNotebookState({ activeDocumentId: id })), documentId: id, filePath: canonicalPath };
};

const temporaryManifestEntry = async (documentId) => (await readManifest()).entries.find((entry) => entry.id === String(documentId || "")) || null;

export const readTemporaryMarkdownAttachment = async ({ documentId, relativePath }) => {
  const entry = await temporaryManifestEntry(documentId);
  if (!entry) throw new Error("临时笔记本中找不到对应 Markdown 文件");
  const sourceDirectory = dirname(await realpath(entry.path));
  const rawPath = String(relativePath || "").replaceAll("\\", "/").split("|")[0].split("#")[0].trim();
  if (!rawPath || rawPath.includes("\u0000") || isAbsolute(rawPath) || /^[a-z]:/i.test(rawPath)) throw new Error("外部附件路径无效");
  const targetPath = await realpath(resolve(sourceDirectory, rawPath));
  if (!isInside(targetPath, sourceDirectory)) throw new Error("外部附件必须位于 Markdown 文件所在目录内");
  const metadata = await stat(targetPath);
  if (!metadata.isFile()) throw new Error("外部附件不是文件");
  const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg" };
  const mimeType = mimeTypes[extname(targetPath).toLowerCase()];
  if (!mimeType) throw new Error("该外部附件格式不支持预览");
  return { absolutePath: targetPath, size: metadata.size, mimeType };
};

export const attachmentReferences = (documentState = {}) => {
  const markdown = String(documentState.markdown || "");
  const html = String(documentState.html || "");
  const references = new Set();
  for (const match of markdown.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
    const path = match[1].split("|")[0].split("#")[0].trim();
    if (path) references.add(path);
  }
  for (const match of markdown.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['\"][^'"]*['"])?\)/g)) {
    const path = decodeURIComponent(String(match[1] || match[2] || "")).trim();
    if (path && !/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith("//")) references.add(path);
  }
  for (const match of html.matchAll(/data-attachment-path=["']([^"']+)["']/g)) if (match[1]) references.add(match[1]);
  const collectStructuredReferences = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => collectStructuredReferences(entry, seen));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (typeof entryValue === "string" && ["relativePath", "thumbnailRelativePath", "attachmentPath", "file"].includes(entryKey)) {
        const path = entryValue.replaceAll("\\", "/").trim();
        if (path && !/^[a-z][a-z\d+.-]*:/i.test(path) && !path.startsWith("//") && !path.startsWith("/api/")) references.add(path);
      } else if (entryValue && typeof entryValue === "object") collectStructuredReferences(entryValue, seen);
    }
  };
  collectStructuredReferences(documentState);
  return [...references];
};

export const copyReferencedAttachments = async ({ appRoot, sourceWorkspacePath, sourceDocumentId, sourceDocument, targetWorkspacePath, knownReplacements = new Map() }) => {
  const copied = [];
  const replacements = new Map(knownReplacements);
  for (const sourceReference of attachmentReferences(sourceDocument)) {
    if (replacements.has(sourceReference)) continue;
    try {
      let absolutePath;
      if (isTemporaryNotebookPath(sourceWorkspacePath)) {
        const entry = await temporaryManifestEntry(sourceDocumentId);
        if (!entry) continue;
        const base = dirname(await realpath(entry.path));
        const candidate = await realpath(resolve(base, sourceReference));
        if (!isInside(candidate, base)) continue;
        absolutePath = candidate;
      } else {
        absolutePath = (await readWorkspaceAttachmentContent({ appRoot, requestedPath: sourceWorkspacePath, relativePath: sourceReference, documentId: sourceDocumentId })).absolutePath;
      }
      const attachment = await saveWorkspaceAttachmentFromPath({ appRoot, requestedPath: targetWorkspacePath, sourcePath: absolutePath, name: basename(absolutePath) });
      copied.push(attachment);
      replacements.set(sourceReference, attachment.relativePath);
    } catch {
      // An unavailable optional embed must not block moving the Markdown body.
      // The original source remains untouched, so the user can repair it later.
    }
  }
  return { copied, replacements };
};

const replaceAttachmentReferences = (value, replacements) => {
  let next = String(value || "");
  for (const [source, target] of replacements) next = next.split(source).join(target);
  return next;
};

const uniqueDocumentTitle = (state, preferred) => {
  const used = new Set(Object.values(state.documents || {}).map((document) => String(document?.title || "").trim().toLowerCase()));
  const base = String(preferred || "未命名笔记").trim() || "未命名笔记";
  if (!used.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base} (${suffix})`.toLowerCase())) suffix += 1;
  return `${base} (${suffix})`;
};

const removeDocumentFromState = (workspaceState, documentId) => {
  delete workspaceState.documents?.[documentId];
  delete workspaceState.histories?.[documentId];
  for (const moduleId of Object.keys(workspaceState.moduleItems || {})) {
    workspaceState.moduleItems[moduleId] = (workspaceState.moduleItems[moduleId] || []).filter(([id]) => id !== documentId);
  }
  for (const conversation of workspaceState.conversations || []) {
    if (conversation.boundDocumentId === documentId) conversation.boundDocumentId = null;
    conversation.references = (conversation.references || []).filter((reference) => reference.documentId !== documentId);
  }
  if (workspaceState.activeDocument === documentId) workspaceState.activeDocument = Object.keys(workspaceState.documents || {})[0] || null;
};

const cleanupCopiedAttachments = async (targetWorkspacePath, copied) => {
  const targetRoot = resolve(targetWorkspacePath);
  for (const attachment of copied) {
    const target = resolve(targetRoot, String(attachment.relativePath || ""));
    if (isInside(target, targetRoot)) await rm(target, { force: true }).catch(() => {});
  }
};

export const removeTemporaryNotebookDocuments = async (documentIds = []) => {
  const removed = new Set((documentIds ?? []).map((id) => String(id || "")).filter(Boolean));
  if (!removed.size) return loadTemporaryNotebookState();
  await writeManifest((current) => ({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    activeDocumentId: removed.has(current.activeDocumentId) ? "" : current.activeDocumentId,
    entries: current.entries.filter((entry) => !removed.has(entry.id)),
  }));
  return loadTemporaryNotebookState();
};

const rollbackTargetWorkspace = async ({ appRoot, targetWorkspacePath, originalState, committed, copied }) => {
  const rollbackState = structuredClone(originalState);
  rollbackState.savedAt = committed.savedAt || rollbackState.savedAt;
  await saveWorkspaceState({ appRoot, requestedPath: targetWorkspacePath, state: rollbackState, expectedStateStamp: committed.stateStamp || "" });
  await cleanupCopiedAttachments(targetWorkspacePath, copied);
};

export const moveNotebookDocument = async ({ appRoot, sourceWorkspacePath, documentId, targetWorkspacePath }) => {
  if (!documentId) throw new Error("缺少要移动的文档");
  if (!targetWorkspacePath || isTemporaryNotebookPath(targetWorkspacePath)) throw new Error("请选择一个正式笔记本作为目标");
  const targetRoot = resolveWorkspaceRoot({ appRoot, requestedPath: targetWorkspacePath });
  const temporarySource = isTemporaryNotebookPath(sourceWorkspacePath);
  if (!temporarySource && normalizePathKey(sourceWorkspacePath) === normalizePathKey(targetRoot)) throw new Error("文档已经位于该笔记本中");

  const sourceLoaded = temporarySource
    ? await loadTemporaryNotebookState({ activeDocumentId: documentId })
    : await loadWorkspaceState({ appRoot, requestedPath: sourceWorkspacePath });
  const sourceState = sourceLoaded.state;
  if (!sourceState || sourceState.workspaceKind !== "notebook") throw new Error("源笔记本不可读取");
  const sourceDocument = sourceState.documents?.[documentId];
  if (!sourceDocument || sourceDocument.documentKind === "whiteboard" || sourceDocument.virtual) throw new Error("只有普通 Markdown 笔记可以跨笔记本移动");
  if (sourceDocument.externalMissing) throw new Error("原始 Markdown 文件当前不可读取，无法移动");

  const targetLoaded = await loadWorkspaceState({ appRoot, requestedPath: targetRoot });
  if (!targetLoaded.state) throw new Error("目标笔记本尚未完成初始化，请先在神思中打开一次后再移动");
  if (targetLoaded.state.workspaceKind !== "notebook") throw new Error("目标不是笔记本");
  const targetState = structuredClone(targetLoaded.state);
  const targetOriginalState = structuredClone(targetLoaded.state);
  const targetDocumentId = `note-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const title = uniqueDocumentTitle(targetState, sourceDocument.title);
  const { copied, replacements } = await copyReferencedAttachments({ appRoot, sourceWorkspacePath, sourceDocumentId: documentId, sourceDocument, targetWorkspacePath: targetRoot });
  const markdown = replaceAttachmentReferences(sourceDocument.markdown, replacements);
  const movedDocument = {
    ...structuredClone(sourceDocument),
    title,
    markdown,
    html: markdownToHtml(externalPreviewMarkdown(markdown)),
    updatedAt: new Date().toISOString(),
    moduleId: "library",
    workspaceView: "default",
    contextDomain: "general",
    placementOverride: true,
    documentKind: "note",
  };
  for (const key of ["externalMarkdown", "externalMissing", "externalSourcePath", "externalSize", "externalModifiedAt", "readOnly", "derived", "virtual", "contentRef", "sourcePath", "sourceImportPath", "customFolderId", "customFolderPath"]) delete movedDocument[key];
  targetState.documents[targetDocumentId] = movedDocument;
  targetState.histories ??= {};
  targetState.histories[targetDocumentId] = structuredClone(sourceState.histories?.[documentId] || []);
  targetState.moduleItems ??= {};
  targetState.moduleItems.library ??= [];
  targetState.moduleItems.library.push([targetDocumentId, title, { workspaceView: "default", contextDomain: "general", placementOverride: true }]);
  targetState.activeModule = "library";
  targetState.activeDocument = targetDocumentId;
  const activeConversation = targetState.conversations?.find((conversation) => conversation.id === targetState.activeConversationId)
    || targetState.conversations?.[0];
  if (activeConversation) activeConversation.boundDocumentId = targetDocumentId;
  targetState.activities = [{ id: `activity-${randomUUID()}`, type: "edit", label: `从其他笔记本移入“${title}”`, documentId: targetDocumentId, createdAt: new Date().toISOString() }, ...(targetState.activities || [])];

  let targetCommitted;
  try {
    targetCommitted = await saveWorkspaceState({ appRoot, requestedPath: targetRoot, state: targetState, expectedStateStamp: targetLoaded.stateStamp || "" });
    targetState.savedAt = targetCommitted.savedAt;
  } catch (error) {
    await cleanupCopiedAttachments(targetRoot, copied);
    throw error;
  }

  try {
    if (temporarySource) {
      await writeManifest((current) => ({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        activeDocumentId: current.activeDocumentId === documentId ? "" : current.activeDocumentId,
        entries: current.entries.filter((entry) => entry.id !== documentId),
      }));
    } else {
      const sourceNext = structuredClone(sourceState);
      removeDocumentFromState(sourceNext, documentId);
      sourceNext.activities = [{ id: `activity-${randomUUID()}`, type: "edit", label: `将“${sourceDocument.title}”移动到笔记本“${targetState.projectName || basename(targetRoot)}”`, createdAt: new Date().toISOString() }, ...(sourceNext.activities || [])];
      await saveWorkspaceState({ appRoot, requestedPath: sourceWorkspacePath, state: sourceNext, expectedStateStamp: sourceLoaded.stateStamp || "" });
    }
  } catch (error) {
    try {
      await rollbackTargetWorkspace({ appRoot, targetWorkspacePath: targetRoot, originalState: targetOriginalState, committed: targetCommitted, copied });
    } catch (rollbackError) {
      throw new Error(`源笔记本未能移除文档，且目标因并发变化无法回滚；两侧内容均已保留，请重新加载后核对：${error.message}`);
    }
    throw new Error(`源笔记本未能安全移除文档，目标写入已回滚：${error.message}`);
  }

  return {
    sourceTemporary: temporarySource,
    sourceWorkspacePath,
    targetWorkspacePath: targetRoot,
    targetWorkspaceName: targetState.projectName || basename(targetRoot),
    targetDocumentId,
    targetState,
    targetStateStamp: targetCommitted.stateStamp,
    copiedAttachmentCount: copied.length,
  };
};

export const temporaryNotebookSaveReceipt = async () => ({
  workspaceRoot: TEMPORARY_NOTEBOOK_PATH,
  savedAt: new Date().toISOString(),
  stateStamp: await temporaryNotebookStateStamp(),
  temporary: true,
  readOnly: true,
});

export const temporaryAttachmentStream = ({ absolutePath, start, end }) => createReadStream(absolutePath, Number.isFinite(start) ? { start, end } : undefined);
