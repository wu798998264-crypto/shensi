const key = (state) => `shensi-manual-conversations-v1:${state.workspaceKind}:${String(state.settings?.workspacePath || '').replaceAll('\\', '/').toLowerCase()}`;
const read = (storage, state) => JSON.parse(storage.getItem(key(state)) || '{"records":{}}');

// Tiny synchronous creation journal closes the gap before the workspace save.
// Existing conversations always win; this never restores older message bodies.
export const journalManualConversation = (storage, state, conversation) => {
  const entry = read(storage, state);
  if (conversation?.manualCreated) entry.records[conversation.id] = {
    id: conversation.id, title: conversation.title, manualCreated: true,
    createdAt: conversation.createdAt, messages: [], queue: [],
  };
  entry.activeId = state.activeConversationId;
  storage.setItem(key(state), JSON.stringify(entry));
};
export const forgetManualConversation = (storage, state, id) => {
  const entry = read(storage, state);
  delete entry.records[id];
  if (entry.activeId === id) delete entry.activeId;
  storage.setItem(key(state), JSON.stringify(entry));
};
export const restoreManualConversations = (storage, state) => {
  const entry = read(storage, state);
  state.conversations ||= [];
  const deleted = new Set((state.trash || []).filter((item) => item.kind === 'conversation').map((item) => item.conversation?.id || item.id));
  for (const record of Object.values(entry.records || {})) {
    if (!deleted.has(record.id) && !state.conversations.some((item) => item.id === record.id)) state.conversations.unshift(record);
  }
  if (state.conversations.some((item) => item.id === entry.activeId)) state.activeConversationId = entry.activeId;
};
