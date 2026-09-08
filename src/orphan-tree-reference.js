export const orphanTreeReferenceTrashPayload = ({ documentId, located, fallbackModuleId = "library" } = {}) => {
  const id = String(documentId || "").trim();
  const item = Array.isArray(located?.item) ? structuredClone(located.item) : null;
  if (!id || !item || String(item[0] || "") !== id) return null;
  const moduleId = String(located?.moduleId || fallbackModuleId || "library");
  const label = String(item[1] || id).trim() || id;
  return {
    title: label,
    moduleId,
    item,
    moduleItems: { [moduleId]: [item] },
    structure: [{ type: "document", id, label, missingContent: true }],
    missingContentReference: true,
  };
};

export const directoryDeletionDocumentIds = ({
  tokens = [],
  documents = {},
  directoryItemIds = [],
  tree = [],
} = {}) => {
  const selected = new Set(tokens);
  const knownDirectoryItems = new Set(directoryItemIds);
  const documentIds = new Set();
  for (const token of selected) {
    if (!String(token).startsWith("document:")) continue;
    const documentId = String(token).slice("document:".length);
    if (documents[documentId] || knownDirectoryItems.has(documentId)) documentIds.add(documentId);
  }
  const collectDocuments = (node) => {
    if (node?.type === "document") {
      if (node.id) documentIds.add(node.id);
      return;
    }
    for (const child of node?.children ?? []) collectDocuments(child);
  };
  const visit = (nodes) => {
    for (const node of nodes ?? []) {
      if (node?.type !== "folder") continue;
      if (selected.has(`folder:${node.id}`)) collectDocuments(node);
      visit(node.children ?? []);
    }
  };
  visit(tree);
  return [...documentIds];
};
