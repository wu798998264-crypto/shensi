import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createBlankNotebookState } from "../src/data.js";
import { verifiedLandingDocumentLinksForManifest } from "../src/landing-document-links.js";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-native-agent-link-"));
try {
  const workspacePath = join(root, "runtime", "E-drive-data", "笔记", "链接验收");
  await saveWorkspaceState({
    appRoot: root,
    requestedPath: workspacePath,
    state: createBlankNotebookState({ name: "链接验收" }),
  });
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => [],
    readRoute: async () => ({ text: "按任务语义执行", sources: [] }),
    run: async ({ workspaceToolRuntime }) => {
      await workspaceToolRuntime.invoke({
        namespace: "interaction",
        tool: "delivery",
        arguments: { mode: "documents", documentIds: ["agent-article"] },
      });
      const written = await workspaceToolRuntime.invoke({
        namespace: "documents",
        tool: "write",
        arguments: {
          operation: "create",
          documentId: "agent-article",
          title: "真实标题文章",
          moduleId: "library",
          content: "# 真实标题文章\n\n这是 Agent 正式落盘的正文。",
          operationId: "create-agent-article",
        },
      });
      assert.equal(written.success, true, written.contentItems[0].text);
      return { text: "文章已完成并写入。" };
    },
  });
  const started = await service.start({
    workspacePath,
    workspaceKind: "notebook",
    workspaceName: "链接验收",
    conversationId: "conversation-link",
    sourceMessageId: "message-link",
    messages: [{ role: "user", content: "创作一篇正式文章并自动写入，标题叫真实标题文章。" }],
    settings: { id: "mock", agentEngine: "codex_api", model: "mock", agentPermissionMode: "shensi_only" },
  });
  let status;
  for (let index = 0; index < 200; index += 1) {
    status = await service.status(started.id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.status)) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(status.status, "completed", status.error);
  const savedEvent = status.events.find((event) => event.type === "document_saved");
  assert.equal(savedEvent?.payload?.trustedDocumentSave, true, "只有回读验收通过的真实写入才能生成链接");
  const loaded = await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath });
  assert.equal(loaded.state.documents["agent-article"].title, "真实标题文章", "正式标题必须替换占位标题");
  const links = verifiedLandingDocumentLinksForManifest({
    manifest: savedEvent.payload.landingManifest,
    documents: loaded.state.documents,
  });
  assert.deepEqual(links.map(({ documentId, title, workspaceKind, workspaceName }) => ({ documentId, title, workspaceKind, workspaceName })), [{
    documentId: "agent-article",
    title: "真实标题文章",
    workspaceKind: "notebook",
    workspaceName: "链接验收",
  }]);
  console.log("Native Agent write receipt -> title link contract passed");
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}
