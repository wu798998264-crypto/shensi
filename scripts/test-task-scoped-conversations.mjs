import assert from "node:assert/strict";
import { conversationBelongsToWorkspace, conversationWorkspaceOwner, taskConversationMetadata, taskDocumentAnchor,
  rememberedModuleDocument, taskScopedConversationMessages } from "../src/workspace-conversation-policy.js";

const a = { workspaceKind: "project", workspacePath: "C:/works/A", workspaceName: "A" };
const b = { workspaceKind: "project", workspacePath: "C:/works/B", workspaceName: "B" };
const notebook = { ...a, workspaceKind: "notebook" };
const old = { id: "chat", boundDocumentId: "chapter-1", messages: [{ role: "user", turnContextSnapshot: a, content: "Create work B" }] };
const migrated = { ...old, ...taskConversationMetadata(old, a) };
assert.equal(migrated.boundDocumentId, null);
assert.equal(migrated.autoAssociateActiveDocument, false);
assert.deepEqual(migrated.messages, old.messages);
assert.equal(migrated.legacyDocumentBinding.boundDocumentId, "chapter-1");
assert.equal(conversationBelongsToWorkspace(migrated, a), true);
assert.equal(conversationBelongsToWorkspace(migrated, { ...a, workspacePath: "c:\\works\\a\\" }), true);
assert.equal(conversationBelongsToWorkspace(migrated, b), false);
assert.equal(conversationBelongsToWorkspace(migrated, notebook), false);
assert.equal(conversationBelongsToWorkspace(old, b), false, "Copied creation conversations retain source ownership");
assert.deepEqual(conversationWorkspaceOwner({ messages: [] }, b), b);
assert.equal(taskDocumentAnchor({ instruction: "读取当前文档", activeDocumentId: "chapter-2" }), "chapter-2");
assert.equal(taskDocumentAnchor({ instruction: "写第三章", activeDocumentId: "chapter-2" }), "");
assert.equal(taskDocumentAnchor({ instruction: "参考当前文档", activeDocumentId: "chapter-2", targetDocumentId: "report-novel" }), "report-novel");
assert.equal(rememberedModuleDocument({ moduleId: "index", documentIds: ["report-compile", "index-creative-guidance"] }), "report-compile");
assert.equal(rememberedModuleDocument({ moduleId: "index", remembered: { index: "report-novel" }, documentIds: ["index-creative-guidance", "report-novel"] }), "report-novel");
assert.equal(rememberedModuleDocument({ moduleId: "index", remembered: { index: "deleted" }, documentIds: ["index-creative-guidance"] }), "index-creative-guidance");
for (const moduleId of ["index", "manuscript", "outline", "canon", "memory", "library"]) {
  assert.equal(rememberedModuleDocument({ moduleId, documentIds: ["first", "second"] }), "first");
  assert.equal(rememberedModuleDocument({ moduleId, remembered: { [moduleId]: "second" }, documentIds: ["first", "second"] }), "second");
  assert.equal(rememberedModuleDocument({ moduleId, remembered: { [moduleId]: "deleted" }, documentIds: ["first", "second"] }), "first");
}
assert.deepEqual(taskScopedConversationMessages([
  { role: "user", content: "old constraint", turnContextSnapshot: { taskId: "old" } },
  { role: "assistant", content: "old candidate", taskId: "old" },
  { role: "user", content: "new task", turnContextSnapshot: { taskId: "new", continuesTask: false } },
]), [{ role: "user", content: "new task", turnContextSnapshot: { taskId: "new", continuesTask: false } }]);
console.log("Task-scoped conversation ownership/navigation policies passed");
