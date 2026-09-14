import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBlankProjectState } from "../src/data.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-atomic-folder-"));
try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "atomic-folder");
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: createBlankProjectState("atomic-folder") });
  const operation = {
    operationId: "atomic-create-1",
    type: "create",
    targetDocumentId: "article-1",
    targetDirectoryId: "library",
    viewId: "novel",
    folderLabel: "原子目录",
    requestedTitle: "正式文章",
    content: "这是一次目录与正文同时提交的正式内容。",
  };
  const instruction = "创建正式文章并放入原子目录";
  const authorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction,
    sourceMessageId: "user-atomic-folder",
    targetDocumentIds: [operation.targetDocumentId],
    expectedRevisions: { [operation.targetDocumentId]: "" },
    targetExists: false,
    contextualWriteAction: "create",
  }), { candidate: operation.content, targetDocumentIds: [operation.targetDocumentId], expectedRevisions: { [operation.targetDocumentId]: "" } });
  const receipt = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    operations: [operation],
    task: { executionSurface: "agent", instruction, authorizedCandidate: operation.content, writeAuthorization: authorization, source: {}, target: {} },
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.results[0].verified, true);
  assert.equal(receipt.results[0].navigationTarget.folderId.startsWith("custom-folder:"), true);
  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  const folder = loaded.state.customFolders.find((item) => item.label === "原子目录");
  assert.ok(folder, "同一事务必须创建目标文件夹");
  assert.equal(loaded.state.documents["article-1"].title, "正式文章");
  assert.equal(loaded.state.moduleItems.library.find((item) => item[0] === "article-1")[2].customFolderId, folder.id);
  assert.equal(receipt.results[0].navigationTarget.folderId, folder.id);
  console.log("文档目录原子落盘与真实导航目标测试通过");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
