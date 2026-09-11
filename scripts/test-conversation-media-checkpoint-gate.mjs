import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createBlankNotebookState } from "../src/data.js";
import { createConversationMediaExecutor } from "../src/server/conversation-agent-gateway.mjs";
import { saveWorkspaceState } from "../src/server/workspace.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-agent-media-cancel-"));
try {
  const workspacePath = join(root, "runtime", "E-drive-data", "笔记", "媒体终止验收");
  const state = createBlankNotebookState({ name: "媒体终止验收", workspacePath });
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state });

  const calls = [];
  const executor = createConversationMediaExecutor({
    appRoot: root,
    apiRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/api/generation/jobs/media") {
        return { ok: true, job: { id: "generation-cancel-test", status: "running", channel: "image" } };
      }
      if (path === "/api/generation/jobs/generation-cancel-test/cancel") {
        return { ok: true, job: { id: "generation-cancel-test", status: "cancel_requested" } };
      }
      throw new Error(`不应继续轮询或新建任务：${path}`);
    },
  });
  const controller = new AbortController();
  const request = {
    workspacePath,
    workspaceKind: "notebook",
    conversationId: state.activeConversationId,
    sourceMessageId: "media-cancel-source",
    mediaProfiles: {
      image: [{ id: "image-default", provider: "自定义兼容接口", adapter: "api", model: "image-model" }],
      video: [],
    },
  };
  const execution = executor({
    channel: "image",
    prompt: "终止能力验收图片",
    operationId: "cancel-once",
  }, {
    request,
    runId: "agent-media-cancel",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(execution, /媒体任务 generation-cancel-test 保留，未重新提交/u);

  assert.equal(calls.filter((call) => call.path === "/api/generation/jobs/media").length, 1,
    "用户终止后不得新建或重复提交厂商任务");
  assert.equal(calls.filter((call) => call.path.endsWith("/cancel")).length, 1,
    "用户终止必须请求取消原持久化媒体任务");

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const executeStart = app.indexOf("const executeConversationAgentMessage = async");
  const executeEnd = app.indexOf("const sendMessage = async", executeStart);
  const executeSource = app.slice(executeStart, executeEnd);
  assert.match(executeSource, /await onPersist\(\);[\s\S]{0,180}conversationAgentRequest\("\/api\/conversation-agent\/start"/u,
    "对话先保存任务记录，再由 Agent 接管；媒体提交不依赖旧的专用检查点门禁");
  assert.doesNotMatch(executeSource, /recovery\/checkpoint|generation\/jobs\/media/u,
    "前端统一 Agent 入口不得直接执行媒体提交或用媒体关键词门禁阻断");

  console.log("Conversation media cancellation keeps the original job, sends one cancel, and never resubmits");
} finally {
  const resolved = resolve(root);
  const rel = relative(resolve(tmpdir()), resolved);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(resolved, { recursive: true, force: true });
}
