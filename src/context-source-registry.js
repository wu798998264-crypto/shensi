const compact = (value) => String(value ?? "").trim();

const normalizedPath = (value) => compact(value)
  .replace(/\\/g, "/")
  .replace(/\/{2,}/g, "/")
  .toLowerCase();

const normalizedContent = (value) => compact(value)
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n");

// A small deterministic fingerprint is enough for local exact-duplicate detection.
// It is not used as a security hash or as a persistent document identifier.
export const contextContentFingerprint = (value) => {
  const source = normalizedContent(value);
  if (!source) return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${source.length}-${hash.toString(16).padStart(8, "0")}`;
};

const normalizedReasons = (value) => [...new Set((Array.isArray(value) ? value : [value])
  .map(compact)
  .filter(Boolean))];

const sourceKeys = (source = {}) => {
  const keys = [];
  const documentId = compact(source.documentId || source.id);
  const versionId = compact(source.versionId || "current");
  const path = normalizedPath(source.relativePath || source.absolutePath || source.path);
  const content = source.text ?? source.content ?? "";
  const fingerprint = contextContentFingerprint(content);
  if (documentId) keys.push(`document:${documentId}:${versionId}`);
  if (path) keys.push(`path:${path}`);
  if (fingerprint && normalizedContent(content).length >= 80) keys.push(`content:${fingerprint}`);
  return keys;
};

const mergeSource = (current, incoming) => ({
  ...current,
  ...incoming,
  // Prefer the fuller readable representation while preserving the first stable identity.
  ...((compact(current.text ?? current.content).length >= compact(incoming.text ?? incoming.content).length)
    ? { text: current.text, content: current.content }
    : {}),
  id: current.id || incoming.id,
  documentId: current.documentId || incoming.documentId,
  versionId: current.versionId || incoming.versionId,
  relativePath: current.relativePath || incoming.relativePath,
  absolutePath: current.absolutePath || incoming.absolutePath,
  reasons: normalizedReasons([...(current.reasons ?? []), ...(incoming.reasons ?? [])]),
  required: current.required === true || incoming.required === true,
  priority: Math.max(Number(current.priority) || 0, Number(incoming.priority) || 0),
});

export const mergeContextSources = (sources = []) => {
  const merged = [];
  const keyToIndex = new Map();
  const duplicates = [];
  for (const rawSource of Array.isArray(sources) ? sources : []) {
    if (!rawSource) continue;
    const source = {
      ...rawSource,
      reasons: normalizedReasons(rawSource.reasons ?? rawSource.reason),
      contentFingerprint: contextContentFingerprint(rawSource.text ?? rawSource.content ?? ""),
    };
    const keys = sourceKeys(source);
    const matchedIndex = keys.map((key) => keyToIndex.get(key)).find((index) => index !== undefined);
    if (matchedIndex === undefined) {
      const index = merged.length;
      merged.push(source);
      keys.forEach((key) => keyToIndex.set(key, index));
      continue;
    }
    duplicates.push({ kept: merged[matchedIndex], duplicate: source });
    merged[matchedIndex] = mergeSource(merged[matchedIndex], source);
    sourceKeys(merged[matchedIndex]).forEach((key) => keyToIndex.set(key, matchedIndex));
  }
  return { sources: merged, duplicates };
};

export const deduplicateAttachments = (attachments = [], { projectContext = "" } = {}) => {
  const registry = mergeContextSources((Array.isArray(attachments) ? attachments : []).map((attachment) => ({
    ...attachment,
    reasons: ["用户附件"],
    required: true,
  })));
  const context = normalizedContent(projectContext);
  const sources = registry.sources.filter((attachment) => {
    const text = normalizedContent(attachment.text ?? attachment.content ?? "");
    // Cross-channel removal is deliberately exact: an excerpt in project context must not
    // suppress a fuller attachment. Only a complete readable duplicate is removed.
    return !(text.length >= 80 && context.includes(text));
  });
  return {
    attachments: sources,
    duplicateCount: registry.duplicates.length + (registry.sources.length - sources.length),
  };
};
