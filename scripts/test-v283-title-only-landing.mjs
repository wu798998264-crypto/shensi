import assert from "node:assert/strict";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { bindFormalWriteCandidate, validateFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { extractFormalArtifacts } from "../src/formal-artifact-extractor.js";
import {
  beginDocumentWriteTransaction,
  commitDocumentWriteTransaction,
} from "../src/document-write-transaction.js";
import { readFile } from "node:fs/promises";

const target = {
  documentId: "chapter-8",
  revision: "revision-8",
  title: "未命名",
  chapterNumber: 8,
  explicitChapter: true,
};

const route = buildAdaptiveTaskRoute({
  text: "请给当前文档起一个标题，不要修改正文",
  sourceMessageId: "title-request-1",
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}, { executionSurface: "chat" });

assert.equal(route.taskPolicy.action, "modify");
assert.equal(route.mode, "quick_revision");
assert.equal(route.shensiLed, true);
assert.equal(route.candidatePreviewRequired, false, "单独标题落盘不需要候选窗口");
assert.equal(route.formalArtifactExpected, true);
assert.equal(route.writeAuthorization.state, "commit");
assert.equal(route.writeAuthorization.action, "rename");
assert.equal(route.writeAuthorization.allowTitleMutation, true);
assert.equal(route.writeAuthorization.allowBodyMutation, false);
assert.equal(validateFormalWriteAuthorization(route.writeAuthorization, {
  requiredState: "commit",
  requireTitleMutation: true,
  sourceMessageId: "title-request-1",
  instruction: "请给当前文档起一个标题，不要修改正文",
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}).valid, true);
assert.equal(validateFormalWriteAuthorization(route.writeAuthorization, {
  requiredState: "commit",
  requireBodyMutation: true,
  sourceMessageId: "title-request-1",
  instruction: "请给当前文档起一个标题，不要修改正文",
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
}).valid, false);

const structured = extractFormalArtifacts({
  response: JSON.stringify({
    title: "影渠",
    targetDocumentId: "chapter-8",
    operation: "rename",
  }),
  instruction: "请给当前文档起一个标题，不要修改正文",
  target,
  writeAuthorization: route.writeAuthorization,
});
assert.equal(structured.artifacts.length, 1);
assert.equal(structured.artifacts[0].title, "影渠");
assert.equal(structured.artifacts[0].content, "");
assert.equal(structured.artifacts[0].operation, "rename");

const before = {
  id: "chapter-8",
  title: "未命名",
  html: "<p>西道上的两道车辙，在第二处积水前交织了深浅。</p>",
  revision: "revision-8",
  moduleId: "manuscript",
};
const titleAuthorization = await bindFormalWriteCandidate(route.writeAuthorization, {
  candidate: "影渠",
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
});
const transaction = await beginDocumentWriteTransaction({
  transactionId: "rename-transaction-1",
  documentId: before.id,
  documentState: before,
  operation: "rename",
  candidateContent: "影渠",
  authorizationCandidate: "影渠",
  expectedRevision: before.revision,
  writeAuthorization: titleAuthorization,
  sourceMessageId: "title-request-1",
  sourceInstruction: "请给当前文档起一个标题，不要修改正文",
});
const receipt = await commitDocumentWriteTransaction({
  transaction,
  nextDocument: { ...before, title: "影渠" },
});
assert.equal(receipt.verified, true);
assert.equal(transaction.snapshot, undefined, "改标题预检不应生成写入前可见历史快照");
assert.equal(transaction.beforeDocument.html, before.html, "事务回滚副本必须保留原正文");
assert.equal(transaction.beforeBody, before.html);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /forceDocumentVersions:\s*titleOnlyWrite/u, "单独落盘标题必须强制保存独立历史版本，不能因正文相同而去重");
assert.match(appSource, /神思标题写入后的完整文档/u);

console.log("Title-only formal landing tests passed");
