import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-domain-api-"));
process.env.SHENSI_DATA_ROOT = dataRoot;
process.env.SHENSI_MACHINE_DATA_ROOT = join(dataRoot, "machine");

const [{ createConversationAgentApi }, { createMediaGenerationApi }] = await Promise.all([
  import(`../src/domains/document/conversation-agent-api.mjs?test=${Date.now()}`),
  import(`../src/domains/media/media-generation-api.mjs?test=${Date.now()}`),
]);

const responseRecorder = () => ({ status: 0, payload: null });
const sendJson = (response, status, payload) => {
  response.status = status;
  response.payload = payload;
};
const requestError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

try {
  const calls = [];
  const gateway = {
    start: async (body) => (calls.push(["start", body]), { id: "agent-00000000-0000-0000-0000-000000000001" }),
    status: async (id, after) => (calls.push(["status", id, after]), { id, status: "running", events: [] }),
    answer: async (id, decisionId, answer) => (calls.push(["answer", id, decisionId, answer]), { accepted: true }),
    supplement: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
  };
  const conversationApi = createConversationAgentApi({
    appRoot: dataRoot,
    gateway,
    readJsonBody: async (request) => request.body,
    resolveWorkspaceRoot: ({ requestedPath }) => resolve(requestedPath),
    sendJson,
    requestError,
  });
  const startResponse = responseRecorder();
  assert.equal(await conversationApi({
    pathname: "/api/conversation-agent/start",
    request: { method: "POST", body: { workspacePath: dataRoot, messages: [{ role: "user", content: "写一份正式文档" }] } },
    response: startResponse,
  }), true);
  assert.equal(startResponse.status, 202);
  assert.equal(calls[0][0], "start");
  await assert.rejects(() => conversationApi({
    pathname: "/api/conversation-agent/start",
    request: { method: "POST", body: { outputSurface: "whiteboard", messages: [{ role: "user", content: "跨域任务" }] } },
    response: responseRecorder(),
  }), (error) => error?.statusCode === 422);

  const mediaApi = createMediaGenerationApi({
    appRoot: dataRoot,
    mediaReplacementOwnerToken: "test-owner",
    readJsonBody: async (request) => request.body || {},
    sendJson,
  });
  const createdResponse = responseRecorder();
  assert.equal(await mediaApi({
    pathname: "/api/generation/jobs/client",
    request: {
      method: "POST",
      body: {
        channel: "text",
        target: { workspacePath: dataRoot, documentId: "document-one", nodeId: "task-one" },
        request: { prompt: "文档域不得进入媒体供应商" },
      },
    },
    requestUrl: new URL("http://localhost/api/generation/jobs/client"),
    response: createdResponse,
  }), true);
  assert.equal(createdResponse.status, 201);
  assert.match(createdResponse.payload.job.id, /^generation-/u);
  const failedResponse = responseRecorder();
  assert.equal(await mediaApi({
    pathname: `/api/generation/jobs/${createdResponse.payload.job.id}/fail`,
    request: { method: "POST", body: { message: "测试失败回执", retryRequired: false } },
    requestUrl: new URL("http://localhost/fail"),
    response: failedResponse,
  }), true);
  assert.equal(failedResponse.payload.job.status, "failed");
  assert.equal(await mediaApi({
    pathname: "/api/workspace/load",
    request: { method: "POST", body: {} },
    requestUrl: new URL("http://localhost/api/workspace/load"),
    response: responseRecorder(),
  }), false, "媒体域不得截获文档工作区 API");

  console.log("Document and media domain API dispatch checks passed");
} finally {
  const resolved = resolve(dataRoot);
  const rel = relative(resolve(tmpdir()), resolved);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(resolved, { recursive: true, force: true });
}
