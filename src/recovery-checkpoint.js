const RECOVERY_OVERLAY_MODE = "overlay-v1";
const RECOVERY_FULL_MODE = "full-v1";
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

// A full overlay checkpoint is a fast, possibly-unsaved snapshot.  It is not
// a second canonical workspace.  Conversation data therefore needs an
// additive merge: an older checkpoint must not erase a conversation or a
// completed message that was persisted after the checkpoint's baseline.
const conversationItemId = (item) => String(item?.id || item?.messageId || "").trim();

const conversationEpoch = (conversation = {}) => {
  const explicit = Math.max(
    Number(conversation?.updatedAtEpoch) || 0,
    Number(conversation?.createdAtEpoch) || 0,
  );
  if (explicit > 0) return explicit;
  const match = conversationItemId(conversation).match(/^conversation-(\d{10,})/u);
  return match ? Number(match[1]) || 0 : 0;
};

const messageIsTerminal = (message) => Boolean(message && !message.pending && ![
  "running", "waiting_input", "queued", "preparing",
].includes(String(message.execution?.status || "").toLowerCase()));

const messageEpoch = (message) => Math.max(
  Number(message?.execution?.endedAt) || 0,
  Number(message?.execution?.updatedAt) || 0,
  Number(message?.updatedAtEpoch) || 0,
  Number(message?.createdAtEpoch) || 0,
);

const mergeConversationMessages = (canonicalMessages = [], recoveryMessages = []) => {
  const canonical = Array.isArray(canonicalMessages) ? canonicalMessages : [];
  const recovery = Array.isArray(recoveryMessages) ? recoveryMessages : [];
  const byId = new Map();
  const order = [];
  const add = (message, source) => {
    const id = conversationItemId(message);
    if (!id) return;
    if (!byId.has(id)) order.push(id);
    const current = byId.get(id);
    if (!current) {
      byId.set(id, { message, source });
      return;
    }
    const currentMessage = current.message;
    const currentTerminal = messageIsTerminal(currentMessage);
    const nextTerminal = messageIsTerminal(message);
    // A completed canonical response always wins over an older recovery
    // checkpoint that still contains the same request in a pending state.
    // Conversely, a terminal recovery response is retained when canonical
    // still has the in-flight placeholder.
    if (currentTerminal !== nextTerminal) {
      if (nextTerminal) byId.set(id, { message, source });
      return;
    }
    const currentEpoch = messageEpoch(currentMessage);
    const nextEpoch = messageEpoch(message);
    // When neither side carries a reliable timestamp, canonical storage wins;
    // the checkpoint is only a fallback for data that is genuinely newer or
    // still in-flight there.
    if (nextEpoch > currentEpoch) {
      byId.set(id, { message, source });
    }
  };
  canonical.forEach((message) => add(message, "canonical"));
  recovery.forEach((message) => add(message, "recovery"));
  return order.map((id) => byId.get(id)?.message).filter(Boolean);
};

const mergeRecoveryConversation = (canonicalConversation = {}, recoveryConversation = {}) => {
  const merged = {
    ...(recoveryConversation && typeof recoveryConversation === "object" ? recoveryConversation : {}),
    ...(canonicalConversation && typeof canonicalConversation === "object" ? canonicalConversation : {}),
  };
  merged.messages = mergeConversationMessages(canonicalConversation?.messages, recoveryConversation?.messages);
  // The checkpoint may carry a newer in-flight candidate even when the
  // canonical save still has the empty placeholder.  Restore only those
  // explicitly transient fields; canonical titles/ownership/timestamps stay
  // authoritative and cannot be rolled back by an old checkpoint.
  for (const key of [
    "currentCandidate", "currentCandidateTarget", "currentCandidateMemoryUpdate", "currentCandidateAuthorization",
    "nativeAgentSession", "agentContextEpoch", "conversationContextCheckpoint", "contextLedger", "contextCompressionSignature",
  ]) {
    const recoveryValue = recoveryConversation?.[key];
    const canonicalValue = canonicalConversation?.[key];
    const recoveryHasValue = recoveryValue !== undefined && recoveryValue !== null && recoveryValue !== "";
    const canonicalHasValue = canonicalValue !== undefined && canonicalValue !== null && canonicalValue !== "";
    if (recoveryHasValue && !canonicalHasValue) merged[key] = recoveryValue;
  }
  if (Array.isArray(canonicalConversation?.queue) || Array.isArray(recoveryConversation?.queue)) {
    const queue = [...(canonicalConversation?.queue || []), ...(recoveryConversation?.queue || [])];
    const seen = new Set();
    merged.queue = queue.filter((item) => {
      const id = conversationItemId(item) || JSON.stringify(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  // The active conversation mirrors these fields at the workspace top level;
  // keeping their union here prevents an old snapshot from dropping task
  // branches or an already persisted candidate.
  if (Array.isArray(canonicalConversation?.isolatedBranches) || Array.isArray(recoveryConversation?.isolatedBranches)) {
    const branches = [...(canonicalConversation?.isolatedBranches || []), ...(recoveryConversation?.isolatedBranches || [])];
    const seen = new Set();
    merged.isolatedBranches = branches.filter((branch) => {
      const id = conversationItemId(branch) || JSON.stringify(branch);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return merged;
};

const mergeRecoveryConversations = (canonicalConversations = [], recoveryConversations = []) => {
  const canonical = Array.isArray(canonicalConversations) ? canonicalConversations : [];
  const recovery = Array.isArray(recoveryConversations) ? recoveryConversations : [];
  const recoveryById = new Map(recovery.map((conversation) => [conversationItemId(conversation), conversation]));
  const merged = canonical.map((conversation) => {
    const id = conversationItemId(conversation);
    return id && recoveryById.has(id)
      ? mergeRecoveryConversation(conversation, recoveryById.get(id))
      : conversation;
  });
  const existing = new Set(merged.map(conversationItemId).filter(Boolean));
  for (const conversation of recovery) {
    const id = conversationItemId(conversation);
    if (id && !existing.has(id)) {
      merged.push(conversation);
      existing.add(id);
    }
  }
  return merged;
};

const chooseRecoveredActiveConversationId = ({ canonicalState, recoveryState, conversations }) => {
  const ids = new Set(conversations.map(conversationItemId).filter(Boolean));
  const canonicalId = conversationItemId({ id: canonicalState?.activeConversationId });
  const recoveryId = conversationItemId({ id: recoveryState?.activeConversationId });
  // Canonical storage remains authoritative for an equal/older checkpoint.
  // During an upgrade, however, the newest conversation can exist only in the
  // recovery snapshot when its final workspace save was interrupted.  Compare
  // stable creation/update epochs before falling back to the canonical pointer
  // so restart does not reopen an older chat and hide the latest one.
  if (ids.has(canonicalId) && ids.has(recoveryId) && canonicalId !== recoveryId) {
    const canonical = conversations.find((conversation) => conversationItemId(conversation) === canonicalId);
    const recovery = conversations.find((conversation) => conversationItemId(conversation) === recoveryId);
    if (conversationEpoch(recovery) > conversationEpoch(canonical)) return recoveryId;
  }
  if (ids.has(canonicalId)) return canonicalId;
  return ids.has(recoveryId) ? recoveryId : conversations[0]?.id;
};

const restoreConversationOverlay = (restored, canonicalState, checkpointState) => {
  if (!Array.isArray(canonicalState?.conversations) && !Array.isArray(checkpointState?.conversations)) return restored;
  const conversations = mergeRecoveryConversations(canonicalState?.conversations, checkpointState?.conversations);
  const activeConversationId = chooseRecoveredActiveConversationId({
    canonicalState,
    recoveryState: checkpointState,
    conversations,
  });
  restored.conversations = conversations;
  if (activeConversationId) restored.activeConversationId = activeConversationId;
  const active = conversations.find((conversation) => conversationItemId(conversation) === activeConversationId);
  if (!active) return restored;
  for (const key of [
    "messages", "snapshots", "isolatedBranches", "currentCandidate", "currentCandidateTarget",
    "currentCandidateMemoryUpdate", "currentCandidateAuthorization",
  ]) {
    if (Object.hasOwn(active, key)) restored[key] = active[key];
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
  // `full-v1` is the legacy name used by older checkpoints.  It still
  // contains a whole workspace snapshot, so it must use the same additive
  // conversation merge instead of replacing the canonical conversation list.
  if (checkpoint.stateMode && ![RECOVERY_OVERLAY_MODE, RECOVERY_FULL_MODE].includes(checkpoint.stateMode)) return checkpoint.state;
  const restored = {
    ...(canonicalState && typeof canonicalState === "object" ? canonicalState : {}),
    ...checkpoint.state,
  };
  if (checkpoint.state.documents && typeof checkpoint.state.documents === "object") {
    restored.documents = mergeRecoveryDocuments(canonicalState?.documents ?? {}, checkpoint.state.documents);
  }
  return restoreConversationOverlay(restored, canonicalState, checkpoint.state);
};
