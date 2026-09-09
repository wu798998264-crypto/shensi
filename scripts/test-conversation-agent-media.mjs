import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createConversationMediaExecutor } from "../src/server/conversation-agent-gateway.mjs";
import { createBlankNotebookState } from "../src/data.js";
import { saveWorkspaceState, loadWorkspaceState } from "../src/server/workspace.mjs";
const root = await mkdtemp(join(tmpdir(), "shensi-agent-media-"));
try {
  const workspacePath = join(root, "runtime", "E-drive-data", "笔记", "媒体验收");
  const state = createBlankNotebookState({ name: "媒体验收", workspacePath });
  const conversationId = state.activeConversationId;
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state });
  const calls = [];
  const execute = createConversationMediaExecutor({ appRoot: root, apiRequest: async (path, body) => {
    calls.push({ path, body });
    assert.equal(path, "/api/generation/jobs/media");
    return { ok: true, job: { id: `generation-${body.channel}-test`, channel: body.channel, status: "complete", target: body.target, request: body.request, completedAt: new Date().toISOString(), result: { attachment: { relativePath: `assets/${body.channel}.bin`, name: `${body.channel}.bin`, mimeType: `${body.channel}/${body.channel === "image" ? "png" : "mp4"}`, sha256: "a".repeat(64), width: 2048, height: 1152 } } } };
  } });
  const imageProfile = { id: "image-first", provider: "OpenAI", model: "gpt-image-2", adapter: "api" };
  const videoProfile = { id: "video-first", provider: "即梦", model: "seedance-2.5", adapter: "cli" };
  const request = { workspacePath, workspaceKind: "notebook", conversationId, sourceMessageId: "source-user", mediaProfiles: { image: [imageProfile, { ...imageProfile, id: "image-second" }], video: [videoProfile] } };
  const context = { request, runId: "agent-test", signal: new AbortController().signal };
  await assert.rejects(execute({ channel: "video", prompt: "视频", operationId: "no-duration" }, context), /时长/u);
  assert.equal(calls.length, 0, "缺时长不提交且不阻断补全参数");
  const image = await execute({ channel: "image", prompt: "图片", operationId: "image-one" }, context);
  assert.equal(image.backedUpToAllAssets, true);
  assert.equal(calls[0].body.request.settings.id, "image-first");
  assert.equal(calls[0].body.request.quality, "high");
  await execute({ channel: "video", prompt: "视频", operationId: "video-one", duration: 5 }, context);
  assert.equal(calls[1].body.request.resolution, "720p");
  assert.equal(calls[1].body.request.duration, 5);
  const saved = await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath });
  assert.equal(saved.state.workspaceAssets.length, 2);
  assert.ok(saved.state.workspaceAssets.every((asset) => asset.source === "conversation" && asset.attachment.sha256 === "a".repeat(64)));
  await execute({ channel: "image", prompt: "图片", operationId: "image-one" }, context);
  const reloaded = await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath });
  assert.equal(reloaded.state.workspaceAssets.length, 2, "幂等回填不重复资产");
  let attempts = 0;
  const failure = createConversationMediaExecutor({ appRoot: root, apiRequest: async () => { attempts++; throw new Error("模拟提交后断线"); } });
  await assert.rejects(failure({ channel: "image", prompt: "图片", operationId: "once" }, context));
  await assert.rejects(failure({ channel: "image", prompt: "图片", operationId: "new-id" }, context), /不能盲目/u);
  assert.equal(attempts, 1);
  console.log("Dialogue media: first profile, HD/720p defaults, duration handling, all-assets backup, idempotent landing and no blind resubmission passed (mock only)");
} finally {
  const rel = relative(resolve(tmpdir()), root); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}
