const clean = (value = "") => String(value ?? "").trim();

export const cardHistoryViewModel = ({ current = null, versions = [] } = {}) => {
  const currentId = clean(current?.id);
  const byId = new Map();
  for (const version of Array.isArray(versions) ? versions : []) {
    const id = clean(version?.id);
    if (id) byId.set(id, { ...version, id });
  }
  if (currentId) byId.set(currentId, { ...(byId.get(currentId) ?? {}), ...current, id: currentId });
  const ordered = [...byId.values()].sort((left, right) => {
    if (left.id === currentId) return -1;
    if (right.id === currentId) return 1;
    return Number(right.version || 0) - Number(left.version || 0)
      || String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  });
  return ordered.map((version) => ({
    ...version,
    current: version.id === currentId,
    actionLabel: version.id === currentId ? "当前版本" : "设为当前",
  }));
};

export const canDeleteCardHistoryVersion = ({
  versionId = "",
  currentVersionId = "",
  versionCount = 0,
} = {}) => Boolean(
  clean(versionId)
  && clean(versionId) !== clean(currentVersionId)
  && Number(versionCount) > 1
);

