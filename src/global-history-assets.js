import {
  generationAssetQualifiesForHistory,
  normalizeGenerationAsset,
  normalizeGenerationAssets,
} from "./whiteboard.js";

const normalizedWorkspacePath = (value = "") => String(value || "")
  .trim()
  .replaceAll("\\", "/")
  .replace(/\/+$/, "")
  .normalize("NFC")
  .toLocaleLowerCase();

export const historicalAssetSourceIdentity = (asset = {}, currentWorkspacePath = "") => {
  const workspacePath = normalizedWorkspacePath(asset.sourceWorkspacePath || currentWorkspacePath);
  const sourceType = String(asset.catalogSourceType || "workspace-asset");
  const sourceId = String(asset.sourceAssetId
    || (sourceType === "notebook-document" ? asset.sourceDocumentId : "")
    || (sourceType === "notebook-attachment" ? `${asset.sourceDocumentId || ""}:${asset.sourceRelativePath || asset.attachment?.relativePath || ""}` : "")
    || asset.id
    || "");
  return `${workspacePath}\u0000${sourceType}\u0000${sourceId}`;
};

const uploadedMediaHash = (asset = {}) => (
  asset.origin === "upload" && ["image", "video", "audio"].includes(asset.kind)
    ? String(asset.attachment?.sha256 || asset.attachment?.objectHash || "").trim().toLowerCase()
    : ""
);

export const historicalAssetDedupIdentity = (asset = {}, currentWorkspacePath = "") => {
  const contentHash = uploadedMediaHash(asset);
  return contentHash
    ? `upload-content\u0000${asset.kind}\u0000${contentHash}`
    : historicalAssetSourceIdentity(asset, currentWorkspacePath);
};

const mediaKindForAttachment = (attachment = {}) => {
  const mimeType = String(attachment.mimeType || "").toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "";
};

export const conversationAttachmentUploadAsset = ({
  attachment = {},
  conversationId = "",
  messageId = "",
  sourceDocumentId = "",
  createdAt = "",
} = {}) => {
  if (!attachment?.relativePath || attachment.source === "historical-asset" || attachment.historicalAssetReferenceKey || attachment.referenceType === "book") return null;
  const kind = mediaKindForAttachment(attachment);
  if (!kind) return null;
  const timestamp = [attachment.uploadedAt, attachment.createdAt, createdAt]
    .map((value) => String(value || ""))
    .find((value) => Number.isFinite(Date.parse(value))) || "";
  const identity = String(attachment.id || attachment.sha256 || attachment.objectHash || attachment.relativePath);
  return normalizeGenerationAsset({
    id: `conversation-upload-${conversationId || "conversation"}-${identity}`,
    kind,
    origin: "upload",
    source: "conversation",
    conversationId,
    messageId,
    sourceDocumentId,
    attachment,
    ...(timestamp ? { createdAt: new Date(timestamp).toISOString() } : {}),
  });
};

export const mergeGlobalHistoricalAssets = ({
  localAssets = [],
  catalogAssets = [],
  currentWorkspacePath = "",
  hiddenCatalogIds = new Set(),
} = {}) => {
  const hidden = hiddenCatalogIds instanceof Set ? hiddenCatalogIds : new Set(hiddenCatalogIds || []);
  const local = normalizeGenerationAssets(localAssets).filter(generationAssetQualifiesForHistory);
  const entries = [];
  const positions = new Map();
  const append = (asset, localPriority) => {
    const identity = historicalAssetDedupIdentity(asset, currentWorkspacePath);
    const position = positions.get(identity);
    if (position === undefined) {
      positions.set(identity, entries.length);
      entries.push({ asset, localPriority });
      return;
    }
    const current = entries[position];
    const currentTime = Date.parse(current.asset.createdAt || "") || 0;
    const candidateTime = Date.parse(asset.createdAt || "") || 0;
    if (candidateTime > currentTime || (candidateTime === currentTime && localPriority > current.localPriority)) {
      entries[position] = { asset, localPriority };
    }
  };
  for (const asset of local) append(asset, 1);
  const seenCatalogIds = new Set();
  for (const value of Array.isArray(catalogAssets) ? catalogAssets : []) {
    if (!value?.id || hidden.has(String(value.id)) || seenCatalogIds.has(String(value.id))) continue;
    seenCatalogIds.add(String(value.id));
    const asset = normalizeGenerationAsset(value);
    if (!asset || !generationAssetQualifiesForHistory(asset)) continue;
    append(asset, 0);
  }
  return entries.map((entry) => entry.asset);
};

export const assetNeedsWorkspaceMaterialization = (asset = {}, currentWorkspacePath = "") => (
  ["image", "video", "audio"].includes(asset.kind)
  && Boolean(asset.attachment?.relativePath)
  && Boolean(asset.sourceWorkspacePath)
  && normalizedWorkspacePath(asset.sourceWorkspacePath) !== normalizedWorkspacePath(currentWorkspacePath)
);
