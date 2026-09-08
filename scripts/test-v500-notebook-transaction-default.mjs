import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-v500-notebook-transaction-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

const { persistentNotesRoot, persistentWorksRoot } = await import("../src/server/app-data.mjs");
const { executeDocumentTransaction } = await import("../src/server/native-document-transaction-service.mjs");
const { loadWorkspaceState } = await import("../src/server/workspace.mjs");

const workspacePath = join(persistentNotesRoot(), "尚未初始化的笔记本");
const operation = {
  operationId: "create-first-note",
  type: "create",
  targetDocumentId: "note-001",
  targetDirectoryId: "library",
  contentType: "note",
  requestedTitle: "第一篇测试笔记",
  content: "这是通过底层事务写入尚未初始化笔记本的第一篇正式笔记。",
};
const instruction = "执行尚未初始化笔记本正式文档事务";
const authorizedCandidate = operation.content;
const writeAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
  instruction,
  sourceMessageId: "v500-notebook-user",
  targetDocumentIds: [operation.targetDocumentId],
  expectedRevisions: { [operation.targetDocumentId]: "" },
  targetExists: false,
  contextualWriteAction: "create",
}), { candidate: authorizedCandidate, targetDocumentIds: [operation.targetDocumentId], expectedRevisions: { [operation.targetDocumentId]: "" } });

try {
  await mkdir(workspacePath, { recursive: true });
  const receipt = await executeDocumentTransaction({
    appRoot: dataRoot,
    workspacePath,
    task: {
      executionSurface: "chat",
      operation: "create",
      instruction,
      authorizedCandidate,
      writeAuthorization,
      source: { documentIds: [] },
      target: { workId: "尚未初始化的笔记本", directoryId: "library" },
    },
    operations: [operation],
    expectedRevisions: { [operation.targetDocumentId]: "" },
    commitMode: "atomic",
    requestId: "v500-notebook-default",
    batchId: "v500-notebook-default-batch",
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.verified, true);
  assert.equal(receipt.results[0].verified, true);

  const loaded = await loadWorkspaceState({ appRoot: dataRoot, requestedPath: workspacePath });
  assert.equal(loaded.state.workspaceKind, "notebook", "未初始化笔记本必须按路径建立 notebook 状态");
  assert.equal(loaded.state.activeModule, "library");
  assert.equal(loaded.state.documents[operation.targetDocumentId].markdown, operation.content);
  assert.equal(loaded.state.documents[operation.targetDocumentId].moduleId, "library");
  assert.equal(loaded.state.moduleItems.library.some(([id]) => id === operation.targetDocumentId), true);

  const projectPath = join(persistentWorksRoot(), "尚未初始化的作品");
  const projectOperation = {
    ...operation,
    operationId: "create-first-project-document",
    targetDocumentId: "canon-qa-001",
    targetDirectoryId: "canon",
    contentType: "setting",
    requestedTitle: "第一份测试设定",
    content: "这是通过底层事务写入尚未初始化作品的第一份正式设定。",
  };
  const projectAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction,
    sourceMessageId: "v500-project-user",
    targetDocumentIds: [projectOperation.targetDocumentId],
    expectedRevisions: { [projectOperation.targetDocumentId]: "" },
    targetExists: false,
    contextualWriteAction: "create",
  }), {
    candidate: projectOperation.content,
    targetDocumentIds: [projectOperation.targetDocumentId],
    expectedRevisions: { [projectOperation.targetDocumentId]: "" },
  });
  await mkdir(projectPath, { recursive: true });
  await executeDocumentTransaction({
    appRoot: dataRoot,
    workspacePath: projectPath,
    task: {
      executionSurface: "chat",
      operation: "create",
      instruction,
      authorizedCandidate: projectOperation.content,
      writeAuthorization: projectAuthorization,
      source: { documentIds: [] },
      target: { workId: "尚未初始化的作品", directoryId: "canon" },
    },
    operations: [projectOperation],
    expectedRevisions: { [projectOperation.targetDocumentId]: "" },
    commitMode: "atomic",
    requestId: "v500-project-default",
    batchId: "v500-project-default-batch",
  });
  const loadedProject = await loadWorkspaceState({ appRoot: dataRoot, requestedPath: projectPath });
  assert.equal(loadedProject.state.workspaceKind, "project", "未初始化作品必须继续按路径建立 project 状态");
  assert.equal(loadedProject.state.documents[projectOperation.targetDocumentId].moduleId, "canon");

  console.log(JSON.stringify({
    ok: true,
    notebookKind: loaded.state.workspaceKind,
    projectKind: loadedProject.state.workspaceKind,
    targetPath: receipt.results[0].targetPath,
  }));
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
