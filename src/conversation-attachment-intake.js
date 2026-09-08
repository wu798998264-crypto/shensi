import { historicalAssetSourceIdentity } from "./global-history-assets.js";
import { modelAttachmentCapabilities } from "./model-presets.js";

export const getDynamicAttachmentLimit = (settings = {}, dynamicModels = []) => {
  const capabilities = modelAttachmentCapabilities(settings, dynamicModels);
  return Math.max(0, capabilities.maxTotal);
};

export const validateConversationAttachments = (attachments = [], settings = {}, dynamicModels = []) => {
  const capabilities = modelAttachmentCapabilities(settings, dynamicModels);
  const files = Array.isArray(attachments) ? attachments : [];
  const images = files.filter((item) => String(item?.mimeType || item?.type || "").startsWith("image/"));
  const nonImages = files.length - images.length;
  if (files.length > capabilities.maxTotal) return { valid: false, code: "MAX_ATTACHMENTS", capabilities };
  if (images.length > capabilities.maxImages) return { valid: false, code: "MAX_IMAGES", capabilities };
  if (nonImages > capabilities.maxFiles) return { valid: false, code: "MAX_FILES", capabilities };
  const totalBytes = files.reduce((total, item) => total + Math.max(0, Number(item?.size || item?.bytes || 0)), 0);
  if (files.some((item) => Number(item?.size || item?.bytes || 0) > capabilities.maxFileBytes)) return { valid: false, code: "MAX_FILE_BYTES", capabilities };
  if (totalBytes > capabilities.maxTotalBytes) return { valid: false, code: "MAX_TOTAL_BYTES", capabilities };
  return { valid: true, capabilities, totalBytes };
};

export const composerDataTransferHasFiles = (dataTransfer) => (
  Array.from(dataTransfer?.files ?? []).length > 0
  || Array.from(dataTransfer?.items ?? []).some((item) => item?.kind === "file")
  || Array.from(dataTransfer?.types ?? []).includes("Files")
);

export const historicalAssetConversationReferenceKey = (asset = {}, currentWorkspacePath = "") => (
  historicalAssetSourceIdentity(asset, currentWorkspacePath)
);

export const conversationReferencesHistoricalAsset = (conversation = {}, asset = {}, currentWorkspacePath = "") => {
  const key = historicalAssetConversationReferenceKey(asset, currentWorkspacePath);
  return Boolean(key && (conversation.attachments ?? []).some((attachment) => attachment?.historicalAssetReferenceKey === key));
};

export const historicalAssetConversationAttachment = ({
  asset = {},
  storedAttachment = {},
  id = "",
  currentWorkspacePath = "",
} = {}) => {
  const referenceKey = historicalAssetConversationReferenceKey(asset, currentWorkspacePath);
  if (!id || !referenceKey) return null;
  const kind = ["image", "video", "audio", "text"].includes(asset.kind) ? asset.kind : "text";
  const attachment = {
    ...structuredClone(storedAttachment || {}),
    id: String(id),
    name: String(storedAttachment?.name || asset.attachment?.name || asset.nodeName || `历史${kind === "text" ? "文本" : "资产"}`),
    mimeType: String(storedAttachment?.mimeType || asset.attachment?.mimeType || (kind === "text" ? "text/plain" : "application/octet-stream")),
    source: "historical-asset",
    historicalAssetReferenceKey: referenceKey,
    historicalAssetId: String(asset.id || ""),
    historicalAssetKind: kind,
    sourceWorkspacePath: String(asset.sourceWorkspacePath || currentWorkspacePath || ""),
    sourceWorkspaceKind: asset.sourceWorkspaceKind === "notebook" ? "notebook" : "project",
    sourceDocumentId: String(asset.sourceDocumentId || ""),
    sourceTitle: String(asset.sourceTitle || asset.nodeName || ""),
    prompt: String(asset.prompt || ""),
  };
  if (kind === "text" && String(asset.text || "").trim()) attachment.text = String(asset.text);
  return attachment;
};
