import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createBlankNotebookState, createBlankProjectState } from "../src/data.js";
import {
  conversationBelongsToWorkspace,
  requestsCurrentDocument,
  taskConversationMetadata,
  taskDocumentAnchor,
} from "../src/workspace-conversation-policy.js";

async function sourceBlock(start, end, limit = 250) {
  const stream = createReadStream(resolve(import.meta.dirname, "../src/app.js"), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const collected = [];
  try {
    for await (const line of lines) {
      if (!collected.length && !line.includes(start)) continue;
      if (collected.length && line.includes(end)) return collected.join("\n");
      collected.push(line);
      assert.ok(collected.length < limit, `bounded source block: ${start}`);
    }
    assert.fail(`missing source block: ${start}`);
  } finally {
    lines.close();
    stream.destroy();
  }
}

const workspace = { workspaceKind: "project", workspacePath: "C:/works/A", workspaceName: "A" };
const legacy = { id: "legacy", boundDocumentId: "chapter-1", homeDocumentId: "chapter-1", messages: [] };
const migrated = { ...legacy, ...taskConversationMetadata(legacy, workspace) };
assert.equal(migrated.documentBindingMode, "task");
assert.equal(migrated.autoAssociateActiveDocument, false);
assert.equal(migrated.boundDocumentId, null);
assert.equal(migrated.homeDocumentId, null);
assert.deepEqual(migrated.legacyDocumentBinding, { boundDocumentId: "chapter-1", homeDocumentId: "chapter-1" });
assert.equal(conversationBelongsToWorkspace(migrated, workspace), true);

for (const instruction of ["修改当前文档", "读取刚打开的笔记", "润色选中的正文", "检查这个打开的文档"]) {
  assert.equal(requestsCurrentDocument(instruction), true, instruction);
  assert.equal(taskDocumentAnchor({ instruction, activeDocumentId: "chapter-2" }), "chapter-2");
}
assert.equal(taskDocumentAnchor({ instruction: "写第三章", activeDocumentId: "chapter-2" }), "");
assert.equal(taskDocumentAnchor({ instruction: "参考当前文档", activeDocumentId: "chapter-2", targetDocumentId: "report-novel" }), "report-novel");

const project = createBlankProjectState({ name: "Blank", workspacePath: "C:/works/blank" });
const notebook = createBlankNotebookState({ name: "Notes", workspacePath: "C:/notes/blank" });
for (const blank of [project, notebook]) {
  assert.deepEqual(blank.messages, []);
  assert.equal(blank.conversations.length, 1);
  assert.deepEqual(blank.conversations[0].messages, []);
  assert.equal(blank.conversations[0].boundDocumentId, null);
  assert.equal(blank.conversations[0].documentBindingMode, "task");
}

const navigation = await sourceBlock("const selectDocument =", "const moduleNavigationDocumentIds =");
assert.match(navigation, /state\.activeDocument = documentId/u);
assert.doesNotMatch(navigation, /activateConversationForDocument|loadConversation|bindConversationToDocument|activeConversationId\s*=/u,
  "document navigation must not switch conversations");

const resumeIdentity = await sourceBlock("const resumePointerIdentity =", "let activeWorkspaceResumeRevision =");
assert.doesNotMatch(resumeIdentity, /activeConversationId|activeConversationSeed/u,
  "workspace view pointer identity must not depend on the active conversation");
const activeWorkspacePointer = await sourceBlock("const currentActiveWorkspacePointer =", "const persistActiveWorkspacePointer =");
assert.match(activeWorkspacePointer, /activeModule: state\.activeModule/u);
assert.match(activeWorkspacePointer, /activeDocument: state\.activeDocument/u);
assert.doesNotMatch(activeWorkspacePointer, /activeConversationId|activeConversationSeed|homeDocumentId|boundDocumentId/u,
  "workspace view pointers must contain navigation only");
const restoreWorkspaceView = await sourceBlock("const restoreActiveWorkspaceView =", "const cacheWorkspaceState =");
assert.doesNotMatch(restoreWorkspaceView, /loadConversation|bindConversationToDocument|newConversationRecord|activeConversationSeed/u,
  "restoring a document position must not load, create, or bind a conversation");
const applyResumePointer = await sourceBlock("const applyRecoveryResumePointerToState =", "const hydrateRecoveryResumePointer =");
assert.doesNotMatch(applyResumePointer, /activeConversationId/u,
  "applying a navigation resume pointer must not switch conversations");
const createConversation = await sourceBlock("const createConversation =", "const createConversationFromToolbar =");
assert.doesNotMatch(createConversation, /bindConversationToDocument|homeDocumentId/u,
  "creating a conversation must not bind it to the open document");

const recoveryStoreSource = await readFile(new URL("../src/server/recovery-store.mjs", import.meta.url), "utf8");
const resumeStateStart = recoveryStoreSource.indexOf("const normalizedResumeState =");
const resumeStateEnd = recoveryStoreSource.indexOf("export const loadRecoveryResumeState", resumeStateStart);
assert.ok(resumeStateStart >= 0 && resumeStateEnd > resumeStateStart, "recovery resume state normalizer must exist");
const normalizedResumeState = recoveryStoreSource.slice(resumeStateStart, resumeStateEnd);
assert.doesNotMatch(normalizedResumeState, /activeConversationId|activeConversationSeed|homeDocumentId|boundDocumentId/u,
  "server-side resume state must persist workspace navigation only");

const dispatch = await sourceBlock("const dispatchComposerContent =", "let agentProfileChoiceContext = null");
assert.ok(dispatch.indexOf("captureTaskContextSnapshot") < dispatch.indexOf("dispatchAfterImmediateInstructionPaint"),
  "the task snapshot must be captured before the delayed paint callback");
assert.doesNotMatch(dispatch, /specialOperationRequest|isConversationSkillInstallRequest|isSelfRepairRequest/u,
  "安装和自修复也必须先进入统一 Agent，不能在提交入口按关键词分流");
assert.doesNotMatch(dispatch, /sendCodexAgentMessage\(/u,
  "普通提交入口不得让任何特殊指令绕过统一排队顺序");
assert.match(dispatch, /const snapshot = taskContextSnapshot\s*\?\s*clone\(taskContextSnapshot\)\s*:\s*captureTaskContextSnapshot\(targetConversationId\)/u,
  "提交入口必须在延迟渲染前冻结本轮任务上下文");
assert.match(dispatch, /sendMessage\([\s\S]*taskContextSnapshot: snapshot/u,
  "统一 Agent 必须接收提交时冻结的任务上下文");

const queue = await sourceBlock("const enqueueMessage =", "const updateQueuedMessage =");
assert.match(queue, /taskContextSnapshot = null/u);
assert.match(queue, /taskContextSnapshot: clone\(taskContextSnapshot \|\| captureTaskContextSnapshot\(conversation\.id\)\)/u);

const agentHead = await sourceBlock("const sendCodexAgentMessage =", "const completedPriorMessages =");
assert.match(agentHead, /taskContextSnapshot = null/u);
assert.match(agentHead, /submittedTaskContextSnapshot = queuedItem\?\.taskContextSnapshot \|\| taskContextSnapshot/u);
assert.match(agentHead, /taskDocumentAnchor\(\{ instruction: prompt, activeDocumentId: submittedTaskContextSnapshot\.activeDocumentId \}\)/u);
assert.doesNotMatch(agentHead, /associatedDocumentId\(conversation, state\.activeDocument\)/u);

const preview = await sourceBlock("const closeConversationPreview =", "const jumpToConversationOwner =");
assert.match(preview, /conversationPreviewBlocksComposerMutation/u);
assert.match(preview, /历史对话只读/u);
assert.match(preview, /restoreComposerDraftToInput\(activeConversation\(\)\)/u);
assert.match(preview, /data-jump-history-owner/u);

const attachments = await sourceBlock("const addAttachments =", "const openProjectRowMenu =");
assert.match(attachments, /if \(conversationPreviewBlocksComposerMutation\(\)\) return false/u);
const chatPaste = await sourceBlock('// Paste image to chat input as attachment', '  const documentState = activeWhiteboardDocument();', 120);
assert.match(chatPaste, /conversationPreviewBlocksComposerMutation/u);
const submit = await sourceBlock('document.querySelector("#chatForm").addEventListener("submit"', "const finalizeTemporaryCodexLogin =");
assert.match(submit, /event\.preventDefault\(\);\s*if \(conversationPreviewBlocksComposerMutation\(\)\) return/u);
const dragAndDrop = await sourceBlock('["dragenter", "dragover"]', 'window.addEventListener("dragend"');
assert.match(dragAndDrop, /conversationPreviewBlocksComposerMutation/g);

console.log("Task-scoped conversation, send snapshot and read-only history contracts passed");
