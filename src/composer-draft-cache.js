export const WORKSPACE_COMPOSER_DRAFT_CHARS = 20_000;
export const RECOVERY_COMPOSER_DRAFT_CHARS = 500_000;
export const COMPOSER_DRAFT_CHUNK_CHARS = 16_000;
export const COMPOSER_DRAFT_CACHE_KEY = "shensi-composer-drafts-v2";
const LEGACY_COMPOSER_DRAFT_CACHE_KEY = "shensi-composer-drafts-v1";
const CHUNK_PREFIX = `${COMPOSER_DRAFT_CACHE_KEY}:chunk:`;
const MAX_CACHE_ENTRIES = 80;
const clearedKey = (id) => `${COMPOSER_DRAFT_CACHE_KEY}:cleared:${encodeURIComponent(id)}`;

export const normalizeWorkspaceComposerDraft = (value = "") => String(value ?? "").slice(0, WORKSPACE_COMPOSER_DRAFT_CHARS);
export const normalizeRecoveryComposerDraft = (value = "") => String(value ?? "").slice(0, RECOVERY_COMPOSER_DRAFT_CHARS);

const readJson = (storage, key, fallback) => {
  try {
    return JSON.parse(storage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};

const writeManifest = (storage, manifest) => {
  storage.setItem(COMPOSER_DRAFT_CACHE_KEY, JSON.stringify(manifest));
};

const chunkKey = (id, index, generation = "") => `${CHUNK_PREFIX}${encodeURIComponent(id)}:${generation ? `${generation}:` : ""}${index}`;

const blankManifest = () => ({ schemaVersion: 2, entries: {} });

const readManifest = (storage) => {
  const manifest = readJson(storage, COMPOSER_DRAFT_CACHE_KEY, blankManifest());
  if (manifest?.schemaVersion !== 2 || !manifest.entries || typeof manifest.entries !== "object") return blankManifest();
  return manifest;
};

const removeEntryChunks = (storage, id, entry = {}) => {
  const count = Number(entry.chunkCount || 0);
  for (let index = 0; index < count; index += 1) storage.removeItem(chunkKey(id, index, entry.generation));
};

const pruneManifest = (storage, manifest) => {
  const entries = Object.entries(manifest.entries)
    .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0));
  for (const [id, entry] of entries.slice(MAX_CACHE_ENTRIES)) {
    removeEntryChunks(storage, id, entry);
    delete manifest.entries[id];
  }
};

export const readComposerDraftCacheState = (storage, id) => {
  if (!storage || !id) return { present: false, value: "" };
  const manifest = readManifest(storage);
  const entry = manifest.entries[id];
  if (entry) {
    if (entry.cleared) return { present: true, value: "", cleared: true };
    const chunks = [];
    for (let index = 0; index < Number(entry.chunkCount || 0); index += 1) {
      const chunk = storage.getItem(chunkKey(id, index, entry.generation));
      if (chunk == null) return { present: false, value: "" };
      chunks.push(chunk);
    }
    return { present: true, value: normalizeRecoveryComposerDraft(chunks.join("")) };
  }
  if (storage.getItem(clearedKey(id))) return { present: true, value: "", cleared: true };
  const legacy = readJson(storage, LEGACY_COMPOSER_DRAFT_CACHE_KEY, {});
  return { present: Object.hasOwn(legacy, id), value: normalizeRecoveryComposerDraft(legacy?.[id] ?? "") };
};

export const readComposerDraftCacheEntry = (storage, id) => readComposerDraftCacheState(storage, id).value;

export const writeComposerDraftCacheEntry = (storage, id, value = "") => {
  if (!storage || !id) return;
  const manifest = readManifest(storage);
  const existing = manifest.entries[id];
  const draft = normalizeRecoveryComposerDraft(value);
  const legacy = readJson(storage, LEGACY_COMPOSER_DRAFT_CACHE_KEY, {});
  if (Object.hasOwn(legacy, id)) {
    delete legacy[id];
    if (Object.keys(legacy).length) storage.setItem(LEGACY_COMPOSER_DRAFT_CACHE_KEY, JSON.stringify(legacy));
    else storage.removeItem(LEGACY_COMPOSER_DRAFT_CACHE_KEY);
  }
  if (!draft) {
    // Keep a standalone tombstone as well as the manifest entry. It survives
    // manifest pruning and still blocks a legacy or disk draft if a manifest
    // write fails after the user has already sent/cleared the text.
    storage.setItem(clearedKey(id), String(Date.now()));
    manifest.entries[id] = { cleared: true, chunkCount: 0, length: 0, updatedAt: Date.now() };
    try { writeManifest(storage, manifest); }
    finally { if (existing) removeEntryChunks(storage, id, existing); }
    return;
  }
  storage.removeItem(clearedKey(id));
  const chunks = [];
  for (let index = 0; index < draft.length; index += COMPOSER_DRAFT_CHUNK_CHARS) {
    chunks.push(draft.slice(index, index + COMPOSER_DRAFT_CHUNK_CHARS));
  }
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { chunks.forEach((chunk, index) => storage.setItem(chunkKey(id, index, generation), chunk)); }
  catch (error) { chunks.forEach((_, index) => storage.removeItem(chunkKey(id, index, generation))); throw error; }
  manifest.entries[id] = {
    length: draft.length,
    chunkCount: chunks.length,
    updatedAt: Date.now(),
    generation,
  };
  pruneManifest(storage, manifest);
  try { writeManifest(storage, manifest); }
  catch (error) { removeEntryChunks(storage, id, manifest.entries[id]); throw error; }
  if (existing) removeEntryChunks(storage, id, existing);
};
