import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createBlankProjectState } from "../src/data.js";

const port = Number(process.env.SHENSI_TEST_PORT || 6806);
const origin = `http://127.0.0.1:${port}`;
const buildId = String(process.env.SHENSI_TEST_BUILD_ID || "unknown");
const acceptanceVersion = String(process.env.SHENSI_TEST_VERSION || "2.5.0");
const workspacePath = `E:\\ShensiUserData\\作品\\v${acceptanceVersion}安装版批量验收-${buildId}`;
const index = await fetch(`${origin}/`).then((response) => response.text());
const sessionToken = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(sessionToken, "installed session token must be present");
const headers = { "content-type": "application/json", origin, "x-shensi-session": sessionToken };
const request = async (path, body) => {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  return payload;
};

const initial = createBlankProjectState(`v${acceptanceVersion}安装版批量验收-${buildId}`);
await request("/api/workspace/save", { workspacePath, state: initial });
const task = (surface, id) => ({
  taskId: id,
  executionSurface: surface,
  operation: "batch",
  source: { documentIds: [] },
  target: { workId: `v${acceptanceVersion}安装版批量验收-${buildId}` },
});
const operations = (prefix, count) => Array.from({ length: count }, (_, index) => ({
  operationId: `${buildId}-${prefix}-${index + 1}`,
  type: "create",
  targetDocumentId: `${prefix}-document-${index + 1}`,
  targetDirectoryId: "manuscript",
  contentType: prefix === "agent" ? "script" : "novel",
  requestedTitle: `${prefix.toUpperCase()} 文档 ${index + 1}`,
  content: `${prefix} 安装版正式正文 ${index + 1}\n\nBuild ${buildId}`,
}));

const summaries = [];
for (const surface of ["chat", "agent"]) {
  const items = operations(surface, 5);
  const receipt = await request("/api/document-transactions/execute", {
    workspacePath,
    requestId: `${buildId}-${surface}-five`,
    batchId: `${buildId}-${surface}-five`,
    task: task(surface, `${surface}-five`),
    operations: items,
    commitMode: "atomic",
  });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.succeeded, 5);
  assert.equal(receipt.results.every((item) => item.navigationTarget?.documentId === item.targetDocumentId), true);
  summaries.push({ case: `${surface}-5`, succeeded: receipt.succeeded, verified: receipt.verified });
}

const beforeMixed = await request("/api/workspace/load", { workspacePath });
const oldContent = beforeMixed.state.documents["chat-document-1"].markdown;
const mixed = await request("/api/document-transactions/execute", {
  workspacePath,
  requestId: `${buildId}-mixed`,
  batchId: `${buildId}-mixed`,
  task: task("chat", "mixed"),
  operations: [
    { operationId: `${buildId}-mixed-new`, type: "create", targetDocumentId: "mixed-new", targetDirectoryId: "manuscript", requestedTitle: "混合新建", content: "混合新建正文" },
    { operationId: `${buildId}-mixed-update`, type: "append", targetDocumentId: "chat-document-1", content: "用户最新版后的局部补充" },
  ],
  commitMode: "atomic",
});
assert.equal(mixed.succeeded, 2);
assert.ok(mixed.results.find((item) => item.targetDocumentId === "chat-document-1")?.versionId);

const stressItems = operations("stress", 20);
const startedAt = performance.now();
const stress = await request("/api/document-transactions/execute", {
  workspacePath,
  requestId: `${buildId}-stress`,
  batchId: `${buildId}-stress`,
  task: task("agent", "stress"),
  operations: stressItems,
  commitMode: "atomic",
});
const elapsedMs = performance.now() - startedAt;
assert.equal(stress.succeeded, 20);
assert.equal(stress.verified, true);
assert.ok(elapsedMs <= 15_000, `installed 20-document transaction took ${elapsedMs.toFixed(1)}ms`);

const finalState = await request("/api/workspace/load", { workspacePath });
assert.equal(finalState.state.documents["chat-document-1"].markdown, `${oldContent}\n\n用户最新版后的局部补充`);
assert.equal(stressItems.every((item) => finalState.state.documents[item.targetDocumentId]?.markdown === item.content), true);
assert.equal(stress.results.every((item) => item.navigationTarget?.documentId === item.targetDocumentId), true);

console.log(JSON.stringify({
  ok: true,
  version: acceptanceVersion,
  buildId,
  workspacePath,
  cases: [...summaries, { case: "mixed-create-update", succeeded: mixed.succeeded, verified: mixed.verified }, { case: "stress-20", succeeded: stress.succeeded, verified: stress.verified }],
  stressElapsedMs: Number(elapsedMs.toFixed(1)),
  finalDocuments: Object.keys(finalState.state.documents).length,
}, null, 2));
