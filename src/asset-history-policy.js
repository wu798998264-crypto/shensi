const normalizedPath = (value) => String(value || "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "")
  .normalize("NFC")
  .toLocaleLowerCase();

const normalizedId = (value) => String(value || "").trim();

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

export const normalizeAssetHistoryTombstones = (values = []) => {
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    const identity = assetHistoryIdentity(value);
    if (!identityHasValue(identity) || normalized.some((item) => assetHistoryIdentitiesMatch(item, identity))) continue;
    normalized.push({
      ...identity,
      hiddenAt: String(value?.hiddenAt || value?.createdAt || new Date().toISOString()),
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

export const hideHistoricalAssets = (workspace = {}, assets = [], { now = new Date().toISOString() } = {}) => {
  const selected = (Array.isArray(assets) ? assets : [assets]).filter(Boolean);
  const protectedAssets = [];
  const deletedAssets = selected;
  const deletedIdentities = deletedAssets.map(assetHistoryIdentity).filter(identityHasValue);
  let tombstones = normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones);
  for (const identity of deletedIdentities) {
    tombstones = tombstones.filter((tombstone) => !assetHistoryIdentitiesMatch(tombstone, identity));
    tombstones.push({ ...identity, hiddenAt: now });
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

export const unhideHistoricalAssets = (workspace = {}, assets = []) => {
  const identities = (Array.isArray(assets) ? assets : [assets]).filter(Boolean)
    .map(assetHistoryIdentity)
    .filter(identityHasValue);
  if (!identities.length) return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones);
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones)
    .filter((tombstone) => !identities.some((identity) => assetHistoryIdentitiesMatch(tombstone, identity)));
};

export const restoreReferencedAssetHistoryTombstones = (workspace = {}, candidates = []) => {
  const referenced = (Array.isArray(candidates) ? candidates : [candidates])
    .filter((asset) => assetHistoryEntryIsReferenced(workspace, asset))
    .map(assetHistoryIdentity);
  if (!referenced.length) return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones);
  return normalizeAssetHistoryTombstones(workspace.assetHistoryTombstones)
    .filter((tombstone) => !referenced.some((identity) => assetHistoryIdentitiesMatch(tombstone, identity)));
};
