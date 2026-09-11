import assert from "node:assert/strict";

import {
  beginDocumentWriteBatch,
  beginDocumentWriteTransaction,
  commitDocumentWriteBatch,
  commitDocumentWriteTransaction,
} from "../src/document-write-transaction.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { bindFormalWriteCandidate } from "../src/formal-write-authorization.js";
import { documentVersionHash, verifyDocumentVersionSnapshot } from "../src/version-integrity.js";
import { generatedLandingHistoryPlan } from "../src/generated-landing-history.js";

const authorizationFor = async ({ instruction, sourceMessageId, target, candidate, action }) => {
  const route = buildAdaptiveTaskRoute({
    text: instruction,
    sourceMessageId,
    target,
    targetDocumentId: target.documentId,
    targetDocumentIds: [target.documentId],
    expectedRevisions: { [target.documentId]: target.revision },
    inlineEdit: action === "patch",
    hasSelection: action === "patch",
  }, { executionSurface: "agent" });
  return bindFormalWriteCandidate(route.writeAuthorization, {
    candidate,
    targetDocumentIds: [target.documentId],
    expectedRevisions: { [target.documentId]: target.revision },
  });
};

const blank = { title: "第8章 未命名", html: "<p><br></p>", markdown: "", revision: "revision-8", moduleId: "manuscript" };
const blankCandidate = "第8章 渠底暗门\n\n水声从石壁后传来，牧尘停在第七道刻痕前。";
const blankAuthorization = await authorizationFor({
  instruction: "生成第八章并落盘",
  sourceMessageId: "user-create-8",
  target: { documentId: "chapter-8", revision: blank.revision },
  candidate: blankCandidate,
});
const blankTransaction = await beginDocumentWriteTransaction({
  transactionId: "tx-blank",
  documentId: "chapter-8",
  documentState: blank,
  operation: "replace",
  candidateContent: blankCandidate,
  expectedDocumentHash: await documentVersionHash(blank),
  expectedRevision: blank.revision,
  writeAuthorization: blankAuthorization,
  sourceMessageId: "user-create-8",
  sourceInstruction: "生成第八章并落盘",
});
assert.equal(blankTransaction.snapshot.document.html, blank.html, "空白占位文档写入前也必须保存完整历史快照");
assert.equal(blankTransaction.snapshot.document.title, blank.title);
assert.equal((await verifyDocumentVersionSnapshot(blankTransaction.snapshot)).ok, true);
assert.equal(blankTransaction.baseline.kind, "blank_document_baseline");
assert.equal(blankTransaction.baseline.documentId, "chapter-8");
assert.deepEqual(generatedLandingHistoryPlan({
  landings: [{ documentId: "chapter-8" }],
  documents: { "chapter-8": blank },
}), { contentSnapshotDocumentIds: [], blankBaselineDocumentIds: ["chapter-8"] });

const original = {
  title: "第6章 北灵院",
  html: "<p>原文第一段。</p><p>原文第二段。</p>",
  markdown: "原文第一段。\n\n原文第二段。",
  revision: "revision-6",
  moduleId: "manuscript",
};
const candidate = "续写第三段。";
const authorization = await authorizationFor({
  instruction: "续写当前章节",
  sourceMessageId: "user-append",
  target: { documentId: "chapter-6", revision: original.revision },
  candidate,
});
const transaction = await beginDocumentWriteTransaction({
  transactionId: "tx-nonempty",
  documentId: "chapter-6",
  documentState: original,
  operation: "continuation",
  candidateContent: candidate,
  expectedDocumentHash: await documentVersionHash(original),
  expectedRevision: original.revision,
  writeAuthorization: authorization,
  sourceMessageId: "user-append",
  sourceInstruction: "续写当前章节",
});
assert.equal(transaction.snapshot.document.html, original.html, "写入前历史正文必须与原文逐字一致");
assert.equal(transaction.snapshot.document.title, original.title);
assert.equal((await verifyDocumentVersionSnapshot(transaction.snapshot)).ok, true);

const appended = { ...original, html: `${original.html}<p>${candidate}</p>`, revision: "revision-7" };
assert.equal((await commitDocumentWriteTransaction({ transaction, nextDocument: appended })).verified, true);

await assert.rejects(() => beginDocumentWriteTransaction({
  documentId: "chapter-6",
  documentState: original,
  operation: "continuation",
  candidateContent: candidate,
  expectedRevision: "stale-revision",
  writeAuthorization: authorization,
  sourceMessageId: "user-append",
  sourceInstruction: "续写当前章节",
}), (error) => error.code === "DOCUMENT_TRANSACTION_REVISION_CONFLICT");

const second = { ...original, title: "第7章 北灵台", revision: "revision-7" };
const secondCandidate = "替换后的第七章正文。";
const secondAuthorization = await authorizationFor({
  instruction: "直接改写选区",
  sourceMessageId: "user-batch",
  target: { documentId: "chapter-7", revision: second.revision },
  candidate: secondCandidate,
  action: "patch",
});
await assert.rejects(() => beginDocumentWriteBatch({
  transactionId: "tx-batch-invalid",
  writes: [
    {
      documentId: "chapter-6",
      documentState: original,
      operation: "continuation",
      candidateContent: candidate,
      expectedRevision: original.revision,
      writeAuthorization: authorization,
      sourceMessageId: "user-append",
      sourceInstruction: "续写当前章节",
    },
    {
      documentId: "chapter-7",
      documentState: second,
      operation: "partial-replace",
      candidateContent: "",
      expectedRevision: second.revision,
      writeAuthorization: secondAuthorization,
      sourceMessageId: "user-batch",
      sourceInstruction: "直接改写选区",
    },
  ],
}), (error) => error.code === "DOCUMENT_TRANSACTION_EMPTY_CANDIDATE");
assert.equal(original.html, "<p>原文第一段。</p><p>原文第二段。</p>");
assert.equal(second.html, original.html, "批量预检失败不得修改任何目标");

const preparedBatch = await beginDocumentWriteBatch({
  transactionId: "tx-batch-ok",
  writes: [{
    documentId: "chapter-7",
    documentState: second,
    operation: "partial-replace",
    candidateContent: secondCandidate,
    expectedRevision: second.revision,
    writeAuthorization: secondAuthorization,
    sourceMessageId: "user-batch",
    sourceInstruction: "直接改写选区",
  }],
});
const batchReceipt = await commitDocumentWriteBatch({
  batch: preparedBatch,
  results: [{ documentId: "chapter-7", nextDocument: { ...second, html: `<p>${secondCandidate}</p>`, revision: "revision-8" } }],
});
assert.equal(batchReceipt.verified, true);
assert.equal(batchReceipt.receipts.length, 1);

console.log("Shensi v2.83 history baseline tests passed");
