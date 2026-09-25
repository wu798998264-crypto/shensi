import { conversationWorkspaceKey, conversationWorkspaceOwner } from "../workspace-conversation-policy.js";
import { listWorkspaceProjects, listWorkspaceNotebooks, loadWorkspaceDirectoryState } from "./workspace.mjs";

const listWorkspaces = async (appRoot) => [
  ...(await listWorkspaceProjects({ appRoot })).map((item) => ({ ...item, workspaceKind: "project" })),
  ...(await listWorkspaceNotebooks({ appRoot })).map((item) => ({ ...item, workspaceKind: "notebook" })),
];

const conversationEpoch = (conversation = {}) => {
  const explicit = Math.max(Number(conversation?.updatedAtEpoch) || 0, Number(conversation?.createdAtEpoch) || 0);
  if (explicit > 0) return explicit;
  const match = String(conversation?.id || "").match(/^conversation-(\d{10,})/u);
  return match ? Number(match[1]) || 0 : 0;
};

const conversationEntry = ({ workspace, state, conversation, index }) => {
    const owner = conversationWorkspaceOwner(conversation, { ...workspace, workspaceName: workspace.name || state.projectName });
    return {
      id: conversation.id,
      title: conversation.title || "新对话",
      updatedAt: conversation.updatedAt || conversation.createdAt || "",
      updatedAtEpoch: conversationEpoch(conversation),
      messageCount: (conversation.messages || []).length,
      owner,
      storageWorkspacePath: workspace.workspacePath,
      storageWorkspaceKind: workspace.workspaceKind,
      key: JSON.stringify([workspace.workspaceKind, workspace.workspacePath, conversation.id]),
      _order: index,
    };
};

export const workspaceConversationEntries = ({ workspace, state = {} }) => {
  const byId = new Map();
  for (const [index, conversation] of (state.conversations || []).entries()) {
    if (!conversation?.id) continue;
    const next = conversationEntry({ workspace, state, conversation, index });
    const previous = byId.get(next.id);
    // A malformed/partially merged workspace may contain the same id more
    // than once. Keep one complete record in the history picker.
    if (!previous
      || next.updatedAtEpoch > previous.updatedAtEpoch
      || (next.updatedAtEpoch === previous.updatedAtEpoch && next.messageCount > previous.messageCount)) {
      byId.set(next.id, next);
    }
  }
  return [...byId.values()]
    .sort((left, right) => (right.updatedAtEpoch - left.updatedAtEpoch) || (left._order - right._order))
    .map(({ _order, ...entry }) => entry);
};

export const listWorkspaceConversations = async ({ appRoot }) => {
  const workspaces = await listWorkspaces(appRoot);
  const items = [];
  const unavailable = [];
  for (const workspace of workspaces) {
    try {
      const { state } = await loadWorkspaceDirectoryState({ appRoot, requestedPath: workspace.workspacePath });
      if (state) items.push(...workspaceConversationEntries({ workspace, state }));
    } catch {
      unavailable.push({ name: workspace.name, workspaceKind: workspace.workspaceKind });
    }
  }
  return { items, unavailable };
};

export const readWorkspaceConversation = async ({ appRoot, workspacePath, workspaceKind, conversationId }) => {
  const workspaces = await listWorkspaces(appRoot);
  const workspace = workspaces.find((item) => conversationWorkspaceKey(item) === conversationWorkspaceKey({ workspacePath, workspaceKind }));
  if (!workspace) throw Object.assign(new Error("所属作品或笔记本不存在或不可访问"), { statusCode: 404 });
  const { state } = await loadWorkspaceDirectoryState({ appRoot, requestedPath: workspace.workspacePath });
  const conversation = (state?.conversations || [])
    .filter((item) => item?.id === conversationId)
    .sort((left, right) => (conversationEpoch(right) - conversationEpoch(left)) || ((right.messages?.length || 0) - (left.messages?.length || 0)))[0];
  if (!conversation) throw Object.assign(new Error("历史对话不存在"), { statusCode: 404 });
  const owner = conversationWorkspaceOwner(conversation, { ...workspace, workspaceName: workspace.name });
  return {
    id: conversation.id, title: conversation.title || "新对话", owner, readOnly: true,
    ownerAvailable: workspaces.some((item) => conversationWorkspaceKey(item) === conversationWorkspaceKey(owner)),
    messages: (conversation.messages || []).filter((item) => ["user", "assistant"].includes(item.role)).map((item) => ({
      id: item.id, role: item.role, time: item.time || "",
      content: String(item.candidate || item.content || item.lead || ""),
      attachments: (item.attachments || []).map(({ name }) => ({ name: String(name || "附件") })),
    })),
  };
};
