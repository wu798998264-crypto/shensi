import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileWorkspaceSave } from "../src/conversation-save-reconciliation.js";
import { rebaseWorkspaceConflict, workspaceDocumentHashes, workspaceStateHashes } from "../src/workspace-conflict.js";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(app, /elements\.whiteboardFullscreenButton\.hidden = false/u,
  "阅读模式必须保留文档全屏按钮");
assert.match(app, /const preview = elements\.editorCanvas\?\.classList\.contains\("document-preview-mode"\)/u,
  "全屏按钮文案必须跟随阅读/编辑模式");

const execution = app.slice(app.indexOf("const executeConversationAgentMessage = async"), app.indexOf("const sendMessage = async"));
assert.match(execution, /const hasUnsavedDocumentWork = ui\.workspaceDocumentChangesUnknown[\s\S]{0,260}ui\.workspaceDirtyDocumentIds\.size > 0/u,
  "对话启动只应等待真实文档改动，不应等待对话状态保存");
assert.doesNotMatch(execution, /&& \(ui\.workspaceDirty \|\| ui\.workspaceSavePromise\)/u,
  "对话状态冲突不得继续作为所有新任务的启动门禁");

const send = app.slice(app.indexOf("const sendMessage = async"), app.indexOf("const selectedChatMessageText ="));
assert.match(send, /persistWorkspaceStateOnly\(\{ saveDelay: 180 \}\)/u,
  "对话卡片与消息必须使用状态保存，不得伪装成正文改动");
assert.match(send, /agentTaskRuntimeMatchesSnapshot\(taskRuntimeCandidate, submittedTaskContextSnapshot\)/u,
  "新对话或新工作区不得复用旧运行时");
assert.match(app, /agentTaskRuntimeMatchesSnapshot\(existingRuntimeCandidate, submittedTaskContextSnapshot\)/u,
  "原生 Agent 启动必须校验运行时所属工作区");
assert.match(app, /fetchWorkspacePayload\(workspacePath, "\/api\/workspace\/load", \{ fresh: true \}\)/u,
  "冲突恢复必须绕过缓存并读取最新磁盘状态");

for (const marker of [
  "const deleteCustomFolder = async",
  "const deleteTreeFolder = async",
  "const deleteManuscriptVolume = async",
  "const deleteDocument = async",
]) {
  const start = app.indexOf(marker);
  const end = app.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, `缺少删除函数：${marker}`);
  const body = app.slice(start, end);
  assert.match(body, /preserveStateKeys: CONVERSATION_SAVE_KEYS/u,
    `${marker} 必须隔离并发对话状态`);
}

const baseline = {
  activeConversationId: "conversation-a",
  messages: [{ id: "a-1", role: "user", content: "旧指令" }],
  conversations: [{ id: "conversation-a", messages: [{ id: "a-1", role: "user", content: "旧指令" }] }],
  documents: { "doc-1": { title: "待删除", html: "旧内容" } },
};
const current = {
  ...baseline,
  documents: {},
  messages: [{ id: "a-1", role: "user", content: "旧指令" }, { id: "a-2", role: "assistant", content: "后台任务" }],
  conversations: [{ id: "conversation-a", messages: [{ id: "a-1", role: "user", content: "旧指令" }, { id: "a-2", role: "assistant", content: "后台任务" }] }],
};
const persisted = {
  ...baseline,
  messages: [{ id: "a-1", role: "user", content: "旧指令" }, { id: "a-3", role: "assistant", content: "新对话进度" }],
  conversations: [{ id: "conversation-a", messages: [{ id: "a-1", role: "user", content: "旧指令" }, { id: "a-3", role: "assistant", content: "新对话进度" }] }],
};
const preserved = Object.fromEntries(["conversations", "messages", "activeConversationId"].map((key) => [key, persisted[key]]));
const rebasePlan = rebaseWorkspaceConflict({
  baselineDocumentHashes: workspaceDocumentHashes(baseline.documents),
  baselineStateHashes: workspaceStateHashes(baseline),
  localState: current,
  remoteState: persisted,
  stateConflictResolutions: preserved,
});
assert.equal(rebasePlan.ok, true, "删除文档不应被无关对话状态冲突阻断");
assert.equal(Object.hasOwn(rebasePlan.state.documents, "doc-1"), false, "文档删除变更必须保留");
const rebased = reconcileWorkspaceSave({ current: rebasePlan.state, submitted: rebasePlan.state, persisted, stateConflictResolutions: preserved });
assert.equal(rebased.ok, true, "删除文档不应被无关对话状态冲突阻断");
assert.deepEqual(rebased.state.messages, persisted.messages, "删除提交必须保留最新对话消息");

console.log("conversation isolation and read fullscreen contracts passed");
