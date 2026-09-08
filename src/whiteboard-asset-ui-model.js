const ASSET_ORIGINS = new Set(["upload", "generated", "unknown"]);
const ASSET_KINDS = new Set(["text", "image", "video", "audio"]);

export const normalizeHistoricalAssetFilters = ({ origin = "all", kind = "all" } = {}) => ({
  origin: origin === "notebook" ? "upload" : ASSET_ORIGINS.has(origin) ? origin : "all",
  kind: ASSET_KINDS.has(kind) ? kind : "all",
});

export const filterHistoricalAssets = (assets = [], filters = {}) => {
  const { origin, kind } = normalizeHistoricalAssetFilters(filters);
  return (Array.isArray(assets) ? assets : []).filter((asset) => (
    (origin === "all" || (asset?.origin === "notebook" ? "upload" : asset?.origin) === origin)
    && (kind === "all" || asset?.kind === kind)
  ));
};

export const historicalAssetSelection = ({ assets = [], selectedIds = new Set() } = {}) => {
  const ids = assets.map((asset) => String(asset?.id || "")).filter(Boolean);
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let selectedCount = 0;
  for (const id of ids) if (selected.has(id)) selectedCount += 1;
  return {
    ids,
    selectedCount,
    allSelected: ids.length > 0 && selectedCount === ids.length,
  };
};

export const toggleFilteredAssetSelection = ({ assets = [], selectedIds = new Set() } = {}) => {
  const selected = new Set(selectedIds instanceof Set ? selectedIds : selectedIds || []);
  const { ids, allSelected } = historicalAssetSelection({ assets, selectedIds: selected });
  for (const id of ids) {
    if (allSelected) selected.delete(id);
    else selected.add(id);
  }
  return selected;
};
