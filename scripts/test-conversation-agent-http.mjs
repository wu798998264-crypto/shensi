import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createBlankNotebookState } from "../src/data.js";
const dataRoot = await mkdtemp(join(tmpdir(), "shensi-agent-http-"));
const port = 41996, origin = `http://127.0.0.1:${port}`;
let child, stderr = "", modelCalls = 0;
const upstream = createServer(async (request, response) => {
  let body = ""; for await (const part of request) body += part;
  const input = JSON.parse(body); modelCalls++;
  assert.equal(input.model, "mock-agent-model");
  const output = modelCalls === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "call-create", type: "function", function: { name: "documents_write", arguments: JSON.stringify({ operation: "create", documentId: "agent-created", title: "Agent输出", moduleId: "library", content: "通过真实内置Agent和文档工具生成的验证内容。", operationId: "write-one" }) } }] }
    : { role: "assistant", content: "HTTP_NATIVE_AGENT_OK" };
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: output }] }));
});
try {
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  child = spawn(process.execPath, ["server.mjs", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, SHENSI_DATA_ROOT: dataRoot, SHENSI_MACHINE_DATA_ROOT: join(dataRoot, "machine"), SHENSI_SKIP_UPDATE_CHECK: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  let token = "";
  for (let i = 0; i < 200 && !token; i++) {
    try { const html = await (await fetch(origin)).text(); token = html.match(/name="shensi-session-token" content="([^"]+)"/)?.[1] || ""; } catch {}
    if (!token) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(token, stderr);
  const headers = { "content-type": "application/json", "x-shensi-session": token };
  const api = async (path, body) => {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json(); assert.ok(response.ok && payload.ok, payload.message); return payload;
  };
  const workspacePath = join(dataRoot, "笔记", "HTTP验收");
  const state = createBlankNotebookState({ name: "HTTP验收", workspacePath });
  await api("/api/workspace/save", { workspacePath, state });
  const request = { workspacePath, workspaceKind: "notebook", conversationId: state.activeConversationId, sourceMessageId: "user-native-http-1", messages: [{ role: "user", content: "在资料库新建一份文档" }], settings: { id: "mock-profile", connectionId: "mock-profile", provider: "自定义兼容接口", adapter: "api", protocol: "chat_completions", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: "mock-agent-model", agentModelId: "mock-agent-model", apiKey: "mock-key", agentEngine: "codex_api" }, mediaProfiles: {} };
  const started = await api("/api/conversation-agent/start", request);
  let status;
  for (let i = 0; i < 300; i++) {
    status = await api(`/api/conversation-agent/${started.id}`);
    if (["completed", "failed", "interrupted"].includes(status.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(status.status, "completed", status.error);
  assert.equal(status.text, "HTTP_NATIVE_AGENT_OK");
  assert.equal(modelCalls, 2);
  const savedEvent = status.events.find((item) => item.type === "document_saved");
  assert.ok(savedEvent, "原生 Agent 文档工具必须发出 document_saved 回执");
  assert.equal(savedEvent.payload.trustedDocumentSave, true, "只有完整磁盘验收回执才能标记为可信落盘");
  assert.equal(savedEvent.payload.landingManifest?.nativeAgentDocumentSave, true);
  assert.equal(savedEvent.payload.landingManifest?.segments?.[0]?.title, "Agent输出");
  assert.equal(savedEvent.payload.landingManifest?.segments?.[0]?.navigationTarget?.documentId, "agent-created");
  assert.equal(savedEvent.payload.landingManifest?.workspacePath, workspacePath);
  const duplicate = await api("/api/conversation-agent/start", request);
  assert.equal(duplicate.id, started.id); assert.equal(duplicate.reused, true);
  const loaded = await api("/api/workspace/load", { workspacePath });
  assert.match(loaded.state.documents["agent-created"].markdown, /真实内置Agent/u);
  const retired = await fetch(origin + "/api/chat", { method: "POST", headers, body: JSON.stringify({ messages: request.messages }) });
  assert.equal(retired.status, 410);
  console.log("HTTP end-to-end: original task -> bundled Codex -> mock upstream -> protected document transaction -> durable status; duplicate start and retired Chat endpoint passed");
} finally {
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise((done) => setTimeout(done, 2000))]); }
  upstream.closeAllConnections(); await new Promise((done) => upstream.close(done));
  const rel = relative(resolve(tmpdir()), dataRoot); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
