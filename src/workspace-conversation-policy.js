const text = (value) => String(value ?? "").trim();
const kind = (value) => value === "notebook" ? "notebook" : "project";
const pathKey = (value) => text(value).replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();

export const conversationWorkspaceKey = (workspace = {}) => `${kind(workspace.workspaceKind)}:${pathKey(workspace.workspacePath)}`;

export const conversationWorkspaceOwner = (conversation = {}, fallback = {}) => {
  const origin = conversation.workspaceOwner?.workspacePath ? conversation.workspaceOwner
    : (conversation.messages || []).find((message) => message.role === "user" && message.turnContextSnapshot?.workspacePath)?.turnContextSnapshot
      || fallback;
  return {
    workspaceKind: kind(origin.workspaceKind ?? fallback.workspaceKind),
    workspacePath: text(origin.workspacePath || fallback.workspacePath),
    workspaceName: text(origin.workspaceName || origin.projectName || fallback.workspaceName || fallback.name),
  };
};

export const conversationBelongsToWorkspace = (conversation = {}, workspace = {}) => (
  conversationWorkspaceKey(conversationWorkspaceOwner(conversation, workspace)) === conversationWorkspaceKey(workspace)
);

export const taskConversationMetadata = (conversation = {}, workspace = {}) => ({
  workspaceOwner: conversationWorkspaceOwner(conversation, workspace),
  documentBindingMode: "task",
  autoAssociateActiveDocument: false,
  boundDocumentId: null,
  homeDocumentId: null,
  ...(conversation.legacyDocumentBinding ? { legacyDocumentBinding: conversation.legacyDocumentBinding }
    : conversation.boundDocumentId || conversation.homeDocumentId ? {
      legacyDocumentBinding: { boundDocumentId: conversation.boundDocumentId || null, homeDocumentId: conversation.homeDocumentId || null },
    } : {}),
});

// Resolve phrases that refer to the document the user is looking at when the
// instruction is sent.  Keep this semantic and bounded: it must not turn an
// ordinary conversation into a write target, but common variants such as
// “写入到当前打开的文档” must be equivalent to “当前文档”.
export const requestsCurrentDocument = (instruction = "") => {
  const source = text(instruction).normalize("NFKC");
  if (!source) return false;
  return /(?:当前|正在|刚打开|新打开|选中的|本次打开的|当前打开的)(?:.{0,16})(?:文档|正文|文件|笔记|章节)|(?:这篇|这份|这个)(?:.{0,8})(?:打开的)?(?:文档|正文|文件|笔记)|(?:写入|写到|追加到|保存到|放入|覆盖|更新)(?:.{0,8})(?:当前|正在|刚打开|新打开|选中的|本次打开的)(?:.{0,8})(?:文档|正文|文件|笔记|章节)/u.test(source);
};

export const taskDocumentAnchor = ({ instruction = "", activeDocumentId = "", targetDocumentId = "" } = {}) => (
  text(targetDocumentId) || (requestsCurrentDocument(instruction) ? text(activeDocumentId) : "")
);

// Navigation memory is scoped to a visible module *and* its view.  Older
// workspaces only persisted one document per module, so retain that value as a
// compatibility fallback when it still belongs to the requested view.
export const rememberedModuleDocument = ({ moduleId = "", viewId = "", remembered = {}, documentIds = [] } = {}) => {
  const ids = new Set((Array.isArray(documentIds) ? documentIds : []).filter(Boolean));
  const keys = [
    viewId ? `${moduleId}:${viewId}` : "",
    moduleId,
  ].filter((key, index, all) => key && all.indexOf(key) === index);
  for (const key of keys) {
    if (ids.has(remembered?.[key])) return remembered[key];
  }
  return documentIds[0] || "";
};

export const taskScopedConversationMessages = (messages = []) => {
  const lastUser = [...messages].reverse().find((message) => message.role === "user" && !message.pending);
  const taskId = lastUser?.turnContextSnapshot?.taskId;
  if (!taskId) return messages;
  const userIds = new Set(messages.filter((message) => message.role === "user" && message.turnContextSnapshot?.taskId === taskId && message.id).map((message) => message.id));
  const selected = messages.filter((message) => message.turnContextSnapshot?.taskId === taskId || message.taskId === taskId
    || userIds.has(message.execution?.sourceMessageId));
  if (lastUser.turnContextSnapshot.continuesTask === false) return selected;
  if (lastUser.turnContextSnapshot.continuesTask && selected.filter((message) => message.role === "user").length === 1) {
    const lastIndex = messages.indexOf(lastUser);
    const previous = messages.slice(0, lastIndex).findLastIndex((message) => message.role === "user");
    if (previous >= 0) return [...messages.slice(previous, lastIndex), ...selected];
  }
  return selected;
};
