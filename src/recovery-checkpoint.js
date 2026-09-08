const RECOVERY_OVERLAY_MODE = "overlay-v1";
const RECOVERY_DOCUMENT_OVERLAY_MODE = "document-overlay-v2";

// These collections are already durably versioned by the canonical workspace store.
// Repeating them in every rapid recovery checkpoint can turn a small edit into a
// hundred-megabyte write without improving recovery of the active edit.
export const RECOVERY_CANONICAL_STATE_KEYS = Object.freeze([
  "moduleHistories",
  "rollbackDocumentObjects",
  // View/volume history is already persisted by the canonical workspace
  // document store. Repeating these large, derived UI snapshots in every
  // recovery checkpoint made a simple workspace switch write tens of MB and
  // increased the chance of an interrupted atomic rename on Windows.
  // Recovery overlays keep the canonical values when these keys are omitted.
  "viewHistories",
  "volumeHistories",
]);

export const compactRecoveryState = (workspaceState = {}, { documentIds = null } = {}) => {
  if (Array.isArray(documentIds) && documentIds.length) {
    const ids = [...new Set(documentIds.map(String).filter(Boolean))];
    const documents = Object.fromEntries(ids
      .filter((documentId) => Object.hasOwn(workspaceState.documents ?? {}, documentId))
      .map((documentId) => [documentId, workspaceState.documents[documentId]]));
    return {
      state: { documents },
      stateMode: RECOVERY_DOCUMENT_OVERLAY_MODE,
      documentIds: ids,
      omittedStateKeys: RECOVERY_CANONICAL_STATE_KEYS,
    };
  }
  const state = { ...(workspaceState && typeof workspaceState === "object" ? workspaceState : {}) };
  const omittedStateKeys = [];
  for (const key of RECOVERY_CANONICAL_STATE_KEYS) {
    if (!Object.hasOwn(state, key)) continue;
    delete state[key];
    omittedStateKeys.push(key);
  }
  return {
    state,
    stateMode: RECOVERY_OVERLAY_MODE,
    omittedStateKeys,
  };
};

const recoveryDocumentCanOverlay = (canonicalDocument, recoveryDocument) => {
  if (!canonicalDocument || canonicalDocument.externalContentChanged !== true) return true;
  const canonicalHash = String(canonicalDocument.contentRef?.hash ?? "").trim();
  const recoveryHash = String(recoveryDocument?.contentRef?.hash ?? "").trim();
  // The workspace loader has already verified that the managed file on disk is
  // newer than the saved state. A recovery checkpoint created from the older
  // hash must not hide that external Agent/CLI write and then repeatedly submit
  // a stale optimistic-lock precondition. A checkpoint captured from the same
  // disk baseline is still a legitimate unsaved editor draft and may overlay.
  return !canonicalHash || canonicalHash === recoveryHash;
};

const mergeRecoveryDocuments = (canonicalDocuments = {}, recoveryDocuments = {}, documentIds = null) => {
  const restored = { ...canonicalDocuments };
  const ids = documentIds ?? Object.keys(recoveryDocuments ?? {});
  for (const documentId of ids) {
    if (!Object.hasOwn(recoveryDocuments ?? {}, documentId)) {
      delete restored[documentId];
      continue;
    }
    const recoveryDocument = recoveryDocuments[documentId];
    if (recoveryDocumentCanOverlay(canonicalDocuments?.[documentId], recoveryDocument)) {
      restored[documentId] = recoveryDocument;
    }
  }
  return restored;
};

export const restoreRecoveryState = ({ canonicalState = null, checkpoint = null } = {}) => {
  if (!checkpoint?.state || typeof checkpoint.state !== "object") return canonicalState;
  if (checkpoint.stateMode === RECOVERY_DOCUMENT_OVERLAY_MODE) {
    const restored = {
      ...(canonicalState && typeof canonicalState === "object" ? canonicalState : {}),
      documents: { ...(canonicalState?.documents ?? {}) },
    };
    restored.documents = mergeRecoveryDocuments(
      canonicalState?.documents ?? {},
      checkpoint.state.documents ?? {},
      checkpoint.documentIds ?? Object.keys(checkpoint.state.documents ?? {}),
    );
    return restored;
  }
  if (checkpoint.stateMode !== RECOVERY_OVERLAY_MODE) return checkpoint.state;
  const restored = {
    ...(canonicalState && typeof canonicalState === "object" ? canonicalState : {}),
    ...checkpoint.state,
  };
  if (checkpoint.state.documents && typeof checkpoint.state.documents === "object") {
    restored.documents = mergeRecoveryDocuments(canonicalState?.documents ?? {}, checkpoint.state.documents);
  }
  return restored;
};
