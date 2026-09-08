const pathKey = (value) => String(value ?? "").trim().replaceAll("\\", "/").toLowerCase();

export const workspaceEntryKey = (entry) => pathKey(entry?.workspacePath);

export const orderWorkspaceEntries = (entries = [], orderedPaths = []) => {
  const source = Array.isArray(entries) ? entries : [];
  const ranks = new Map((Array.isArray(orderedPaths) ? orderedPaths : []).map((path, index) => [pathKey(path), index]));
  if (!ranks.size) return [...source];
  const known = source.filter((entry) => ranks.has(workspaceEntryKey(entry)));
  const unknown = source.filter((entry) => !ranks.has(workspaceEntryKey(entry)));
  known.sort((left, right) => ranks.get(workspaceEntryKey(left)) - ranks.get(workspaceEntryKey(right)));
  return [...unknown, ...known];
};

export const moveWorkspaceEntry = (entries = [], { sourcePath = "", targetPath = "", position = "before" } = {}) => {
  const sourceKey = pathKey(sourcePath);
  const targetKey = pathKey(targetPath);
  const next = [...entries];
  const sourceIndex = next.findIndex((entry) => workspaceEntryKey(entry) === sourceKey);
  if (sourceIndex < 0 || (targetKey && sourceKey === targetKey)) return next;
  const [moved] = next.splice(sourceIndex, 1);
  if (!targetKey) {
    next.push(moved);
    return next;
  }
  const targetIndex = next.findIndex((entry) => workspaceEntryKey(entry) === targetKey);
  if (targetIndex < 0) {
    next.push(moved);
    return next;
  }
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, moved);
  return next;
};

export const replaceWorkspaceOrderPath = (orderedPaths = [], previousPath = "", nextPath = "") => {
  const previousKey = pathKey(previousPath);
  const nextValue = String(nextPath ?? "").trim();
  return orderedPaths.map((path) => pathKey(path) === previousKey ? nextValue : path);
};
