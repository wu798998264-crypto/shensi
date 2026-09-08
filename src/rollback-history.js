const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const documentSignature = (documentState) => documentState ? stableStringify({
  title: documentState.title ?? "",
  html: documentState.html ?? "",
  markdown: documentState.markdown ?? "",
  moduleId: documentState.moduleId ?? "",
  workspaceView: documentState.workspaceView ?? "",
  contextDomain: documentState.contextDomain ?? "",
}) : "__missing__";

const documentPlacement = (moduleItems = {}, documentId) => {
  for (const [moduleId, items] of Object.entries(moduleItems ?? {})) {
    const index = (items ?? []).findIndex(([id]) => id === documentId);
    if (index < 0) continue;
    return { moduleId, index, item: items[index] };
  }
  return null;
};

export const rollbackDocumentChanges = ({ current = {}, target = {} } = {}) => {
  const currentDocuments = current.documents ?? {};
  const targetDocuments = target.documents ?? {};
  const documentIds = new Set([...Object.keys(currentDocuments), ...Object.keys(targetDocuments)]);
  const changes = [];

  for (const documentId of documentIds) {
    const currentPlacement = documentPlacement(current.moduleItems, documentId);
    const targetPlacement = documentPlacement(target.moduleItems, documentId);
    const contentChanged = documentSignature(currentDocuments[documentId]) !== documentSignature(targetDocuments[documentId]);
    const structuralChanged = stableStringify(currentPlacement) !== stableStringify(targetPlacement);
    if (!contentChanged && !structuralChanged) continue;
    changes.push({
      documentId,
      contentChanged,
      structuralChanged,
      currentPlacement,
      targetPlacement,
    });
  }
  return changes;
};
