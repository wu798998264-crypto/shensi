import { conversationWorkspaceKey, conversationWorkspaceOwner } from "../workspace-conversation-policy.js";
import { listWorkspaceProjects, listWorkspaceNotebooks, loadWorkspaceDirectoryState } from "./workspace.mjs";

const listWorkspaces = async (appRoot) => [
  ...(await listWorkspaceProjects({ appRoot })).map((item) => ({ ...item, workspaceKind: "project" })),
  ...(await listWorkspaceNotebooks({ appRoot })).map((item) => ({ ...item, workspaceKind: "notebook" })),
];

export const workspaceConversationEntries = ({ workspace, state = {} }) => (state.conversations || [])
  .filter((conversation) => conversation?.id)
  .map((conversation) => {
    const owner = conversationWorkspaceOwner(conversation, { ...workspace, workspaceName: workspace.name || state.projectName });
    return {
      id: conversation.id,
      title: conversation.title || "新对话",
      updatedAt: conversation.updatedAt || conversation.createdAt || "",
      messageCount: (conversation.messages || []).length,
      owner,
      storageWorkspacePath: workspace.workspacePath,
      storageWorkspaceKind: workspace.workspaceKind,
      key: JSON.stringify([workspace.workspaceKind, workspace.workspacePath, conversation.id]),
    };
  });

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
  const conversation = state?.conversations?.find((item) => item.id === conversationId);
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
