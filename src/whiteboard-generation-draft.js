import { WHITEBOARD_RICH_PROMPT_MAX_CHARACTERS } from "./whiteboard-rich-prompt.js";

export const WHITEBOARD_GENERATION_DRAFT_CACHE_KEY = "shensi-whiteboard-generation-drafts-v1";

const CHANNELS = new Set(["text", "image", "video", "audio"]);
const MAX_ENTRIES = 120;
const MAX_OPEN_SESSIONS = 24;
const CURRENT_VERSION = 9;
const IMAGE_MODEL_MIGRATION_VERSION = 3;
const IMAGE_QUALITY_MIGRATION_VERSION = 8;

const cleanPart = (value) => String(value ?? "").trim().slice(0, 500);

export const whiteboardGenerationSurfaceIsActive = ({
  anchorWorkspaceId = "",
  anchorDocumentId = "",
  activeWorkspaceId = "",
  activeDocumentId = "",
  activeDocumentKind = "",
} = {}) => activeDocumentKind === "whiteboard"
  && cleanPart(anchorWorkspaceId) === cleanPart(activeWorkspaceId)
  && cleanPart(anchorDocumentId) === cleanPart(activeDocumentId);

const normalizeValues = (values) => Object.fromEntries(Object.entries(values && typeof values === "object" ? values : {})
  .filter(([key, value]) => key && (typeof value === "string" || typeof value === "boolean"))
  .map(([key, value]) => [cleanPart(key), typeof value === "boolean" ? value : String(value).slice(0, WHITEBOARD_RICH_PROMPT_MAX_CHARACTERS)]));

export const whiteboardGenerationDraftScope = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    workspaceId: cleanPart(source.workspaceId),
    documentId: cleanPart(source.documentId),
    nodeId: cleanPart(source.nodeId),
    channel: CHANNELS.has(source.channel) ? source.channel : "",
  };
};

export const whiteboardGenerationDraftKey = (scope) => {
  const normalized = whiteboardGenerationDraftScope(scope);
  return normalized.workspaceId && normalized.documentId && normalized.nodeId && normalized.channel
    ? [normalized.workspaceId, normalized.documentId, normalized.nodeId, normalized.channel].map(encodeURIComponent).join("::")
    : "";
};

export const preferredWhiteboardGenerationDraftForNode = (cache, {
  workspaceId = "",
  documentId = "",
  nodeId = "",
  channels = ["text", "image", "video", "audio"],
  requirePrompt = false,
} = {}) => {
  const normalized = normalizeWhiteboardGenerationDraftCache(cache);
  const allowedChannels = new Set((Array.isArray(channels) ? channels : [])
    .map((channel) => cleanPart(channel))
    .filter((channel) => CHANNELS.has(channel)));
  const scope = whiteboardGenerationDraftScope({ workspaceId, documentId, nodeId });
  if (!scope.workspaceId || !scope.documentId || !scope.nodeId || !allowedChannels.size) return null;
  return Object.values(normalized.entries)
    .filter((entry) => entry.workspaceId === scope.workspaceId
      && entry.documentId === scope.documentId
      && entry.nodeId === scope.nodeId
      && allowedChannels.has(entry.channel)
      && (!requirePrompt
        || String(entry.values?.[entry.channel === "text" ? "instruction" : "prompt"] || "").trim()
        || (entry.channel === "video" && entry.values?.generationMode === "smart_multiframe")))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
};

export const normalizeWhiteboardGenerationDraftCache = (value) => {
  const source = value && typeof value === "object" ? value : {};
  const sourceVersion = Math.max(0, Number(source.version) || 0);
  const entries = Object.fromEntries(Object.entries(source.entries && typeof source.entries === "object" ? source.entries : {})
    .map(([key, entry]) => {
      const scope = whiteboardGenerationDraftScope(entry);
      const canonicalKey = whiteboardGenerationDraftKey(scope);
      if (!canonicalKey || key !== canonicalKey) return null;
      const values = normalizeValues(entry.values);
      if (sourceVersion < IMAGE_MODEL_MIGRATION_VERSION && scope.channel === "image" && values.model === "gpt-image-1.5") values.model = "gpt-image-2";
      if (sourceVersion < IMAGE_QUALITY_MIGRATION_VERSION && scope.channel === "image" && values.quality === "standard") values.quality = "high";
      return [key, { ...scope, values, updatedAt: Math.max(0, Number(entry.updatedAt) || 0) }];
    })
    .filter(Boolean)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ENTRIES));
  const activeScope = whiteboardGenerationDraftScope(source.active);
  const activeKey = whiteboardGenerationDraftKey(activeScope);
  const active = activeKey && entries[activeKey]
    ? { ...activeScope, key: activeKey, collapsed: false, updatedAt: Math.max(0, Number(source.active?.updatedAt) || entries[activeKey].updatedAt) }
    : null;
  // Ordinary generation no longer has a bank of collapsed session strips.
  // Keep only the one actually active workbench; all other cards are restored
  // from their durable draft entry when the user clicks the card again.
  const openSessions = active ? [active] : [];
  return { version: CURRENT_VERSION, entries, openSessions: openSessions.slice(0, MAX_OPEN_SESSIONS), active };
};

export const updateWhiteboardGenerationDraftCache = (cache, scope, values, {
  active = true,
  open = active,
  collapsed = false,
  updatedAt = Date.now(),
} = {}) => {
  const normalized = normalizeWhiteboardGenerationDraftCache(cache);
  const cleanScope = whiteboardGenerationDraftScope(scope);
  const key = whiteboardGenerationDraftKey(cleanScope);
  if (!key) return normalized;
  const timestamp = Math.max(0, Number(updatedAt) || Date.now());
  const existing = normalized.entries[key];
  // Recovery may enumerate several historical failed jobs for the same card.
  // An older job must never replace the user's newer provider/model choice;
  // otherwise the workbench appears to jump to whichever old job happened to
  // be processed last (for example, a previous Xiaoyujie attempt).
  if (existing && existing.updatedAt > timestamp) return normalized;
  normalized.entries[key] = { ...cleanScope, values: normalizeValues(values), updatedAt: timestamp };
  normalized.entries = Object.fromEntries(Object.entries(normalized.entries)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ENTRIES));
  const session = { ...cleanScope, key, collapsed: collapsed === true, updatedAt: timestamp };
  normalized.openSessions = [
    ...normalized.openSessions.filter((item) => item.key !== key),
    ...(active ? [session] : []),
  ].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_OPEN_SESSIONS);
  normalized.active = active ? session : normalized.active?.key === key ? null : normalized.active;
  // `normalized` already satisfies every cache invariant: the new values and
  // scope are normalized, entries/sessions are sorted and capped, and active
  // points at the freshly inserted canonical entry. Normalizing the entire
  // 120-entry cache a second time made every prompt keystroke needlessly walk,
  // sort and clone all saved drafts again.
  return normalized;
};

export const duplicateWhiteboardGenerationDraftEntries = (cache, {
  workspaceId,
  documentId,
  sourceDocumentId = documentId,
  targetDocumentId = documentId,
  sourceNodeId,
  targetNodeId,
} = {}, { updatedAt = Date.now() } = {}) => {
  let normalized = normalizeWhiteboardGenerationDraftCache(cache);
  const sourceBase = whiteboardGenerationDraftScope({ workspaceId, documentId: sourceDocumentId, nodeId: sourceNodeId });
  const targetBase = whiteboardGenerationDraftScope({ workspaceId, documentId: targetDocumentId, nodeId: targetNodeId });
  if (!sourceBase.workspaceId || !sourceBase.documentId || !sourceBase.nodeId || !targetBase.nodeId || sourceBase.nodeId === targetBase.nodeId) return normalized;

  let copied = 0;
  for (const channel of CHANNELS) {
    const sourceScope = { ...sourceBase, channel };
    const sourceKey = whiteboardGenerationDraftKey(sourceScope);
    const entry = sourceKey ? normalized.entries[sourceKey] : null;
    if (!entry) continue;
    normalized = updateWhiteboardGenerationDraftCache(
      normalized,
      { ...targetBase, channel },
      entry.values,
      { active: false, open: false, collapsed: false, updatedAt: Math.max(0, Number(updatedAt) || Date.now()) + copied },
    );
    copied += 1;
  }
  return normalized;
};

export const deactivateWhiteboardGenerationDraft = (cache, scope) => {
  const normalized = normalizeWhiteboardGenerationDraftCache(cache);
  const key = whiteboardGenerationDraftKey(scope);
  if (!key) {
    normalized.active = null;
    return normalized;
  }
  if (normalized.active?.key === key) normalized.active = null;
  normalized.openSessions = normalized.openSessions.filter((session) => session.key !== key);
  return normalized;
};
