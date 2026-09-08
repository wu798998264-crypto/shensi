const cloneValue = (value) => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));

const documentReferenceId = (reference) => String(typeof reference === "string" ? reference : reference?.id || "").trim();
const workspaceReferenceKey = (reference) => String(reference?.key || `${reference?.workspaceKind || ""}:${reference?.workspacePath || ""}:${reference?.documentId || ""}`).trim();
const skillReferenceKey = (reference) => String(reference?.id || reference?.relativePath || reference?.name || "").trim();
const attachmentReferenceKey = (reference) => String(reference?.id || reference?.relativePath || reference?.sourceUrl || reference?.name || "").trim();

const uniqueValues = (values, keyFor) => [...new Map((Array.isArray(values) ? values : [])
  .map((value) => [keyFor(value), value])
  .filter(([key]) => key)).values()];

export const emptyConversationReferenceScope = () => ({
  references: [],
  workspaceReferences: [],
  skillReferences: [],
  attachments: [],
});

export const normalizeConversationReferenceScope = (scope = {}) => ({
  references: uniqueValues(scope.references, documentReferenceId).map(documentReferenceId),
  workspaceReferences: uniqueValues(scope.workspaceReferences, workspaceReferenceKey).map(cloneValue),
  skillReferences: uniqueValues(scope.skillReferences, skillReferenceKey).map(cloneValue),
  attachments: uniqueValues(scope.attachments, attachmentReferenceKey).map(cloneValue),
});

export const conversationReferenceScopeHasContent = (scope = {}) => (
  Boolean(scope.references?.length || scope.workspaceReferences?.length || scope.skillReferences?.length || scope.attachments?.length)
);

const scopeDifference = (scope, baseline) => {
  const base = normalizeConversationReferenceScope(baseline);
  const referenceIds = new Set(base.references.map(documentReferenceId));
  const workspaceKeys = new Set(base.workspaceReferences.map(workspaceReferenceKey));
  const skillKeys = new Set(base.skillReferences.map(skillReferenceKey));
  const attachmentKeys = new Set(base.attachments.map(attachmentReferenceKey));
  return normalizeConversationReferenceScope({
    references: scope.references.filter((reference) => !referenceIds.has(documentReferenceId(reference))),
    workspaceReferences: scope.workspaceReferences.filter((reference) => !workspaceKeys.has(workspaceReferenceKey(reference))),
    skillReferences: scope.skillReferences.filter((reference) => !skillKeys.has(skillReferenceKey(reference))),
    attachments: scope.attachments.filter((reference) => !attachmentKeys.has(attachmentReferenceKey(reference))),
  });
};

const scopeIntersection = (scope, available) => {
  const current = normalizeConversationReferenceScope(available);
  const referenceIds = new Set(current.references.map(documentReferenceId));
  const workspaceKeys = new Set(current.workspaceReferences.map(workspaceReferenceKey));
  const skillKeys = new Set(current.skillReferences.map(skillReferenceKey));
  const attachmentKeys = new Set(current.attachments.map(attachmentReferenceKey));
  return normalizeConversationReferenceScope({
    references: scope.references.filter((reference) => referenceIds.has(documentReferenceId(reference))),
    workspaceReferences: scope.workspaceReferences.filter((reference) => workspaceKeys.has(workspaceReferenceKey(reference))),
    skillReferences: scope.skillReferences.filter((reference) => skillKeys.has(skillReferenceKey(reference))),
    attachments: scope.attachments.filter((reference) => attachmentKeys.has(attachmentReferenceKey(reference))),
  });
};

export const conversationComposerReferenceScope = (conversation = {}) => {
  if (conversation.composerReferenceState?.schemaVersion === 1) {
    return conversation.composerReferenceState.pending === true
      ? normalizeConversationReferenceScope(conversation.composerReferenceState.scope)
      : emptyConversationReferenceScope();
  }
  return String(conversation.referenceContext?.sourceMessageId || "")
    ? emptyConversationReferenceScope()
    : normalizeConversationReferenceScope(conversation);
};

export const conversationComposerReferencesPending = (conversation = {}) => (
  conversationReferenceScopeHasContent(conversationComposerReferenceScope(conversation))
);

export const markConversationComposerReferencesPending = (conversation) => {
  if (!conversation) return false;
  const directScope = normalizeConversationReferenceScope(conversation);
  const durableScope = conversation.referenceContext?.schemaVersion === 1
    ? normalizeConversationReferenceScope(conversation.referenceContext)
    : emptyConversationReferenceScope();
  const additions = scopeDifference(directScope, durableScope);
  const previous = conversation.composerReferenceState?.schemaVersion === 1
    ? normalizeConversationReferenceScope(conversation.composerReferenceState.scope)
    : conversationComposerReferenceScope(conversation);
  const scope = normalizeConversationReferenceScope({
    references: [...previous.references, ...additions.references],
    workspaceReferences: [...previous.workspaceReferences, ...additions.workspaceReferences],
    skillReferences: [...previous.skillReferences, ...additions.skillReferences],
    attachments: [...previous.attachments, ...additions.attachments],
  });
  conversation.composerReferenceState = {
    schemaVersion: 1,
    pending: conversationReferenceScopeHasContent(scope),
    scope,
    updatedAt: Date.now(),
  };
  return conversation.composerReferenceState.pending;
};

export const consumeConversationComposerReferences = (conversation) => {
  if (!conversation) return false;
  conversation.composerReferenceState = {
    schemaVersion: 1,
    pending: false,
    scope: emptyConversationReferenceScope(),
    updatedAt: Date.now(),
  };
  return true;
};

export const messageConversationReferenceScope = (message = {}) => normalizeConversationReferenceScope(
  message.referenceContextSnapshot ?? message,
);

const latestMessageScope = (conversation = {}) => {
  for (const message of [...(conversation.messages ?? [])].reverse()) {
    if (message?.role !== "user") continue;
    const scope = messageConversationReferenceScope(message);
    const hasSnapshot = message.referenceContextSnapshot && typeof message.referenceContextSnapshot === "object";
    if (hasSnapshot) return {
      scope,
      sourceMessageId: conversationReferenceScopeHasContent(scope) ? message.id || "" : "",
      cleared: message.referenceContextSnapshot.cleared === true || !conversationReferenceScopeHasContent(scope),
    };
    if (conversationReferenceScopeHasContent(scope)) return { scope, sourceMessageId: message.id || "", cleared: false };
  }
  return { scope: emptyConversationReferenceScope(), sourceMessageId: "", cleared: false };
};

export const synchronizeConversationReferenceContext = (conversation, {
  scope = null,
  sourceMessageId = "",
  cleared = false,
} = {}) => {
  if (!conversation) return emptyConversationReferenceScope();
  const normalized = normalizeConversationReferenceScope(scope ?? conversation);
  const previous = conversation.referenceContext?.schemaVersion === 1
    ? normalizeConversationReferenceScope(conversation.referenceContext)
    : null;
  const nextCleared = cleared === true;
  const changed = !previous
    || JSON.stringify(previous) !== JSON.stringify(normalized)
    || Boolean(conversation.referenceContext?.cleared) !== nextCleared;
  conversation.references = normalized.references;
  conversation.workspaceReferences = normalized.workspaceReferences;
  conversation.skillReferences = normalized.skillReferences;
  conversation.attachments = normalized.attachments;
  if (conversation.composerReferenceState?.schemaVersion === 1 && conversation.composerReferenceState.pending === true) {
    const pendingScope = scopeIntersection(
      normalizeConversationReferenceScope(conversation.composerReferenceState.scope),
      normalized,
    );
    conversation.composerReferenceState = {
      ...conversation.composerReferenceState,
      pending: conversationReferenceScopeHasContent(pendingScope),
      scope: pendingScope,
      updatedAt: Date.now(),
    };
  }
  conversation.referenceContext = {
    schemaVersion: 1,
    ...cloneValue(normalized),
    sourceMessageId: nextCleared ? "" : String(sourceMessageId || conversation.referenceContext?.sourceMessageId || ""),
    cleared: nextCleared,
    updatedAt: changed ? Date.now() : Number(conversation.referenceContext?.updatedAt) || Date.now(),
  };
  return normalized;
};

export const removeConversationAttachmentReference = (conversation, attachmentId) => {
  if (!conversation) return false;
  const targetKey = String(attachmentId || "").trim();
  if (!targetKey) return false;
  const withoutTarget = (attachments = []) => (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachmentReferenceKey(attachment) !== targetKey);
  const durableScope = conversation.referenceContext?.schemaVersion === 1
    ? normalizeConversationReferenceScope(conversation.referenceContext)
    : normalizeConversationReferenceScope(conversation);
  const nextAttachments = withoutTarget(durableScope.attachments);
  let removed = nextAttachments.length !== durableScope.attachments.length;
  const nextScope = { ...durableScope, attachments: nextAttachments };

  if (conversation.composerReferenceState?.schemaVersion === 1) {
    const pendingScope = normalizeConversationReferenceScope(conversation.composerReferenceState.scope);
    const nextPendingAttachments = withoutTarget(pendingScope.attachments);
    removed ||= nextPendingAttachments.length !== pendingScope.attachments.length;
    const nextPendingScope = { ...pendingScope, attachments: nextPendingAttachments };
    conversation.composerReferenceState = {
      ...conversation.composerReferenceState,
      pending: conversationReferenceScopeHasContent(nextPendingScope),
      scope: nextPendingScope,
      updatedAt: Date.now(),
    };
  }

  synchronizeConversationReferenceContext(conversation, {
    scope: nextScope,
    sourceMessageId: conversation.referenceContext?.sourceMessageId,
    cleared: !conversationReferenceScopeHasContent(nextScope),
  });
  return removed;
};

export const ensureConversationReferenceContext = (conversation) => {
  if (!conversation) return emptyConversationReferenceScope();
  if (conversation.referenceContext?.schemaVersion === 1) {
    // referenceContext is the durable authority after it has been created.
    // Workspace hydration may initialize missing legacy top-level arrays to [];
    // treating those placeholders as newer state would silently erase active
    // references whenever a conversation is reloaded or switched back into.
    const durableScope = normalizeConversationReferenceScope(conversation.referenceContext);
    return synchronizeConversationReferenceContext(conversation, {
      scope: durableScope,
      sourceMessageId: conversation.referenceContext.sourceMessageId,
      cleared: conversation.referenceContext.cleared === true && !conversationReferenceScopeHasContent(durableScope),
    });
  }
  const direct = normalizeConversationReferenceScope(conversation);
  if (conversationReferenceScopeHasContent(direct)) return synchronizeConversationReferenceContext(conversation, { scope: direct });
  const recovered = latestMessageScope(conversation);
  return synchronizeConversationReferenceContext(conversation, {
    scope: recovered.scope,
    sourceMessageId: recovered.sourceMessageId,
    cleared: recovered.cleared === true,
  });
};

const EXPLICIT_REFERENCE_RESET = /(?:清空|移除|取消|停止使用|不要再用|不再使用|忽略|丢弃).{0,10}(?:之前|上轮|此前|当前|全部|这些)?(?:的)?(?:引用|附件|参考资料|上下文)|(?:引用|附件|参考资料|上下文).{0,10}(?:清空|移除|取消|停止使用|不要再用|不再使用|忽略|丢弃)/;

export const resolveConversationReferenceContext = (conversation, { prompt = "" } = {}) => {
  const resetRequested = EXPLICIT_REFERENCE_RESET.test(String(prompt));
  if (resetRequested) {
    const scope = synchronizeConversationReferenceContext(conversation, { scope: emptyConversationReferenceScope(), cleared: true });
    return { ...scope, resetRequested, inherited: false, sourceMessageId: "" };
  }
  const scope = ensureConversationReferenceContext(conversation);
  return {
    ...scope,
    resetRequested: false,
    inherited: Boolean(conversation?.referenceContext?.sourceMessageId) && conversationReferenceScopeHasContent(scope),
    sourceMessageId: String(conversation?.referenceContext?.sourceMessageId || ""),
  };
};

export const conversationReferenceMessageSnapshot = (scope = {}, metadata = {}) => ({
  schemaVersion: 1,
  ...cloneValue(normalizeConversationReferenceScope(scope)),
  inherited: metadata.inherited === true,
  sourceMessageId: String(metadata.sourceMessageId || ""),
  cleared: metadata.cleared === true,
});
