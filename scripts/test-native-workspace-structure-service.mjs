import assert from "node:assert/strict";
import { createBlankProjectState } from "../src/data.js";
import { executeWorkspaceStructureTransaction, workspaceStructureInventory, workspaceStructureRevision } from "../src/server/native-workspace-structure-service.mjs";

const state = createBlankProjectState({ name: "结构事务测试", workspacePath: "C:\\temp\\structure-service" });
state.documents = {
  "doc-a": { title: "甲", markdown: "甲正文", moduleId: "manuscript", workspaceView: "novel", placementOverride: true },
  "doc-b": { title: "乙", markdown: "乙正文", moduleId: "manuscript", workspaceView: "novel", placementOverride: true },
};
state.moduleItems = { manuscript: [["doc-a", "甲", { workspaceView: "novel" }], ["doc-b", "乙", { workspaceView: "novel" }]] };
state.histories = { "doc-a": [], "doc-b": [] };
state.projectHistories = [];
state.documentTransactionLog = {};
state.trash = [];
let currentState = structuredClone(state);
let stateStamp = "stamp-1";
const load = async () => ({ state: structuredClone(currentState), stateStamp });
const save = async ({ state: next, expectedStateStamp }) => {
  assert.equal(expectedStateStamp, stateStamp);
  currentState = structuredClone(next);
  stateStamp = `stamp-${Number(stateStamp.split("-").at(-1)) + 1}`;
  return { batchLandingReceipt: { verified: true, failed: 0 } };
};

const initialRevision = workspaceStructureRevision(currentState);
const moved = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: initialRevision,
  operationId: "structure-test-move",
  operations: [
    { type: "folder.ensure", moduleId: "manuscript", viewId: "novel", name: "第一卷" },
    { type: "document.move", documentId: "doc-a", moduleId: "manuscript", viewId: "novel", folderLabel: "第一卷" },
  ],
  load,
  save,
});
assert.equal(moved.verified, true);
assert.equal(moved.changed, 2);
assert.ok(moved.historyVersionId);
assert.equal(currentState.documents["doc-a"].customFolderName, "第一卷");
assert.equal(currentState.projectHistories.length, 1, "结构修改前必须保留完整项目历史快照");

const replay = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: "stale-is-ignored-for-replay",
  operationId: "structure-test-move",
  operations: [
    { type: "folder.ensure", moduleId: "manuscript", viewId: "novel", name: "第一卷" },
    { type: "document.move", documentId: "doc-a", moduleId: "manuscript", viewId: "novel", folderLabel: "第一卷" },
  ],
  load,
  save,
});
assert.equal(replay.idempotentReplay, true);
assert.equal(currentState.projectHistories.length, 1, "幂等重试不能重复创建历史快照");

const copied = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: workspaceStructureRevision(currentState),
  operationId: "structure-test-copy",
  operations: [{ type: "document.copy", documentId: "doc-a", targetDocumentId: "doc-c", title: "甲副本", moduleId: "manuscript", viewId: "novel", folderLabel: "第一卷" }],
  load,
  save,
});
assert.equal(copied.results[0].targetDocumentId, "doc-c");
assert.equal(currentState.documents["doc-c"].markdown, "甲正文");

const deleted = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: workspaceStructureRevision(currentState),
  operationId: "structure-test-delete",
  operations: [{ type: "document.delete", documentId: "doc-b" }],
  load,
  save,
});
const trashId = deleted.results[0].trashId;
assert.ok(trashId);
assert.equal(currentState.documents["doc-b"], undefined);
assert.equal(workspaceStructureInventory(currentState).documents.some((item) => item.id === "doc-b"), false);

const restored = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: workspaceStructureRevision(currentState),
  operationId: "structure-test-restore",
  operations: [{ type: "document.restore", trashId }],
  load,
  save,
});
assert.equal(restored.results[0].documentId, "doc-b");
assert.equal(currentState.documents["doc-b"].markdown, "乙正文");
assert.equal(currentState.trash.some((entry) => entry.trashId === trashId), false);

const folderId = currentState.customFolders.find((folder) => folder.label === "第一卷")?.id;
assert.ok(folderId, "测试文件夹必须存在");
const folderDeleted = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: workspaceStructureRevision(currentState),
  operationId: "structure-test-folder-delete",
  operations: [{ type: "folder.delete", folderId }],
  load,
  save,
});
const folderTrashId = folderDeleted.results[0].trashId;
assert.ok(folderTrashId);
assert.equal(currentState.documents["doc-a"], undefined);
assert.equal(currentState.documents["doc-c"], undefined);
assert.equal(currentState.customFolders.some((folder) => folder.id === folderId), false);

const folderRestored = await executeWorkspaceStructureTransaction({
  workspacePath: state.settings.workspacePath,
  expectedRevision: workspaceStructureRevision(currentState),
  operationId: "structure-test-folder-restore",
  operations: [{ type: "folder.restore", trashId: folderTrashId }],
  load,
  save,
});
assert.equal(folderRestored.results[0].folderId, folderId);
assert.equal(currentState.documents["doc-a"].markdown, "甲正文");
assert.equal(currentState.documents["doc-c"].markdown, "甲正文");
assert.equal(currentState.customFolders.some((folder) => folder.id === folderId), true);
assert.equal(currentState.trash.some((entry) => entry.trashId === folderTrashId), false);

await assert.rejects(
  executeWorkspaceStructureTransaction({
    workspacePath: state.settings.workspacePath,
    expectedRevision: "wrong-revision",
    operationId: "structure-test-conflict",
    operations: [{ type: "document.rename", documentId: "doc-b", title: "乙改名" }],
    load,
    save,
  }),
  (error) => error.code === "WORKSPACE_STRUCTURE_REVISION_CONFLICT",
);

console.log("native workspace structure transaction regressions passed");
