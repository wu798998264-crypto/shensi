import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlankNotebookState } from "../src/data.js";
import { createConversationAgentTools } from "../src/server/conversation-agent-tools.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-agent-structure-tools-"));
try {
  const workspacePath = join(root, "runtime", "E-drive-data", "笔记", "结构工具测试");
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state: createBlankNotebookState({ name: "结构工具测试" }) });
  const loaded = await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath });
  const state = structuredClone(loaded.state);
  state.documents["note-agent"] = { title: "Agent源文档", markdown: "源文档正文", html: "<p>源文档正文</p>", moduleId: "library", documentKind: "note" };
  state.moduleItems.library.push(["note-agent", "Agent源文档", { workspaceView: "default" }]);
  state.histories["note-agent"] = [{ id: "history-content", content: "历史版本完整正文" }];
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state, expectedStateStamp: loaded.stateStamp });

  const tools = createConversationAgentTools({
    appRoot: root,
    workspacePath,
    workspaceKind: "notebook",
    requestId: "structure-tools-test",
    sourceMessageId: "structure-tools-message",
    instruction: "调整工作区结构",
    signal: new AbortController().signal,
    catalog: [],
    readSkill: async () => "",
  });
  const call = async (tool, args) => {
    const result = await tools.invoke({ namespace: "documents", tool, arguments: args });
    assert.equal(result.success, true, result.contentItems[0].text);
    return JSON.parse(result.contentItems[0].text);
  };

  let inventory = await call("list", {});
  assert.ok(inventory.revision);
  const history = await call("history", { documentId: "note-agent", versionId: "history-content" });
  assert.equal(history.version.content, "历史版本完整正文", "历史版本的 content 字段必须可被 Agent 读取");
  const ensured = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-create-folder",
    operations: [
      { type: "folder.ensure", moduleId: "library", viewId: "default", name: "Agent资料" },
      { type: "document.move", documentId: "note-agent", moduleId: "library", viewId: "default", folderLabel: "Agent资料" },
    ],
  });
  assert.equal(ensured.changed, 2);
  inventory = await call("list", { query: "Agent" });
  const copied = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-copy-document",
    operations: [{ type: "document.copy", documentId: "note-agent", title: "Agent复制", moduleId: "library", viewId: "default", folderLabel: "Agent资料" }],
  });
  const copiedId = copied.results[0].targetDocumentId;
  inventory = await call("list", { query: copiedId });
  const renamed = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-rename-document",
    operations: [{ type: "document.rename", documentId: copiedId, title: "Agent复制后" }],
  });
  assert.equal(renamed.changed, 1);
  inventory = await call("list", { query: copiedId });
  const deleted = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-delete-document",
    operations: [{ type: "document.delete", documentId: copiedId }],
  });
  assert.equal(deleted.results[0].trashId.startsWith("trash-"), true);
  inventory = await call("list", {});
  const restoredCopy = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-restore-document",
    operations: [{ type: "document.restore", trashId: deleted.results[0].trashId }],
  });
  assert.equal(restoredCopy.results[0].documentId, copiedId);
  inventory = await call("list", {});
  const folderId = inventory.folders.find((folder) => folder.label === "Agent资料")?.id;
  assert.ok(folderId);
  const folderDeleted = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-delete-folder",
    operations: [{ type: "folder.delete", folderId }],
  });
  const folderTrashId = folderDeleted.results[0].trashId;
  const afterFolderDelete = (await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath })).state;
  assert.equal(afterFolderDelete.documents["note-agent"], undefined);
  assert.equal(afterFolderDelete.documents[copiedId], undefined);
  assert.equal(afterFolderDelete.customFolders.some((folder) => folder.id === folderId), false);
  assert.ok(afterFolderDelete.trash.some((entry) => entry.trashId === folderTrashId));
  const trash = await call("trash", { query: "Agent资料" });
  assert.ok(trash.entries.some((entry) => entry.kind === "folder" && entry.trashId === folderTrashId && entry.documentCount === 2));

  inventory = await call("list", {});
  const folderRestored = await call("structure_apply", {
    expectedRevision: inventory.revision,
    operationId: "structure-restore-folder",
    operations: [{ type: "folder.restore", trashId: folderTrashId }],
  });
  assert.equal(folderRestored.results[0].folderId, folderId);
  const final = (await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath })).state;
  assert.equal(final.documents["note-agent"].markdown, "源文档正文");
  assert.equal(final.documents[copiedId].markdown, "源文档正文");
  assert.equal(final.customFolders.some((folder) => folder.id === folderId), true);
  assert.equal(final.trash.some((entry) => entry.trashId === folderTrashId), false);
  assert.ok((final.projectHistories || []).length >= 7);
  console.log("conversation Agent structure tools passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
