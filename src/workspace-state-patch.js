import { CONVERSATION_SAVE_KEYS } from "./conversation-save-reconciliation.js";

export const WORKSPACE_STATE_ONLY_KEYS = Object.freeze([
  "schemaVersion",
  "mediaWorkspaceVersion",
  "structureWorkspaceVersion",
  "structureLanguage",
  "workspaceKind",
  "projectName",
  "savedAt",
  "layout",
  "activeModule",
  "activeDocument",
  "activeConversationId",
  "expandedFolders",
  "moduleViews",
  "moduleLastDocuments",
  "documentConversationBindings",
  "selectedText",
  "longFormJobs",
  "pendingInlineEdits",
  "workspaceAssets",
  "assetHistoryTombstones",
  ...CONVERSATION_SAVE_KEYS,
]);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clone = (value) => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

// State-only autosaves are used by conversation progress and navigation. They
// must not serialize historical versions, trash or document bodies merely to
// move the active pointer or persist a task card. The server overlays this
// payload on its canonical state under the expected-state-stamp lock.
export const workspaceStateOnlyPatchPayload = (state = {}) => clone(Object.fromEntries(
  [...new Set(WORKSPACE_STATE_ONLY_KEYS)]
    .filter((key) => own(state, key))
    .map((key) => [key, state[key]]),
));
