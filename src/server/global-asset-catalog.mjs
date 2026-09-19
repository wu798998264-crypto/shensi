import { createHash } from "node:crypto";
import { canonicalAssetEventIso, generationAssetQualifiesForHistory } from "../whiteboard.js";
import { mergeGlobalHistoricalAssets } from "../global-history-assets.js";
import { assetHistoryEntryIsPurged, assetHistoryTrashEntry } from "../asset-history-policy.js";
import {
  listWorkspaceNotebooks,
  listWorkspaceProjects,
  loadWorkspaceCurrentContent,
  readWorkspaceAttachmentContent,
} from "./workspace.mjs";

export const GLOBAL_ASSET_TEXT_LIMIT = 200_000;

const MEDIA_KINDS = new Set(["image", "video", "audio"]);
const VALID_KINDS = new Set(["text", ...MEDIA_KINDS]);
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const normalizedWorkspacePath = (value = "") => String(value || "")
  .replaceAll("\\", "/")
  .replace(/\/+$/, "")
  .normalize("NFC")
  .toLocaleLowerCase();

const normalizedAttachmentPath = (value = "") => {
  const source = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!source || source.startsWith("/") || /^[a-z]:\//i.test(source) || source.includes("\0")) return "";
  const parts = source.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
};

const earliestStableIso = (...values) => {
  const timestamps = values.map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : EPOCH_ISO;
};

const boundedText = (value, limit = GLOBAL_ASSET_TEXT_LIMIT) => String(value ?? "").slice(0, Math.max(1, Number(limit) || GLOBAL_ASSET_TEXT_LIMIT));

const htmlAttributeValue = (attributes = "", name = "") => {
  const match = String(attributes).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
};

const baseName = (relativePath = "") => String(relativePath || "").replaceAll("\\", "/").split("/").at(-1) || "附件";

const mimeTypeForMedia = (kind, relativePath = "") => {
  const extension = String(relativePath).match(/\.([a-z\d]+)$/i)?.[1]?.toLowerCase() || "";
  const known = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  };
  return known[extension] || `${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "mpeg"}`;
};

const mediaReferencesFromDocument = (documentState = {}) => {
  const references = [];
  const seen = new Set();
  const html = String(documentState.html || "");
  const pattern = /<(img|video|audio)\b([^>]*)>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1].toLowerCase();
    const attributes = match[2] || "";
    const relativePath = normalizedAttachmentPath(htmlAttributeValue(attributes, "data-attachment-path"));
    if (!relativePath) continue;
    const key = relativePath.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = tag === "img" ? "image" : tag;
    const name = htmlAttributeValue(attributes, tag === "img" ? "alt" : "aria-label")
      || htmlAttributeValue(attributes, "title")
      || baseName(relativePath);
    references.push({
      kind,
      attachment: {
        relativePath,
        name,
        mimeType: mimeTypeForMedia(kind, relativePath),
        size: 0,
      },
    });
  }
  return references;
};

export const globalAssetCatalogId = ({ workspacePath = "", sourceType = "", sourceId = "" } = {}) => (
  `global-asset-${createHash("sha256")
    .update(`${normalizedWorkspacePath(workspacePath)}\u0000${String(sourceType)}\u0000${String(sourceId)}`)
    .digest("hex")
    .slice(0, 24)}`
);

const sourceMetadata = ({ workspace, workspaceKind, sourceType, sourceId, documentId = "", title = "" }) => ({
  id: globalAssetCatalogId({ workspacePath: workspace.workspacePath, sourceType, sourceId }),
  catalogLinked: true,
  readOnlySource: true,
  catalogSourceType: sourceType,
  sourceWorkspaceKind: workspaceKind === "notebook" ? "notebook" : "project",
  sourceWorkspaceName: String(workspace.name || "未命名工作区"),
  sourceWorkspacePath: String(workspace.workspacePath || ""),
  sourceDocumentId: String(documentId || ""),
  sourceTitle: String(title || ""),
  sourceAvailable: true,
});

const normalizedWorkspaceAsset = ({ asset, workspace, workspaceKind, documentId = "", documentTitle = "", textLimit }) => {
  if (!generationAssetQualifiesForHistory(asset)) return null;
  const kind = VALID_KINDS.has(asset?.kind) ? asset.kind : "text";
  const sourceAssetId = String(asset?.id || "").trim();
  if (!sourceAssetId) return null;
  const attachmentPath = normalizedAttachmentPath(asset?.attachment?.relativePath);
  if (MEDIA_KINDS.has(kind) && !attachmentPath) return null;
  const resolvedDocumentId = String(asset.sourceDocumentId || documentId || "");
  const resolvedTitle = String(documentTitle || asset.nodeName || asset.attachment?.name || "");
  const sourceEventAt = canonicalAssetEventIso(asset);
  const record = {
    ...sourceMetadata({
      workspace,
      workspaceKind,
      sourceType: "workspace-asset",
      sourceId: sourceAssetId,
      documentId: resolvedDocumentId,
      title: resolvedTitle,
    }),
    sourceAssetId,
    kind,
    origin: asset.origin === "upload" || asset.origin === "notebook"
      ? "upload"
      : asset.origin === "generated" && (asset.generationJobId || asset.prompt || Number(asset.elapsedMs) > 0 || (kind === "text" && asset.sourceNodeId))
        ? "generated"
        : MEDIA_KINDS.has(kind) && !(asset.generationJobId || asset.prompt || Number(asset.elapsedMs) > 0)
          ? "upload"
          : "unknown",
    text: kind === "text" ? boundedText(asset.text, textLimit) : "",
    prompt: String(asset.prompt || ""),
    elapsedMs: Math.max(0, Number(asset.elapsedMs) || 0),
    // An asset without a persisted event time is intentionally left unknown;
    // workspace save/install time is not an asset creation time.
    createdAt: sourceEventAt,
    ...(sourceEventAt ? { sourceEventAt } : {}),
    sourceNodeId: String(asset.sourceNodeId || ""),
    nodeName: String(asset.nodeName || ""),
    source: ["conversation", "whiteboard", "asset-library"].includes(asset.source) ? asset.source : "",
    ...(attachmentPath ? { sourceRelativePath: attachmentPath } : {}),
    aspectRatio: Math.min(10, Math.max(0.1, Number(asset.aspectRatio) || (kind === "image" ? 1 : 16 / 9))),
    ...(asset.conversationId ? { conversationId: String(asset.conversationId) } : {}),
    ...(asset.messageId ? { messageId: String(asset.messageId) } : {}),
    ...(asset.generationJobId ? { generationJobId: String(asset.generationJobId) } : {}),
    ...(asset.novelCover ? { novelCover: structuredClone(asset.novelCover) } : {}),
  };
  if (attachmentPath) {
    record.attachment = {
      relativePath: attachmentPath,
      name: String(asset.attachment?.name || baseName(attachmentPath)),
      mimeType: String(asset.attachment?.mimeType || mimeTypeForMedia(kind, attachmentPath)),
      size: Math.max(0, Number(asset.attachment?.size) || 0),
      ...(asset.attachment?.sha256 ? { sha256: String(asset.attachment.sha256) } : {}),
      ...(asset.attachment?.objectHash ? { objectHash: String(asset.attachment.objectHash) } : {}),
      ...(normalizedAttachmentPath(asset.attachment?.thumbnailRelativePath) ? { thumbnailRelativePath: normalizedAttachmentPath(asset.attachment.thumbnailRelativePath) } : {}),
      ...(asset.attachment?.thumbnailMimeType ? { thumbnailMimeType: String(asset.attachment.thumbnailMimeType) } : {}),
      ...(Number(asset.attachment?.durationMs) > 0 ? { durationMs: Math.max(1, Number(asset.attachment.durationMs)) } : {}),
    };
  }
  return record;
};

export const buildWorkspaceAssetCatalog = ({
  workspace = {},
  workspaceKind = "project",
  state = {},
  textLimit = GLOBAL_ASSET_TEXT_LIMIT,
} = {}) => {
  const records = [];
  const sourceAssetIds = new Set();
  const mediaByPath = new Map();
  const appendWorkspaceAsset = (asset, documentId = "", documentTitle = "") => {
    if (assetHistoryEntryIsPurged(state, asset)) return;
    const sourceAssetId = String(asset?.id || "").trim();
    if (!sourceAssetId || sourceAssetIds.has(sourceAssetId)) return;
    const record = normalizedWorkspaceAsset({ asset, workspace, workspaceKind, documentId, documentTitle, textLimit });
    if (!record) return;
    const trashEntry = assetHistoryTrashEntry(state, asset);
    if (trashEntry?.status === "trashed") {
      record.assetTrash = {
        status: "trashed",
        deletedAt: trashEntry.deletedAt,
        expiresAt: trashEntry.expiresAt,
      };
    }
    sourceAssetIds.add(sourceAssetId);
    records.push(record);
    if (record.attachment?.relativePath) mediaByPath.set(record.attachment.relativePath.toLocaleLowerCase(), record);
  };

  for (const asset of Array.isArray(state.workspaceAssets) ? state.workspaceAssets : []) appendWorkspaceAsset(asset);
  for (const [documentId, documentState] of Object.entries(state.documents || {})) {
    if (documentState?.documentKind !== "whiteboard") continue;
    for (const asset of Array.isArray(documentState.canvas?.assets) ? documentState.canvas.assets : []) {
      appendWorkspaceAsset(asset, documentId, documentState.title);
    }
  }

  if (workspaceKind !== "notebook") return records;

  for (const [documentId, documentState] of Object.entries(state.documents || {})) {
    if (!documentState || documentState.virtual || documentId === "library-trash" || documentState.documentKind === "whiteboard") continue;
    const title = String(documentState.title || documentId);
    const sourceAvailable = documentState.externalMissing !== true;
    for (const media of mediaReferencesFromDocument(documentState)) {
      if (assetHistoryEntryIsPurged(state, media)) continue;
      const relativePath = media.attachment.relativePath;
      const pathKey = relativePath.toLocaleLowerCase();
      const existing = mediaByPath.get(pathKey);
      if (existing) {
        if (!existing.sourceDocumentId) existing.sourceDocumentId = documentId;
        if (!existing.sourceTitle) existing.sourceTitle = title;
        existing.sourceAvailable = existing.sourceAvailable && sourceAvailable;
        continue;
      }
      const sourceId = `${documentId}:${relativePath}`;
      const record = {
        ...sourceMetadata({ workspace, workspaceKind, sourceType: "notebook-attachment", sourceId, documentId, title }),
        sourceAvailable,
        sourceAssetId: "",
        kind: media.kind,
        origin: "upload",
        text: "",
        prompt: "",
        elapsedMs: 0,
        // The file probe below supplies birthtime/ctime when available. Never
        // substitute the document or workspace save time for an attachment.
        createdAt: "",
        sourceNodeId: "",
        nodeName: media.attachment.name,
        source: "notebook",
        sourceRelativePath: relativePath,
        aspectRatio: media.kind === "image" ? 1 : 16 / 9,
        attachment: media.attachment,
      };
      const trashEntry = assetHistoryTrashEntry(state, media);
      if (trashEntry?.status === "trashed") {
        record.assetTrash = {
          status: "trashed",
          deletedAt: trashEntry.deletedAt,
          expiresAt: trashEntry.expiresAt,
        };
      }
      records.push(record);
      mediaByPath.set(pathKey, record);
    }
  }
  return records;
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), source.length) }, async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(source[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

export const collectGlobalAssetCatalog = async ({
  appRoot,
  adapters = {},
  maxWorkspacesPerKind = 100,
  concurrency = 4,
} = {}) => {
  const listProjects = adapters.listProjects || ((options) => listWorkspaceProjects(options));
  const listNotebooks = adapters.listNotebooks || ((options) => listWorkspaceNotebooks(options));
  const loadWorkspace = adapters.loadWorkspace || (async (options) => ({ state: await loadWorkspaceCurrentContent(options) }));
  const checkAttachment = adapters.checkAttachment || ((options) => readWorkspaceAttachmentContent(options));
  const diagnostics = [];
  const listKind = async (workspaceKind, loader) => {
    try {
      const values = await loader({ appRoot });
      return (Array.isArray(values) ? values : []).slice(0, Math.max(1, Number(maxWorkspacesPerKind) || 100)).map((workspace) => ({ workspaceKind, workspace }));
    } catch (error) {
      diagnostics.push({ type: "workspace-list", workspaceKind, workspaceName: "", workspacePath: "", message: String(error?.message || error) });
      return [];
    }
  };
  const [projects, notebooks] = await Promise.all([
    listKind("project", listProjects),
    listKind("notebook", listNotebooks),
  ]);
  const workspaces = [...projects, ...notebooks];
  const groups = await mapWithConcurrency(workspaces, concurrency, async ({ workspaceKind, workspace }) => {
    try {
      const loaded = await loadWorkspace({ appRoot, requestedPath: workspace.workspacePath });
      if (!loaded?.state) throw new Error("工作区当前状态不存在");
      return buildWorkspaceAssetCatalog({ workspace, workspaceKind, state: loaded.state });
    } catch (error) {
      diagnostics.push({
        type: "workspace-load",
        workspaceKind,
        workspaceName: String(workspace.name || ""),
        workspacePath: String(workspace.workspacePath || ""),
        message: String(error?.message || error),
      });
      return [];
    }
  });
  const items = groups.flat();
  await mapWithConcurrency(items.filter((item) => item.attachment?.relativePath), Math.max(2, concurrency * 2), async (item) => {
    try {
      const result = await checkAttachment({
        appRoot,
        requestedPath: item.sourceWorkspacePath,
        relativePath: item.attachment.relativePath,
        documentId: item.sourceDocumentId,
      });
      item.sourceAvailable = item.sourceAvailable !== false;
      if (result?.mimeType && !item.attachment.mimeType) item.attachment.mimeType = String(result.mimeType);
      if (result?.createdAt && !item.sourceEventAt) {
        const recoveredEventAt = earliestStableIso(item.createdAt, result.createdAt);
        item.createdAt = recoveredEventAt;
        item.sourceEventAt = recoveredEventAt;
      }
    } catch (error) {
      item.sourceAvailable = false;
      diagnostics.push({
        type: "attachment",
        workspaceKind: item.sourceWorkspaceKind,
        workspaceName: item.sourceWorkspaceName,
        workspacePath: item.sourceWorkspacePath,
        documentId: item.sourceDocumentId,
        relativePath: item.attachment.relativePath,
        message: String(error?.message || error),
      });
    }
  });
  const deduplicatedItems = mergeGlobalHistoricalAssets({ catalogAssets: items });
  deduplicatedItems.sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0) || left.id.localeCompare(right.id));
  diagnostics.sort((left, right) => `${left.workspacePath}\u0000${left.relativePath || ""}`.localeCompare(`${right.workspacePath}\u0000${right.relativePath || ""}`));
  return { items: deduplicatedItems, diagnostics, scannedAt: new Date().toISOString() };
};
