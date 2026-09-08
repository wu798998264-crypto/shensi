import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-full-text-transaction-"));
const sourceSha256 = "a".repeat(64);
const batchId = `fulltext-${"b".repeat(32)}`;
const documentIds = ["fulltext-batch-1", "fulltext-batch-2"];

const createImportState = ({ includeHistory = true } = {}) => {
  const state = createBlankProjectState("苍鳞御主");
  state.documents[documentIds[0]] = {
    title: "苍鳞御主｜退婚",
    html: "<p>退婚书落在桌上。</p>",
    markdown: "退婚书落在桌上。",
    moduleId: "manuscript",
    workspaceView: "novel",
    sequenceType: "chapter",
    sequenceNumber: 1,
    fullTextImportOrder: 1,
    fullTextImportId: batchId,
    fullTextSourceSha256: sourceSha256,
  };
  state.documents[documentIds[1]] = {
    title: "苍鳞御主｜觉醒",
    html: "<p>灵兽睁开双眼。</p>",
    markdown: "灵兽睁开双眼。",
    moduleId: "manuscript",
    workspaceView: "novel",
    sequenceType: "chapter",
    sequenceNumber: 2,
    fullTextImportOrder: 2,
    fullTextImportId: batchId,
    fullTextSourceSha256: sourceSha256,
  };
  state.moduleItems.manuscript.push(
    [documentIds[0], "第1章　苍鳞御主｜退婚", { sequenceType: "chapter", sequenceNumber: 1 }],
    [documentIds[1], "第2章　苍鳞御主｜觉醒", { sequenceType: "chapter", sequenceNumber: 2 }],
  );
  state.histories ??= {};
  state.histories[documentIds[0]] = [{ id: "history-1", label: "全文导入初始版本" }];
  state.histories[documentIds[1]] = includeHistory ? [{ id: "history-2", label: "全文导入初始版本" }] : [];
  state.fullTextImports = {
    [batchId]: {
      batchId,
      sourceSha256,
      chapterCount: 2,
      targetDocumentIds: documentIds,
      status: "committed",
    },
  };
  return state;
};

const operationVerification = {
  kind: "full_text_import_v1",
  batchId,
  sourceSha256,
  documents: [
    { id: documentIds[0], title: "苍鳞御主｜退婚", sequenceNumber: 1, importOrder: 1 },
    { id: documentIds[1], title: "苍鳞御主｜觉醒", sequenceNumber: 2, importOrder: 2 },
  ],
};

try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "全文事务验收");
  const saved = await saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    state: createImportState(),
    operationDocumentIds: documentIds,
    operationVerification,
  });
  assert.equal(saved.verificationStatus, "passed");
  assert.equal(saved.batchLandingReceipt.verified, true);
  assert.equal(saved.batchLandingReceipt.operationVerification.verified, true);
  assert.equal(saved.batchLandingReceipt.operationVerification.chapterCount, 2);
  assert.deepEqual(saved.batchLandingReceipt.operationVerification.results.map((item) => item.targetDocumentId), documentIds);
  assert.equal(saved.batchLandingReceipt.operationVerification.results.every((item) => item.writtenHash === item.verifiedHash), true);

  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(loaded.state.fullTextImports[batchId].sourceSha256, sourceSha256);
  assert.deepEqual(
    loaded.state.moduleItems.manuscript.map((item) => item[0]).filter((id) => documentIds.includes(id)),
    documentIds,
  );
  assert.equal(loaded.state.documents[documentIds[0]].title, "苍鳞御主｜退婚");
  assert.doesNotMatch(loaded.state.documents[documentIds[0]].markdown, /苍鳞御主/u, "书名不得写入正文内容");

  const invalidWorkspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "缺失历史版本");
  await assert.rejects(
    saveWorkspaceState({
      appRoot,
      requestedPath: invalidWorkspacePath,
      state: createImportState({ includeHistory: false }),
      operationDocumentIds: documentIds,
      operationVerification,
    }),
    /缺少初始历史版本/u,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("full-text atomic landing, title/order/path/hash/readback and initial-history verification tests passed");
