const entries = (value = {}) => Object.entries(value && typeof value === "object" ? value : {});

export const changedWriteTargetRevisionIds = ({ expectedRevisions = {}, currentRevisions = {} } = {}) => entries(expectedRevisions)
  .filter(([documentId, revision]) => String(revision || "") !== String(currentRevisions?.[documentId] || ""))
  .map(([documentId]) => documentId)
  .sort();

export const liveWriteTargetDecision = ({ action = "", expectedRevisions = {}, currentRevisions = {}, workspaceMatches = true, useLatestRequested = true, preserveLockedRequested = false } = {}) => {
  const changedDocumentIds = changedWriteTargetRevisionIds({ expectedRevisions, currentRevisions });
  if (!changedDocumentIds.length) return { action: workspaceMatches ? "use_current" : "use_pinned_workspace", changedDocumentIds };
  if (String(action) === "rename") return { action: "rebase_title_only", changedDocumentIds };
  return { action: preserveLockedRequested || useLatestRequested === false ? "preserve_locked_snapshot" : "regenerate_from_latest", changedDocumentIds };
};
