export const SETTINGS_HISTORY_SCHEMA_VERSION = 1;
export const SETTINGS_HISTORY_LIMIT = 50;
export const SETTINGS_HISTORY_SCOPES = Object.freeze(["quick", "basic", "typography"]);

const validIso = (value, fallback = Date.now()) => {
  const parsed = Date.parse(value ?? "");
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
};

const normalizedShortcuts = (value = {}) => Object.fromEntries(Object.entries(value ?? {})
  .filter(([id, shortcut]) => id && typeof shortcut === "string")
  .sort(([left], [right]) => left.localeCompare(right)));

export const settingsSnapshotForScope = (scope, preferences = {}) => {
  if (scope === "quick") return { shortcuts: normalizedShortcuts(preferences.shortcuts) };
  if (scope === "basic") return { uiLanguage: preferences.uiLanguage === "en-US" ? "en-US" : "zh-CN" };
  if (scope === "typography") return {
    editorFontFamily: ["songti", "sans", "kaiti", "fangsong"].includes(preferences.editorFontFamily)
      ? preferences.editorFontFamily : "songti",
    editorMaxWidth: String(Math.min(1600, Math.max(360, Number(preferences.editorMaxWidth) || 800))),
    editorFontSize: String(Math.min(24, Math.max(13, Number(preferences.editorFontSize) || 17))),
    editorLineHeight: String(Math.min(2.4, Math.max(1.2, Number(preferences.editorLineHeight) || 1.85))),
  };
  return {};
};

const snapshotSignature = (scope, snapshot) => JSON.stringify(settingsSnapshotForScope(scope, snapshot));

const normalizeEntry = (entry, scope, index) => ({
  id: String(entry?.id || `settings-${scope}-v${index + 1}`),
  version: Math.max(1, Math.floor(Number(entry?.version) || index + 1)),
  createdAtIso: validIso(entry?.createdAtIso ?? entry?.createdAt, index),
  reason: ["initial", "saved", "restored", "migrated"].includes(entry?.reason) ? entry.reason : "saved",
  snapshot: settingsSnapshotForScope(scope, entry?.snapshot ?? entry),
});

export const normalizeSettingsHistoryEntries = (entries, scope) => (Array.isArray(entries) ? entries : [])
  .map((entry, index) => normalizeEntry(entry, scope, index))
  .filter((entry, index, items) => items.findIndex((candidate) => candidate.version === entry.version) === index)
  .sort((left, right) => left.version - right.version)
  .slice(-SETTINGS_HISTORY_LIMIT);

export const appendSettingsHistoryVersion = (entries, scope, snapshot, {
  reason = "saved",
  now = Date.now(),
  force = false,
} = {}) => {
  const history = normalizeSettingsHistoryEntries(entries, scope);
  const normalizedSnapshot = settingsSnapshotForScope(scope, snapshot);
  const latest = history.at(-1);
  if (!force && latest && snapshotSignature(scope, latest.snapshot) === snapshotSignature(scope, normalizedSnapshot)) return history;
  const version = Math.max(0, ...history.map((entry) => entry.version)) + 1;
  return [...history, {
    id: `settings-${scope}-v${version}-${Math.max(0, Number(now) || Date.now()).toString(36)}`,
    version,
    createdAtIso: new Date(now).toISOString(),
    reason: ["initial", "saved", "restored", "migrated"].includes(reason) ? reason : "saved",
    snapshot: normalizedSnapshot,
  }].slice(-SETTINGS_HISTORY_LIMIT);
};

export const normalizeSettingsHistories = (value, currentPreferences = {}) => {
  const source = value?.entries && typeof value.entries === "object" ? value.entries : value ?? {};
  const entries = {};
  for (const scope of SETTINGS_HISTORY_SCOPES) {
    const history = normalizeSettingsHistoryEntries(source?.[scope], scope);
    const explicitlyStored = Object.prototype.hasOwnProperty.call(source, scope);
    entries[scope] = history.length || explicitlyStored
      ? history
      : appendSettingsHistoryVersion([], scope, currentPreferences, { reason: "initial", force: true });
  }
  return { schemaVersion: SETTINGS_HISTORY_SCHEMA_VERSION, entries };
};

export const deleteSettingsHistoryVersion = (historyState, scope, versionId, currentPreferences = {}) => {
  if (!SETTINGS_HISTORY_SCOPES.includes(scope)) throw new Error("设置历史作用域无效");
  const normalized = normalizeSettingsHistories(historyState, currentPreferences);
  const selected = normalized.entries[scope].find((entry) => entry.id === versionId);
  if (!selected) throw new Error("设置历史版本不存在");
  return {
    history: {
      schemaVersion: SETTINGS_HISTORY_SCHEMA_VERSION,
      entries: {
        ...normalized.entries,
        [scope]: normalized.entries[scope].filter((entry) => entry.id !== versionId),
      },
    },
    deleted: selected,
  };
};

export const appendChangedSettingsHistories = (historyState, previousPreferences, nextPreferences, { now = Date.now() } = {}) => {
  const normalized = normalizeSettingsHistories(historyState, previousPreferences);
  const changedScopes = [];
  const entries = { ...normalized.entries };
  for (const scope of SETTINGS_HISTORY_SCOPES) {
    const before = settingsSnapshotForScope(scope, previousPreferences);
    const after = settingsSnapshotForScope(scope, nextPreferences);
    if (snapshotSignature(scope, before) === snapshotSignature(scope, after)) continue;
    entries[scope] = appendSettingsHistoryVersion(entries[scope], scope, after, { reason: "saved", now });
    changedScopes.push(scope);
  }
  return { history: { schemaVersion: SETTINGS_HISTORY_SCHEMA_VERSION, entries }, changedScopes };
};

export const restoreSettingsHistoryVersion = (historyState, scope, versionId, currentPreferences, { now = Date.now() } = {}) => {
  if (!SETTINGS_HISTORY_SCOPES.includes(scope)) throw new Error("设置历史作用域无效");
  const normalized = normalizeSettingsHistories(historyState, currentPreferences);
  const selected = normalized.entries[scope].find((entry) => entry.id === versionId);
  if (!selected) throw new Error("设置历史版本不存在");
  const entries = { ...normalized.entries };
  entries[scope] = appendSettingsHistoryVersion(entries[scope], scope, selected.snapshot, { reason: "restored", now, force: true });
  return {
    history: { schemaVersion: SETTINGS_HISTORY_SCHEMA_VERSION, entries },
    snapshot: settingsSnapshotForScope(scope, selected.snapshot),
    restoredFrom: selected,
    current: entries[scope].at(-1),
  };
};
