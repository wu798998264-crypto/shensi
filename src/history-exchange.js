const PAYLOAD_KEYS = new Set([
  "html", "document", "documents", "state", "moduleItems", "customFolders",
  "contentHash", "integrityHash", "integritySchemaVersion", "verified",
]);

export const historyMetadata = (entry = {}) => Object.fromEntries(
  Object.entries(entry).filter(([key]) => !PAYLOAD_KEYS.has(key)),
);

export const prepareHistoryRestore = ({ entries = [], selectedId, preservedCurrent }) => {
  const index = entries.findIndex((entry) => entry.id === selectedId);
  if (index < 0 || !preservedCurrent) return null;
  const selected = structuredClone(entries[index]);
  const preserved = structuredClone(preservedCurrent);
  return {
    entries: [preserved, ...structuredClone(entries)],
    selected,
    preserved,
    index,
  };
};
