export const CONVERSATION_SAVE_KEYS = Object.freeze([
  "conversations",
  "messages",
  "snapshots",
  "isolatedBranches",
  "activeConversationId",
  "currentCandidate",
  "currentCandidateTarget",
  "currentCandidateMemoryUpdate",
  "currentCandidateAuthorization",
]);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hasValue = (value) => value !== undefined;

const itemIdentity = (item) => {
  if (item && typeof item === "object") {
    for (const key of ["id", "messageId", "taskId", "requestId", "path", "relativePath", "name"]) {
      if (item[key]) return `${key}:${item[key]}`;
    }
  }
  return `${typeof item}:${JSON.stringify(item)}`;
};

const mergeThreeWayObject = ({ baseline, current, persisted, mergeField, path = "" }) => {
  const base = baseline && typeof baseline === "object" && !Array.isArray(baseline) ? baseline : {};
  const local = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const remote = persisted && typeof persisted === "object" && !Array.isArray(persisted) ? persisted : {};
  const result = {};
  const conflicts = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const baseValue = own(base, key) ? base[key] : undefined;
    const localValue = own(local, key) ? local[key] : undefined;
    const remoteValue = own(remote, key) ? remote[key] : undefined;
    if (equal(localValue, remoteValue)) {
      if (hasValue(localValue)) result[key] = localValue;
      continue;
    }
    if (equal(localValue, baseValue)) {
      if (hasValue(remoteValue)) result[key] = remoteValue;
      continue;
    }
    if (equal(remoteValue, baseValue)) {
      if (hasValue(localValue)) result[key] = localValue;
      continue;
    }
    const merged = mergeField?.({
      key,
      baseline: baseValue,
      current: localValue,
      persisted: remoteValue,
      path: path ? `${path}.${key}` : key,
    });
    if (merged?.ok) {
      if (hasValue(merged.value)) result[key] = merged.value;
      continue;
    }
    conflicts.push(...(merged?.conflicts?.length ? merged.conflicts : [path ? `${path}.${key}` : key]));
  }
  return { ok: conflicts.length === 0, value: result, conflicts };
};

const mergeThreeWayList = ({ baseline = [], current = [], persisted = [], mergeItem, path = "" }) => {
  const baseList = Array.isArray(baseline) ? baseline : [];
  const localList = Array.isArray(current) ? current : [];
  const remoteList = Array.isArray(persisted) ? persisted : [];
  const base = new Map(baseList.map((item) => [itemIdentity(item), item]));
  const local = new Map(localList.map((item) => [itemIdentity(item), item]));
  const remote = new Map(remoteList.map((item) => [itemIdentity(item), item]));
  const order = [...local.keys(), ...remote.keys().filter((key) => !local.has(key))];
  const result = [];
  const conflicts = [];
  for (const identity of order) {
    const baseValue = base.get(identity);
    const localValue = local.get(identity);
    const remoteValue = remote.get(identity);
    if (equal(localValue, remoteValue)) {
      if (hasValue(localValue)) result.push(localValue);
      continue;
    }
    if (equal(localValue, baseValue)) {
      if (hasValue(remoteValue)) result.push(remoteValue);
      continue;
    }
    if (equal(remoteValue, baseValue)) {
      if (hasValue(localValue)) result.push(localValue);
      continue;
    }
    if (!hasValue(localValue) || !hasValue(remoteValue)) {
      conflicts.push(`${path}[${identity}]`);
      continue;
    }
    const merged = mergeItem?.({
      baseline: baseValue,
      current: localValue,
      persisted: remoteValue,
      path: `${path}[${identity}]`,
    });
    if (merged?.ok) result.push(merged.value);
    else conflicts.push(...(merged?.conflicts?.length ? merged.conflicts : [`${path}[${identity}]`]));
  }
  return { ok: conflicts.length === 0, value: result, conflicts };
};

const MERGEABLE_LIST_FIELDS = new Set([
  "messages",
  "queue",
  "isolatedBranches",
  "branchGroups",
  "candidateBranchGroups",
  "references",
  "workspaceReferences",
  "skillReferences",
  "attachments",
  "constraintIndex",
]);

const MERGEABLE_OBJECT_FIELDS = new Set([
  "snapshots",
  "documentAssociationHistory",
]);

const mergeRecord = ({ baseline, current, persisted, path }) => mergeThreeWayObject({
  baseline,
  current,
  persisted,
  path,
  mergeField: ({ key, baseline: baseValue, current: localValue, persisted: remoteValue, path: fieldPath }) => {
    if (MERGEABLE_LIST_FIELDS.has(key)) {
      return mergeThreeWayList({
        baseline: baseValue,
        current: localValue,
        persisted: remoteValue,
        path: fieldPath,
        mergeItem: ({ baseline: baseItem, current: localItem, persisted: remoteItem, path: itemPath }) => (
          localItem && typeof localItem === "object" && remoteItem && typeof remoteItem === "object"
            ? mergeRecord({ baseline: baseItem, current: localItem, persisted: remoteItem, path: itemPath })
            : null
        ),
      });
    }
    if (MERGEABLE_OBJECT_FIELDS.has(key)) {
      return mergeThreeWayObject({
        baseline: baseValue,
        current: localValue,
        persisted: remoteValue,
        path: fieldPath,
        mergeField: ({ baseline: baseItem, current: localItem, persisted: remoteItem, path: itemPath }) => (
          localItem && typeof localItem === "object" && remoteItem && typeof remoteItem === "object"
            ? mergeRecord({ baseline: baseItem, current: localItem, persisted: remoteItem, path: itemPath })
            : null
        ),
      });
    }
    // Presentation-only metadata commonly changes on both sides while one
    // task completes and a later instruction is queued.
    if (key === "updatedAt") return { ok: true, value: localValue };
    return null;
  },
});

const recordFreshness = (value = {}) => Math.max(
  Date.parse(String(value?.updatedAt || "")) || 0,
  Date.parse(String(value?.execution?.endedAt || "")) || 0,
  Date.parse(String(value?.execution?.completedAt || "")) || 0,
  Date.parse(String(value?.execution?.heartbeatAt || "")) || 0,
  Number(value?.updatedAt) || 0,
);

// Conversation state is append-heavy and can be written by the foreground
// renderer and a background task at the same time.  A true same-field content
// conflict should not make every later conversation unusable; choose the
// freshest record and union its task metadata instead.
const mergeConversationRecord = ({ baseline, current, persisted, path }) => {
  const strict = mergeRecord({ baseline, current, persisted, path });
  if (strict.ok) return strict;
  const local = current && typeof current === "object" ? current : {};
  const remote = persisted && typeof persisted === "object" ? persisted : {};
  const localTime = recordFreshness(local);
  const remoteTime = recordFreshness(remote);
  const preferred = remoteTime > localTime ? remote : local;
  const result = { ...remote, ...local, ...preferred };
  for (const key of MERGEABLE_LIST_FIELDS) {
    if (!Array.isArray(local[key]) && !Array.isArray(remote[key])) continue;
    const localItems = Array.isArray(local[key]) ? local[key] : [];
    const remoteItems = Array.isArray(remote[key]) ? remote[key] : [];
    const byId = new Map(remoteItems.map((item) => [itemIdentity(item), item]));
    for (const item of localItems) {
      const identity = itemIdentity(item);
      const previous = byId.get(identity);
      if (!previous) byId.set(identity, item);
      else {
        const newer = recordFreshness(item) >= recordFreshness(previous) ? item : previous;
        byId.set(identity, { ...previous, ...item, ...newer });
      }
    }
    result[key] = [...byId.values()];
  }
  if (local.snapshots || remote.snapshots) result.snapshots = { ...(remote.snapshots || {}), ...(local.snapshots || {}) };
  if (local.execution || remote.execution) result.execution = { ...(remote.execution || {}), ...(local.execution || {}) };
  return { ok: true, value: result };
};

const mergeConversationList = ({ baseline, current, persisted }) => mergeThreeWayList({
  baseline,
  current,
  persisted,
  path: "conversations",
  mergeItem: mergeConversationRecord,
});

const chooseActiveConversationId = ({ current = {}, submitted = {}, persisted = {}, conversations = [] }) => {
  const base = submitted.activeConversationId;
  const local = current.activeConversationId;
  const remote = persisted.activeConversationId;
  const preferred = equal(local, remote)
    ? local
    : equal(local, base)
      ? remote
      : local;
  const ids = new Set(conversations.map((conversation) => conversation?.id).filter(Boolean));
  return ids.has(preferred) ? preferred
    : ids.has(local) ? local
      : ids.has(remote) ? remote
        : conversations[0]?.id;
};

export const freezeConversationSaveState = (state = {}) => ({
  ...state,
  ...structuredClone(Object.fromEntries(CONVERSATION_SAVE_KEYS.filter((key) => own(state, key)).map((key) => [key, state[key]]))),
});

// The submitted state is the common baseline. Messages or queue entries added
// while an older request is in flight can coexist with a reply persisted by
// another writer; true edits to the same field remain explicit conflicts.
export const reconcileConversationSave = ({ current = {}, submitted = {}, persisted = {}, stateConflictResolutions = {} } = {}) => {
  const next = { ...persisted };
  const conflicts = [];
  const hasConversations = [current, submitted, persisted].some((value) => Array.isArray(value.conversations));
  let mergedConversations = null;
  if (hasConversations && !Object.hasOwn(stateConflictResolutions, "conversations")) {
    const merged = mergeConversationList({
      baseline: submitted.conversations,
      current: current.conversations,
      persisted: persisted.conversations,
    });
    if (!merged.ok) conflicts.push("conversations");
    else {
      mergedConversations = merged.value;
      next.conversations = merged.value;
      next.activeConversationId = chooseActiveConversationId({ current, submitted, persisted, conversations: merged.value });
      const active = merged.value.find((conversation) => conversation.id === next.activeConversationId);
      for (const key of CONVERSATION_SAVE_KEYS.filter((key) => !["conversations", "activeConversationId"].includes(key))) {
        if (active && own(active, key)) next[key] = active[key];
      }
    }
  }

  if (!mergedConversations) {
    for (const key of CONVERSATION_SAVE_KEYS.filter((value) => value !== "conversations")) {
      if (Object.hasOwn(stateConflictResolutions, key)) {
        next[key] = stateConflictResolutions[key];
        continue;
      }
      const localChanged = !equal(current[key], submitted[key]);
      const remoteChanged = !equal(persisted[key], submitted[key]);
      if (!localChanged && remoteChanged) continue;
      if (localChanged && !remoteChanged) {
        if (own(current, key)) next[key] = current[key];
        else delete next[key];
        continue;
      }
      if (!localChanged || equal(current[key], persisted[key])) continue;
      const merged = ["messages", "isolatedBranches"].includes(key)
        ? mergeThreeWayList({ baseline: submitted[key], current: current[key], persisted: persisted[key], path: key, mergeItem: mergeRecord })
        : key === "snapshots"
          ? mergeThreeWayObject({ baseline: submitted[key], current: current[key], persisted: persisted[key], path: key })
          : null;
      if (merged?.ok) next[key] = merged.value;
      else conflicts.push(key);
    }
  }
  for (const [key, value] of Object.entries(stateConflictResolutions ?? {})) next[key] = value;
  return { ok: conflicts.length === 0, state: next, conflictKeys: [...new Set(conflicts)] };
};

// A conflicting save has two distinct local timelines: changes already
// included in the submitted request, and newer changes made while that
// request was in flight. Merge them in that order. Treating the submitted
// snapshot itself as the only baseline makes an older server-side document
// transaction look like a deliberate conversation rollback and can either
// discard live task progress or report a false `conversations` conflict.
export const reconcileConversationSaveAfterConflict = ({
  baseline = {},
  submitted = {},
  current = submitted,
  persisted = {},
} = {}) => {
  const submittedMerge = reconcileConversationSave({
    current: submitted,
    submitted: baseline,
    persisted,
  });
  if (!submittedMerge.ok) return submittedMerge;
  return reconcileConversationSave({
    current,
    submitted,
    persisted: submittedMerge.state,
  });
};

export const reconcileWorkspaceSave = ({ current, submitted, persisted, stateConflictResolutions = {} }) => {
  const conversations = reconcileConversationSave({ current, submitted, persisted, stateConflictResolutions });
  if (!conversations.ok) return { ...conversations, conflictStateKeys: conversations.conflictKeys, conflictDocumentIds: [] };
  return { ok: true, state: { ...persisted, ...conversations.state }, conflictKeys: [] };
};

export const preserveConversationReferences = (current = {}, incoming = {}) => {
  const existing = new Map((current.conversations || []).map((conversation) => [conversation.id, conversation]));
  const seenConversationIds = new Set();
  const conversations = (incoming.conversations || []).map((record) => {
    seenConversationIds.add(record.id);
    const live = existing.get(record.id);
    if (!live || live === record) return record;
    const active = current.activeConversationId === record.id;
    const messages = active ? current.messages : live.messages;
    const snapshots = active ? current.snapshots : live.snapshots;
    const queue = live.queue;
    const nextMessages = record.messages || [];
    if (messages && messages !== nextMessages) {
      const byId = new Map(messages.map((message) => [message.id, message]));
      const seen = new Set();
      const retained = nextMessages.map((message) => {
        seen.add(message.id);
        const previous = byId.get(message.id);
        return previous ? Object.assign(previous, message) : message;
      });
      retained.push(...messages.filter((message) => !seen.has(message.id)));
      messages.splice(0, messages.length, ...retained);
    }
    if (snapshots && snapshots !== record.snapshots) {
      for (const key of Object.keys(snapshots)) if (!own(record.snapshots, key)) delete snapshots[key];
      Object.assign(snapshots, record.snapshots || {});
    }
    if (queue && queue !== record.queue) {
      const incomingQueue = record.queue || [];
      const incomingIds = new Set(incomingQueue.map((item) => item.id));
      queue.splice(0, queue.length, ...incomingQueue, ...queue.filter((item) => !incomingIds.has(item.id)));
    }
    Object.assign(live, record, { messages: messages || nextMessages, snapshots: snapshots || record.snapshots || {}, queue: queue || record.queue || [] });
    return live;
  });
  // A save response started before a conversation was created cannot remove
  // that live conversation from the sidebar.
  conversations.push(...(current.conversations || []).filter((conversation) => !seenConversationIds.has(conversation.id)));
  const active = conversations.find((conversation) => conversation.id === current.activeConversationId)
    || conversations.find((conversation) => conversation.id === incoming.activeConversationId);
  return {
    ...incoming,
    conversations,
    ...(active ? {
      activeConversationId: active.id,
      messages: active.messages,
      snapshots: active.snapshots,
      isolatedBranches: active.isolatedBranches,
      currentCandidate: active.currentCandidate,
      currentCandidateTarget: active.currentCandidateTarget,
      currentCandidateMemoryUpdate: active.currentCandidateMemoryUpdate,
      currentCandidateAuthorization: active.currentCandidateAuthorization,
    } : {}),
  };
};
