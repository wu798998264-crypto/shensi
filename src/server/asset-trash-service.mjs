import {
  assetHistoryIdentity,
  moveHistoricalAssetsToTrash,
  permanentlyDeleteHistoricalAssets,
  restoreHistoricalAssets,
} from "../asset-history-policy.js";
import {
  loadWorkspaceState,
  permanentlyDeleteWorkspaceAttachment,
  saveWorkspaceState,
} from "./workspace.mjs";

const normalizeAssetDescriptor = (asset = {}) => ({
  id: String(asset.sourceAssetId || (!asset.catalogLinked ? asset.id || asset.assetId : "") || "").trim(),
  generationJobId: String(asset.generationJobId || asset.generation?.jobId || "").trim(),
  attachment: {
    relativePath: String(asset.sourceRelativePath || asset.attachment?.relativePath || asset.relativePath || asset.file || "").trim(),
    thumbnailRelativePath: String(asset.attachment?.thumbnailRelativePath || "").trim(),
  },
});

const normalizedPath = (value) => String(value || "")
  .trim()
  .replaceAll("\\", "/")
  .replace(/^\.\//, "")
  .normalize("NFC")
  .toLocaleLowerCase();

const stateReferencesPath = (state = {}, relativePath = "") => {
  const target = normalizedPath(relativePath);
  if (!target) return false;
  const { assetHistoryTombstones: _trashEntries, ...searchableState } = state;
  const source = JSON.stringify(searchableState).replaceAll("\\\\", "/").normalize("NFC").toLocaleLowerCase();
  let decoded = source;
  try { decoded = decodeURIComponent(source); } catch {}
  return source.includes(target) || decoded.includes(target) || source.includes(encodeURI(target).toLocaleLowerCase());
};

const deleteUnreferencedFiles = async ({ appRoot, requestedPath, state, assets }) => {
  const fileResults = [];
  const candidatePaths = [...new Set(assets.flatMap((asset) => [
    asset.attachment.relativePath,
    asset.attachment.thumbnailRelativePath,
  ]).map(normalizedPath).filter(Boolean))];
  for (const relativePath of candidatePaths) {
    if (stateReferencesPath(state, relativePath)) {
      fileResults.push({ relativePath, deleted: false, retainedBecauseReferenced: true });
      continue;
    }
    try {
      const result = await permanentlyDeleteWorkspaceAttachment({ appRoot, requestedPath, relativePath });
      fileResults.push({ relativePath, ...result, retainedBecauseReferenced: false });
    } catch (error) {
      fileResults.push({ relativePath, deleted: false, retainedBecauseReferenced: false, error: String(error?.message || error) });
    }
  }
  return fileResults;
};

export const deleteUnreferencedAssetTrashFiles = async ({ appRoot, requestedPath, assets = [] } = {}) => {
  const normalizedAssets = (Array.isArray(assets) ? assets : [assets]).map(normalizeAssetDescriptor);
  const loaded = await loadWorkspaceState({ appRoot, requestedPath });
  if (!loaded.state) throw new Error("资产所属作品或笔记不存在");
  return {
    fileResults: await deleteUnreferencedFiles({
      appRoot,
      requestedPath: loaded.workspaceRoot,
      state: loaded.state,
      assets: normalizedAssets,
    }),
  };
};

const mutateAssetTrashEntries = async ({ appRoot, requestedPath, assets = [], mode, now = new Date().toISOString() }) => {
  const normalizedAssets = (Array.isArray(assets) ? assets : [assets])
    .map(normalizeAssetDescriptor)
    .filter((asset) => {
      const identity = assetHistoryIdentity(asset);
      return Boolean(identity.assetId || identity.generationJobId || identity.relativePath);
    });
  if (!normalizedAssets.length) throw new Error(mode === "restore" ? "没有可恢复的资产" : "没有可移入回收站的资产");
  const loaded = await loadWorkspaceState({ appRoot, requestedPath });
  if (!loaded.state) throw new Error("资产所属作品或笔记不存在");
  const assetHistoryTombstones = mode === "restore"
    ? restoreHistoricalAssets(loaded.state, normalizedAssets)
    : moveHistoricalAssetsToTrash(loaded.state, normalizedAssets, { now }).workspace.assetHistoryTombstones;
  const saved = await saveWorkspaceState({
    appRoot,
    requestedPath: loaded.workspaceRoot,
    state: { ...loaded.state, assetHistoryTombstones },
    expectedStateStamp: loaded.stateStamp,
    historySource: mode === "restore" ? "asset-trash-restore" : "asset-trash-delete",
  });
  return {
    count: normalizedAssets.length,
    workspacePath: loaded.workspaceRoot,
    savedAt: saved.savedAt,
    stateStamp: saved.stateStamp,
    assetHistoryTombstones,
  };
};

export const moveAssetEntriesToTrash = (options = {}) => mutateAssetTrashEntries({ ...options, mode: "trash" });
export const restoreAssetTrashEntries = (options = {}) => mutateAssetTrashEntries({ ...options, mode: "restore" });

export const permanentlyDeleteAssetTrashEntries = async ({
  appRoot,
  requestedPath,
  assets = [],
  now = new Date().toISOString(),
} = {}) => {
  const normalizedAssets = (Array.isArray(assets) ? assets : [assets])
    .map(normalizeAssetDescriptor)
    .filter((asset) => {
      const identity = assetHistoryIdentity(asset);
      return Boolean(identity.assetId || identity.generationJobId || identity.relativePath);
    });
  if (!normalizedAssets.length) throw new Error("没有可彻底删除的资产");

  const loaded = await loadWorkspaceState({ appRoot, requestedPath });
  if (!loaded.state) throw new Error("资产所属作品或笔记不存在");
  const deletion = permanentlyDeleteHistoricalAssets(loaded.state, normalizedAssets, { now });
  const saved = await saveWorkspaceState({
    appRoot,
    requestedPath: loaded.workspaceRoot,
    state: deletion.workspace,
    expectedStateStamp: loaded.stateStamp,
    historySource: "asset-trash",
  });

  const fileResults = await deleteUnreferencedFiles({
    appRoot,
    requestedPath: loaded.workspaceRoot,
    state: deletion.workspace,
    assets: normalizedAssets,
  });

  return {
    deletedCount: normalizedAssets.length,
    workspacePath: loaded.workspaceRoot,
    savedAt: saved.savedAt,
    stateStamp: saved.stateStamp,
    assetHistoryTombstones: deletion.workspace.assetHistoryTombstones,
    workspaceAssets: deletion.workspace.workspaceAssets,
    fileResults,
  };
};
