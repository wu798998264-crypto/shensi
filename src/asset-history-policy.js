const normalizedPath = (value) => String(value || "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "")
  .normalize("NFC")
  .toLocaleLowerCase();

const normalizedId = (value) => String(value || "").trim();

export const ASSET_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const validIso = (value) => {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
};

export const assetHistoryIdentity = (asset = {}) => ({
  assetId: normalizedId(asset.id),
  generationJobId: normalizedId(asset.generationJobId || asset.generation?.jobId),
  relativePath: normalizedPath(asset.attachment?.relativePath || asset.relativePath || asset.file),
});

const identityHasValue = (identity) => Boolean(identity.assetId || identity.generationJobId || identity.relativePath);

export const assetHistoryIdentitiesMatch = (left, right) => {
  // A single generation job may yield several sibling files. When both
  // records have an asset id, that id is authoritative; otherwise deleting
  // one sibling would also tombstone every image/video/audio from the job.
  if (left.assetId && right.assetId) return left.assetId === right.assetId;
  if (left.relativePath && right.relativePath) return left.relativePath === right.relativePath;
  return Boolean(left.generationJobId && right.generationJobId && left.generationJobId === right.generationJobId);
};

export const normalizeAssetHistoryTombstones = (values = [], { now = new Date().toISOString() } = {}) => {
  const normalizedNow = validIso(now) || new Date().toISOString();
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    const identity = assetHistoryIdentity(value);
    if (!identityHasValue(identity) || normalized.some((item) => assetHistoryIdentitiesMatch(item, identity))) continue;
    // Legacy "hidden" entries had no retention contract. Start their 30-day
    // clock when they are first migrated so an upgrade cannot immediately
    // destroy assets that may have been hidden months ago.
    const deletedAt = validIso(value?.deletedAt)
      || (value?.hiddenAt ? normalizedNow : validIso(value?.createdAt))
      || normalizedNow;
    const purgedAt = validIso(value?.purgedAt || value?.permanentlyDeletedAt);
    normalized.push({
      ...identity,
      deletedAt,
      expiresAt: validIso(value?.expiresAt) || new Date(Date.parse(deletedAt) + ASSET_TRASH_RETENTION_MS).toISOString(),
      ...(purgedAt ? { purgedAt, status: "purged" } : { status: "trashed" }),
      ...(value?.hiddenAt && !value?.deletedAt ? { legacyHiddenAt: validIso(value.hiddenAt) || String(value.hiddenAt) } : {}),
    });
  }
  return normalized;
};

const nodeReferencesIdentity = (node = {}, identity) => {
  if (identity.assetId && normalizedId(node.assetId) === identity.assetId) return true;
  if (identity.generationJobId && normalizedId(node.generation?.jobId || node.generationJobId) === identity.generationJobId) return true;
  return Boolean(identity.relativePath && normalizedPath(node.file || node.attachment?.relativePath) === identity.relativePath);
};

const documentTextReferencesPath = (documentState = {}, relativePath = "") => {
  if (!relativePath) return false;
  const source = [documentState.html, documentState.markdown, documentState.content, documentState.text]
    .filter((value) => typeof value === "string")
    .join("\n")
    .replace(/\\/g, "/")
    .normalize("NFC")
    .toLocaleLowerCase();
  if (!source) return false;
  const decoded = (() => {
    try { return decodeURIComponent(source); } catch { return source; }
  })();
  const encodedPath = encodeURI(relativePath).toLocaleLowerCase();
  return source.includes(relativePath) || decoded.includes(relativePath) || source.includes(encodedPath);
};

export const assetHistoryEntryIsReferenced = (workspace = {}, asset = {}) => {
  const identity = assetHistoryIdentity(asset);
  if (!identityHasValue(identity)) return false;
  return Object.values(workspace.documents || {}).some((documentState) => {
    const nodes = Array.isArray(documentState?.canvas?.nodes) ? documentState.canvas.nodes : [];
    if (nodes.some((node) => nodeReferencesIdentity(node, identity))) return true;
    return documentTextReferencesPath(documentState, identity.relativePath);
  });
};

export const assetHistoryEntryIsSuppressed = (workspace = {}, asset = {}) => {
  const identity = assetHistoryIdentity(asset);
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones)
    .some((tombstone) => assetHistoryIdentitiesMatch(tombstone, identity));
};

export const assetHistoryTrashEntry = (workspace = {}, asset = {}) => {
  const identity = assetHistoryIdentity(asset);
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones)
    .find((entry) => assetHistoryIdentitiesMatch(entry, identity)) || null;
};

export const assetHistoryEntryIsTrashed = (workspace = {}, asset = {}) => {
  const entry = assetHistoryTrashEntry(workspace, asset);
  return Boolean(entry && entry.status !== "purged");
};

export const assetHistoryEntryIsPurged = (workspace = {}, asset = {}) => {
  return assetHistoryTrashEntry(workspace, asset)?.status === "purged";
};

export const moveHistoricalAssetsToTrash = (workspace = {}, assets = [], { now = new Date().toISOString() } = {}) => {
  const selected = (Array.isArray(assets) ? assets : [assets]).filter(Boolean);
  const protectedAssets = [];
  const deletedAssets = selected;
  const deletedIdentities = deletedAssets.map(assetHistoryIdentity).filter(identityHasValue);
  const deletedAt = validIso(now) || new Date().toISOString();
  let tombstones = normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones, { now: deletedAt });
  for (const identity of deletedIdentities) {
    tombstones = tombstones.filter((tombstone) => !assetHistoryIdentitiesMatch(tombstone, identity));
    tombstones.push({
      ...identity,
      deletedAt,
      expiresAt: new Date(Date.parse(deletedAt) + ASSET_TRASH_RETENTION_MS).toISOString(),
      status: "trashed",
    });
  }
  return {
    workspace: {
      ...workspace,
      documents: workspace.documents,
      workspaceAssets: workspace.workspaceAssets,
      assetHistoryTombstones: tombstones,
    },
    deletedAssets,
    protectedAssets,
  };
};

export const restoreHistoricalAssets = (workspace = {}, assets = []) => {
  const identities = (Array.isArray(assets) ? assets : [assets]).filter(Boolean)
    .map(assetHistoryIdentity)
    .filter(identityHasValue);
  if (!identities.length) return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones);
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones)
    .filter((entry) => entry.status === "purged" || !identities.some((identity) => assetHistoryIdentitiesMatch(entry, identity)));
};

export const expiredAssetTrashEntries = (workspace = {}, { now = new Date().toISOString() } = {}) => {
  const timestamp = Date.parse(validIso(now) || new Date().toISOString());
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones, { now })
    .filter((entry) => entry.status !== "purged" && Date.parse(entry.expiresAt) <= timestamp);
};

const assetMatchesAnyIdentity = (asset, identities) => {
  const candidate = assetHistoryIdentity(asset);
  return identities.some((identity) => assetHistoryIdentitiesMatch(candidate, identity));
};

export const permanentlyDeleteHistoricalAssets = (workspace = {}, assets = [], { now = new Date().toISOString() } = {}) => {
  const selected = (Array.isArray(assets) ? assets : [assets]).filter(Boolean);
  const identities = selected.map(assetHistoryIdentity).filter(identityHasValue);
  if (!identities.length) return { workspace, deletedAssets: [] };
  const purgedAt = validIso(now) || new Date().toISOString();
  const documents = Object.fromEntries(Object.entries(workspace.documents || {}).map(([documentId, documentState]) => {
    const canvas = documentState?.canvas;
    if (!Array.isArray(canvas?.assets)) return [documentId, documentState];
    const assetsAfterDelete = canvas.assets.filter((asset) => !assetMatchesAnyIdentity(asset, identities));
    if (assetsAfterDelete.length === canvas.assets.length) return [documentId, documentState];
    return [documentId, { ...documentState, canvas: { ...canvas, assets: assetsAfterDelete } }];
  }));
  let tombstones = normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones, { now: purgedAt })
    .filter((entry) => !identities.some((identity) => assetHistoryIdentitiesMatch(entry, identity)));
  tombstones.push(...identities.map((identity) => ({
    ...identity,
    deletedAt: purgedAt,
    expiresAt: purgedAt,
    purgedAt,
    status: "purged",
  })));
  return {
    workspace: {
      ...workspace,
      documents,
      workspaceAssets: (Array.isArray(workspace.workspaceAssets) ? workspace.workspaceAssets : [])
        .filter((asset) => !assetMatchesAnyIdentity(asset, identities)),
      assetHistoryTombstones: tombstones,
    },
    deletedAssets: selected,
  };
};

export const restoreReferencedAssetHistoryTombstones = (workspace = {}, candidates = []) => {
  const referenced = (Array.isArray(candidates) ? candidates : [candidates])
    .filter((asset) => assetHistoryEntryIsReferenced(workspace, asset))
    .map(assetHistoryIdentity);
  if (!referenced.length) return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones);
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones)
    .filter((entry) => entry.status === "purged" || !referenced.some((identity) => assetHistoryIdentitiesMatch(entry, identity)));
};
