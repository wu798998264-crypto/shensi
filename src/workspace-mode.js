export const normalizeWorkspaceKind = (workspaceKind) => workspaceKind === "notebook" ? "notebook" : "project";

const normalizedPath = (workspacePath) => String(workspacePath || "").trim().toLowerCase();

export const resolveWorkspaceModeSelection = ({
  workspaceKind,
  workspacePath,
  nextKind,
  preferredWorkspacePath = "",
  projects = [],
  notebooks = [],
} = {}) => {
  const kind = normalizeWorkspaceKind(nextKind);
  const entries = kind === "notebook" ? notebooks : projects;
  const durableEntries = entries.filter((entry) => entry?.temporary !== true);
  const currentPath = normalizedPath(workspacePath);
  const currentEntry = workspaceKind === kind
    ? entries.find((entry) => normalizedPath(entry?.workspacePath) === currentPath)
    : null;
  if (currentEntry) return { action: "resume", kind, entry: currentEntry };
  const preferredPath = normalizedPath(preferredWorkspacePath);
  const preferredEntry = preferredPath
    ? entries.find((entry) => normalizedPath(entry?.workspacePath) === preferredPath)
    : null;
  // Temporary Markdown previews appear at the top of the notebook list, but a
  // broad “switch to notes” action should resume a managed notebook whenever
  // one exists. Temporary previews remain directly selectable and resumable.
  if (preferredEntry && (preferredEntry.temporary !== true || !durableEntries.length)) {
    return { action: "switch", kind, entry: preferredEntry };
  }
  const fallbackEntry = durableEntries[0] || entries[0];
  if (fallbackEntry) return { action: "switch", kind, entry: fallbackEntry };
  return { action: "empty", kind, entry: null };
};

export const workspaceKindHasEntry = ({ workspaceKind, workspacePath, projects = [], notebooks = [] } = {}) => {
  const kind = normalizeWorkspaceKind(workspaceKind);
  const entries = kind === "notebook" ? notebooks : projects;
  const currentPath = normalizedPath(workspacePath);
  return Boolean(currentPath && entries.some((entry) => normalizedPath(entry?.workspacePath) === currentPath));
};
