import { contentRevision } from "./workspace-operations.js";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

export const WORKSPACE_STATE_CONFLICT_CODE = "WORKSPACE_STATE_CONFLICT";

export const isWorkspaceStateConflict = (error) => error?.code === WORKSPACE_STATE_CONFLICT_CODE
  || Number(error?.status) === 409
  || Number(error?.statusCode) === 409;

export const createWorkspaceStateConflictError = (message, details = {}) => Object.assign(
  new Error(String(message || "工作区存在并发修改")),
  {
    code: WORKSPACE_STATE_CONFLICT_CODE,
    status: 409,
    ...details,
  },
);

const workspaceValueHash = (value) => {
  if (value === undefined) return "";
  const serialized = JSON.stringify(value);
  return `${contentRevision(serialized)}:${serialized.length}`;
};

const changedKeys = (baseline, current) => {
  const keys = new Set([...baseline.keys(), ...current.keys()]);
  return new Set([...keys].filter((key) => baseline.get(key) !== current.get(key)));
};

const conflictingKeys = ({ localChanged, remoteChanged, localHashes, remoteHashes }) => new Set(
  [...localChanged].filter((key) => remoteChanged.has(key) && localHashes.get(key) !== remoteHashes.get(key)),
);

export const workspaceDocumentHashes = (documents = {}) => new Map(
  Object.entries(documents ?? {}).map(([id, documentState]) => [id, workspaceValueHash(documentState)]),
);

export const workspaceStateHashes = (workspaceState = {}) => new Map(
  Object.entries(workspaceState ?? {})
    .filter(([key]) => !["documents", "savedAt"].includes(key))
    .map(([key, value]) => [key, workspaceValueHash(value)]),
);

export const rebaseWorkspaceConflict = ({
  baselineDocumentHashes = new Map(),
  baselineStateHashes = new Map(),
  localState = {},
  remoteState = {},
  stateConflictResolutions = {},
} = {}) => {
  const localDocumentHashes = workspaceDocumentHashes(localState.documents);
  const remoteDocumentHashes = workspaceDocumentHashes(remoteState.documents);
  const localStateHashes = workspaceStateHashes(localState);
  const remoteStateHashes = workspaceStateHashes(remoteState);
  const localDocumentIds = changedKeys(baselineDocumentHashes, localDocumentHashes);
  const remoteDocumentIds = changedKeys(baselineDocumentHashes, remoteDocumentHashes);
  const localStateKeys = changedKeys(baselineStateHashes, localStateHashes);
  const remoteStateKeys = changedKeys(baselineStateHashes, remoteStateHashes);
  const conflictDocumentIds = conflictingKeys({
    localChanged: localDocumentIds,
    remoteChanged: remoteDocumentIds,
    localHashes: localDocumentHashes,
    remoteHashes: remoteDocumentHashes,
  });
  const detectedStateConflictKeys = conflictingKeys({
    localChanged: localStateKeys,
    remoteChanged: remoteStateKeys,
    localHashes: localStateHashes,
    remoteHashes: remoteStateHashes,
  });
  const conflictStateKeys = new Set(
    [...detectedStateConflictKeys].filter((key) => !hasOwn(stateConflictResolutions, key)),
  );
  if (conflictDocumentIds.size || conflictStateKeys.size) {
    return {
      ok: false,
      conflictDocumentIds: [...conflictDocumentIds],
      conflictStateKeys: [...conflictStateKeys],
      localDocumentIds: [...localDocumentIds],
      localStateKeys: [...localStateKeys],
    };
  }

  const rebasedState = {
    ...remoteState,
    documents: { ...(remoteState.documents ?? {}) },
  };
  for (const key of localStateKeys) {
    if (hasOwn(stateConflictResolutions, key)) rebasedState[key] = stateConflictResolutions[key];
    else if (hasOwn(localState, key)) rebasedState[key] = localState[key];
    else delete rebasedState[key];
  }
  for (const documentId of localDocumentIds) {
    if (hasOwn(localState.documents, documentId)) rebasedState.documents[documentId] = localState.documents[documentId];
    else delete rebasedState.documents[documentId];
  }
  if (hasOwn(remoteState, "savedAt")) rebasedState.savedAt = remoteState.savedAt;
  else delete rebasedState.savedAt;

  return {
    ok: true,
    state: rebasedState,
    localDocumentIds: [...localDocumentIds],
    remoteDocumentIds: [...remoteDocumentIds],
    localStateKeys: [...localStateKeys],
    remoteStateKeys: [...remoteStateKeys],
  };
};
