const PAYLOAD_KEYS = new Set([
  "html", "document", "documents", "state", "moduleItems", "customFolders",
  "contentHash", "integrityHash", "integritySchemaVersion", "verified",
]);

export const historyMetadata = (entry = {}) => Object.fromEntries(
  Object.entries(entry).filter(([key]) => !PAYLOAD_KEYS.has(key)),
);

export const prepareHistoryRestore = ({ entries = [], selectedId }) => {
  const index = entries.findIndex((entry) => entry.id === selectedId);
  if (index < 0) return null;
  const selected = structuredClone(entries[index]);
  return {
    entries: structuredClone(entries),
    selected,
    index,
  };
};
