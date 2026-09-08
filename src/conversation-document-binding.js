const cleanId = (value) => String(value ?? "").trim();

const bindingRecord = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? value
  : {};

const conversationMatchesDocument = (conversation, documentId) => {
  if (!conversation || !documentId) return false;
  // Fixed conversations belong only to their creation/home document. History
  // entries are migration evidence, not live routing candidates.
  if (conversation.documentBindingMode === "fixed") {
    return cleanId(conversation.homeDocumentId) === documentId
      || cleanId(conversation.boundDocumentId) === documentId;
  }
  return cleanId(conversation.homeDocumentId) === documentId
    || cleanId(conversation.boundDocumentId) === documentId
    || Number(conversation.documentAssociationHistory?.[documentId]) > 0;
};

export const bindConversationToDocument = (bindings, documentId, conversationId) => {
  const normalized = { ...bindingRecord(bindings) };
  const normalizedDocumentId = cleanId(documentId);
  const normalizedConversationId = cleanId(conversationId);
  if (!normalizedDocumentId || !normalizedConversationId) return normalized;
  normalized[normalizedDocumentId] = normalizedConversationId;
  return normalized;
};

export const unbindConversation = (bindings, conversationId) => {
  const normalizedConversationId = cleanId(conversationId);
  return Object.fromEntries(Object.entries(bindingRecord(bindings))
    .filter(([, boundConversationId]) => cleanId(boundConversationId) !== normalizedConversationId));
};

export const conversationForDocument = ({
  bindings = {},
  conversations = [],
  documentId = "",
  currentConversationId = "",
} = {}) => {
  const normalizedDocumentId = cleanId(documentId);
  if (!normalizedDocumentId) return null;
  const validConversations = Array.isArray(conversations) ? conversations.filter((item) => cleanId(item?.id)) : [];
  const explicitlyBoundId = cleanId(bindingRecord(bindings)[normalizedDocumentId]);
  if (explicitlyBoundId) {
    const explicitlyBound = validConversations.find((item) => cleanId(item.id) === explicitlyBoundId);
    if (explicitlyBound && conversationMatchesDocument(explicitlyBound, normalizedDocumentId)) return explicitlyBound;
  }
  const current = validConversations.find((item) => cleanId(item.id) === cleanId(currentConversationId));
  if (conversationMatchesDocument(current, normalizedDocumentId)) return current;
  for (const field of ["homeDocumentId", "boundDocumentId"]) {
    const matched = validConversations.find((item) => cleanId(item?.[field]) === normalizedDocumentId);
    if (matched) return matched;
  }
  return validConversations.find((item) => item?.documentBindingMode !== "fixed"
    && Number(item.documentAssociationHistory?.[normalizedDocumentId]) > 0) ?? null;
};

export const normalizeDocumentConversationBindings = ({
  bindings = {},
  conversations = [],
  documentIds = [],
  activeDocumentId = "",
  activeConversationId = "",
} = {}) => {
  const validConversations = Array.isArray(conversations) ? conversations.filter((item) => cleanId(item?.id)) : [];
  const conversationIds = new Set(validConversations.map((item) => cleanId(item.id)));
  const allowedDocumentIds = new Set((Array.isArray(documentIds) ? documentIds : []).map(cleanId).filter(Boolean));
  const documentIsAllowed = (documentId) => !allowedDocumentIds.size || allowedDocumentIds.has(documentId);
  let normalized = Object.fromEntries(Object.entries(bindingRecord(bindings))
    .map(([documentId, conversationId]) => [cleanId(documentId), cleanId(conversationId)])
    .filter(([documentId, conversationId]) => {
      if (!documentId || !documentIsAllowed(documentId) || !conversationIds.has(conversationId)) return false;
      const conversation = validConversations.find((item) => cleanId(item.id) === conversationId);
      return conversationMatchesDocument(conversation, documentId);
    }));

  const candidateDocumentIds = new Set();
  for (const conversation of validConversations) {
    [conversation.homeDocumentId, conversation.boundDocumentId].map(cleanId).filter(Boolean).forEach((id) => candidateDocumentIds.add(id));
    Object.keys(bindingRecord(conversation.documentAssociationHistory)).map(cleanId).filter(Boolean).forEach((id) => candidateDocumentIds.add(id));
  }
  const normalizedActiveDocumentId = cleanId(activeDocumentId);
  if (normalizedActiveDocumentId) candidateDocumentIds.add(normalizedActiveDocumentId);

  for (const documentId of candidateDocumentIds) {
    if (!documentIsAllowed(documentId) || normalized[documentId]) continue;
    // Conversation arrays are newest-first in the workspace. Do not synthesize
    // timestamps during migration: doing so lets an older conversation appear
    // newer after every restart.
    const conversation = conversationForDocument({
      bindings: normalized,
      conversations: validConversations,
      documentId,
    });
    if (conversation) normalized = bindConversationToDocument(normalized, documentId, conversation.id);
  }

  if (normalizedActiveDocumentId && !normalized[normalizedActiveDocumentId] && conversationIds.has(cleanId(activeConversationId))) {
    const activeConversation = validConversations.find((item) => cleanId(item.id) === cleanId(activeConversationId));
    if (conversationMatchesDocument(activeConversation, normalizedActiveDocumentId)) {
      normalized = bindConversationToDocument(normalized, normalizedActiveDocumentId, activeConversationId);
    }
  }
  return normalized;
};
