import assert from "node:assert/strict";
import { buildLandingManifest, validateLandingManifest } from "../src/landing-manifest.js";

const port = Number(process.env.SHENSI_TEST_PORT || 5369);
const origin = `http://127.0.0.1:${port}`;
const settingsWorkspace = "E:\\ShensiUserData\\作品\\神思1.1.4真实验收";
const workspacePath = "E:\\ShensiUserData\\作品\\神思1.2.0原生事务验收";
let requestId = `installed-chat-v121-${Date.now()}`;
const targetDocumentId = "prompt-2";
const operationId = "installed-chat-prompt-2";
const instruction = "根据《幻烬》第一章生成完整的 Seedance 视频提示词。直接写入新文档，不要自检。";

const index = await fetch(`${origin}/`).then((response) => response.text());
const sessionToken = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(sessionToken, "installed session token must be present");
const headers = {
  "Content-Type": "application/json",
  Origin: origin,
  "x-shensi-session": sessionToken,
};
const request = async (pathname, body) => {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  return payload;
};
const get = async (pathname) => {
  const response = await fetch(`${origin}${pathname}`, { headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  return payload;
};

const settingsState = await request("/api/workspace/load", { workspacePath: settingsWorkspace });
const targetStateBefore = await request("/api/workspace/load", { workspacePath });
const sourceBefore = targetStateBefore.state.documents["novel-1"];
assert.ok(sourceBefore?.markdown, "source novel must exist before Chat transformation");

const settings = { ...settingsState.state.settings, workspacePath };
const creativeTask = {
  schemaVersion: 1,
  taskId: requestId,
  instruction,
  executionSurface: "chat",
  source: {
    workId: "幻烬",
    documentIds: ["novel-1"],
    contentType: "novel",
    chapter: 1,
  },
  context: {
    associatedDocumentId: "novel-1",
    activeDocumentId: "novel-1",
    referenceDocumentIds: [],
    skillIds: [],
    loadingLevel: 1,
  },
  target: {
    workId: "幻烬",
    contentType: "prompt",
    documentId: targetDocumentId,
    directoryId: "manuscript",
    requestedTitle: "幻烬第一章 Seedance 视频提示词",
    forceCreateNew: true,
    allowMultiple: false,
  },
  operation: "transform",
  qualityPolicy: { selfCheckRequested: false, fullRewriteRequested: false },
};

let chat;
let candidate;
if (targetStateBefore.state.documents[targetDocumentId]) {
  const attempts = await get(`/api/generation/attempts?workspacePath=${encodeURIComponent(workspacePath)}`);
  const attempt = attempts.attempts.find((item) => item.requestId.startsWith("installed-chat-v121-") && item.targetDocumentId === targetDocumentId);
  assert.ok(attempt?.candidate, "an unfinished real Chat candidate must exist for idempotent resume");
  requestId = attempt.requestId;
  creativeTask.taskId = requestId;
  chat = { protocol: attempt.resultData?.payload?.protocol, execution: { creativeTaskState: "ready_to_commit", requiresLandingReceipt: true, modelRuntime: attempt.resultData?.payload?.execution?.modelRuntime } };
  candidate = String(attempt.candidate).trim();
} else chat = await request("/api/agent/execute", {
  settings,
  workspaceKind: "project",
  messages: [{ role: "user", content: instruction }],
  projectContext: `作品：《幻烬》\n来源：小说第一章（novel-1）\n正文：${sourceBefore.markdown}`,
  postwriteProjectContext: "",
  activeModule: "manuscript",
  contextDomain: "novel",
  sourceMode: "original",
  targetDocumentId,
  attachments: [],
  selectedSkills: [],
  explicitReferenceDocumentIds: ["novel-1"],
  requestId,
  creativeTask,
  stream: false,
  mode: "visual_prompt",
  outputSurface: "conversation",
  executionSurface: "chat",
  webSearch: false,
});
assert.equal(chat.execution?.creativeTaskState, "ready_to_commit", "Chat must not claim complete before landing");
assert.equal(chat.execution?.requiresLandingReceipt, true);
candidate ||= String(chat.text || "").replace(/^【(?:正式内容|候选稿)】\s*/u, "").trim();
assert.ok(candidate.length >= 80, "real model must return a substantive prompt document");

const transaction = await request("/api/document-transactions/execute", {
  workspacePath,
  task: creativeTask,
  operations: [{
    operationId,
    type: "create",
    targetDocumentId,
    targetDirectoryId: "manuscript",
    contentType: "prompt",
    requestedTitle: creativeTask.target.requestedTitle,
    content: candidate,
  }],
  commitMode: "atomic",
});
assert.equal(transaction.status, "completed");
assert.equal(transaction.succeeded, 1);
assert.equal(transaction.failed, 0);
assert.equal(transaction.verified, true);
assert.match(transaction.results[0].targetPath, /04_正文[\\/]短剧[\\/]视频提示词/u);

const landingDocument = {
  documentId: targetDocumentId,
  title: creativeTask.target.requestedTitle,
  content: candidate,
  target: { moduleId: "manuscript" },
};
const landingManifest = buildLandingManifest({
  source: candidate,
  documents: [landingDocument],
  workspacePath,
  batchLandingReceipt: transaction,
});
assert.equal(validateLandingManifest(landingManifest, [landingDocument]), true);

const committed = await request(`/api/generation/attempts/${requestId}/commit`, {
  landingManifest,
  projectionReport: { created: 1, updated: 0, failed: 0 },
  failed: false,
});
assert.equal(committed.attempt?.status, "complete");
assert.equal(committed.attempt?.landingStatus, "committed");
assert.equal(committed.attempt?.commitReceipt?.status, "committed");

const targetStateAfter = await request("/api/workspace/load", { workspacePath });
assert.equal(targetStateAfter.state.documents["novel-1"].markdown, sourceBefore.markdown, "source novel must remain unchanged");
assert.ok(targetStateAfter.state.documents[targetDocumentId]?.markdown.includes(candidate.slice(0, 40)), "target must contain latest generated candidate");

console.log(JSON.stringify({
  ok: true,
  version: "1.2.4",
  executionSurface: "chat",
  protocol: chat.protocol,
  modelRuntime: chat.execution?.modelRuntime,
  creativeTaskStateBeforeLanding: chat.execution?.creativeTaskState,
  finalStatus: committed.attempt?.status,
  landingStatus: committed.attempt?.landingStatus,
  receiptVerified: transaction.verified === true,
  sourcePreserved: true,
  targetDocumentId,
  targetPath: transaction.results[0].targetPath,
  candidateCharacters: candidate.length,
}));
