import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const port = Number(process.env.SHENSI_TEST_PORT || 6806);
const buildId = String(process.env.SHENSI_TEST_BUILD_ID || "unknown");
const acceptanceVersion = String(process.env.SHENSI_TEST_VERSION || "2.5.0");
const origin = `http://127.0.0.1:${port}`;
const acceptanceWorkspace = `E:\\ShensiUserData\\作品\\v${acceptanceVersion}安装版批量验收-${buildId}`;
const recovery = JSON.parse(await readFile("E:/ShensiUserData/generation-attempts/run-1786264961851-qzypj.json", "utf8"));
const settingsWorkspace = recovery.requestSnapshot.workspacePath;
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
const settingsState = await request("/api/workspace/load", { workspacePath: settingsWorkspace });
const settings = { ...settingsState.state.settings, workspacePath: acceptanceWorkspace };
const parseFive = (value) => {
  const text = String(value || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`real model did not return a JSON array: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  assert.equal(parsed.length, 5, "real model must generate exactly five documents");
  return parsed.map((item, index) => ({
    title: String(item.title || "").trim() || `Real Model Document ${index + 1}`,
    body: String(item.body || "").trim(),
  }));
};

const results = [];
for (const surface of ["chat", "agent"]) {
  const requestId = `installed-v124-real-${surface}-${buildId}`;
  const existingState = await request("/api/workspace/load", { workspacePath: acceptanceWorkspace });
  const existingIds = Array.from({ length: 5 }, (_, index) => `real-${surface}-${index + 1}`);
  if (existingIds.every((id) => existingState.state.documents[id]?.markdown)) {
    results.push({ surface, protocol: "persisted-real-model-result", succeeded: 5, verified: true, characters: existingIds.reduce((sum, id) => sum + existingState.state.documents[id].markdown.length, 0), idempotentReplay: true });
    continue;
  }
  const prompt = [
    "Create exactly five independent short creative-production documents for an acceptance test.",
    `Every title must start with ${surface.toUpperCase()}-${buildId}- and end in a number from 1 to 5.`,
    "Each body must contain at least 80 characters of substantive prose and must be different.",
    "Return JSON only: [{\"title\":\"...\",\"body\":\"...\"}]. Do not use a Markdown code fence.",
  ].join("\n");
  const creativeTask = {
    schemaVersion: 1,
    taskId: requestId,
    instruction: prompt,
    executionSurface: surface,
    source: { workId: `v${acceptanceVersion}安装版批量验收-${buildId}`, documentIds: [], contentType: "general" },
    context: { associatedDocumentId: "", activeDocumentId: "", referenceDocumentIds: [], skillIds: [], loadingLevel: 1 },
    target: { workId: `v${acceptanceVersion}安装版批量验收-${buildId}`, contentType: "document", directoryId: "library", forceCreateNew: true, allowMultiple: true },
    operation: "batch",
    qualityPolicy: { selfCheckRequested: false, fullRewriteRequested: false },
  };
  const invokeModel = (messages, activeRequestId) => request("/api/agent/execute", {
    settings,
    workspaceKind: "project",
    messages,
    projectContext: `Installed v${acceptanceVersion} batch acceptance workspace. Build ${buildId}.`,
    postwriteProjectContext: "",
    activeModule: "library",
    contextDomain: "general",
    sourceMode: "original",
    targetDocumentId: "",
    attachments: [],
    selectedSkills: [],
    explicitReferenceDocumentIds: [],
    requestId: activeRequestId,
    creativeTask: { ...creativeTask, taskId: activeRequestId },
    stream: false,
    mode: "general",
    outputSurface: "conversation",
    executionSurface: surface,
    webSearch: false,
  });
  let response = await invokeModel([{ role: "user", content: prompt }], requestId);
  let documents = parseFive(response.text);
  for (let retry = 1; retry <= 2 && documents.some((item) => item.body.length < 80); retry += 1) {
    const repairPrompt = `Expand every body below to at least 160 characters while retaining all five titles. Return JSON only, with no Markdown fence.\n${JSON.stringify(documents)}`;
    response = await invokeModel([{ role: "user", content: repairPrompt }], `${requestId}-repair-${retry}`);
    documents = parseFive(response.text);
  }
  assert.equal(documents.every((item) => item.body.length >= 80), true, `${surface} real model bodies must be substantive`);
  const operations = documents.map((item, index) => ({
    operationId: `${requestId}-op-${index + 1}`,
    type: "create",
    targetDocumentId: `real-${surface}-${index + 1}`,
    targetDirectoryId: "library",
    contentType: "document",
    requestedTitle: item.title,
    content: item.body,
  }));
  const receipt = await request("/api/document-transactions/execute", {
    workspacePath: acceptanceWorkspace,
    requestId,
    batchId: `${requestId}-batch`,
    task: creativeTask,
    operations,
    commitMode: "atomic",
  });
  assert.equal(receipt.succeeded, 5);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.results.every((item) => item.navigationTarget?.documentId === item.targetDocumentId), true);
  const after = await request("/api/workspace/load", { workspacePath: acceptanceWorkspace });
  assert.equal(operations.every((item) => after.state.documents[item.targetDocumentId]?.markdown === item.content), true);
  results.push({ surface, protocol: response.protocol, succeeded: receipt.succeeded, verified: receipt.verified, characters: documents.reduce((sum, item) => sum + item.body.length, 0) });
}

console.log(JSON.stringify({ ok: true, version: acceptanceVersion, buildId, results }, null, 2));
