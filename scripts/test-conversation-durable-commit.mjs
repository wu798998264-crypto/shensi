import assert from "node:assert/strict";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankNotebookState } from "../src/data.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { workspaceConversationEntries } from "../src/server/workspace-conversations.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-conversation-durable-"));
const appRoot = join(root, "app");
const workspacePath = join(appRoot, "runtime", "E-drive-data", "笔记", "对话断电验收");
const base = createBlankNotebookState({ name: "对话断电验收" });
base.conversations = [
  { id: "conversation-old", title: "旧对话", messages: [{ id: "old-message", role: "user", content: "旧内容" }] },
];
base.activeConversationId = "conversation-old";
const duplicateCatalog = workspaceConversationEntries({
  workspace: { workspaceKind: "notebook", workspacePath, name: "对话断电验收" },
  state: { ...base, conversations: [
    ...base.conversations,
    { ...base.conversations[0], messages: [...base.conversations[0].messages, { id: "old-reply", role: "assistant", content: "完整回复" }] },
  ] },
});
assert.equal(duplicateCatalog.length, 1, "历史目录不得把同一 conversationId 展示为多条相同对话");
assert.equal(duplicateCatalog[0].messageCount, 2, "重复记录必须保留更完整的一条");
await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: base });

// Simulate the narrow Windows power-loss window after the old file has moved
// to the swap name but before the replacement is renamed into place.
const currentStatePath = join(workspacePath, ".shensi", "current-state.json");
const swapStatePath = `${currentStatePath}.swap-power-loss`;
await rename(currentStatePath, swapStatePath);
const swapRecovered = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
assert.equal(swapRecovered.state.activeConversationId, "conversation-old", "缺失 current-state 时必须从原子写入交换文件恢复");
await rename(swapStatePath, currentStatePath);

const child = spawn(process.execPath, ["--input-type=module", "-e", `
  import { loadWorkspaceState, saveWorkspaceState } from ${JSON.stringify(new URL("../src/server/workspace.mjs", import.meta.url).href)};
  const options = ${JSON.stringify({ appRoot, requestedPath: workspacePath })};
  const loaded = await loadWorkspaceState(options);
  const next = structuredClone(loaded.state);
  next.conversations.unshift({ id: "conversation-new", title: "最新对话", messages: [{ id: "latest-message", role: "user", content: "断电前最新内容" }] });
  next.activeConversationId = "conversation-new";
  await saveWorkspaceState({ ...options, state: next });
`], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    SHENSI_TEST_WORKSPACE_FAULT: "after-save-core-before-journal-commit",
    SHENSI_TEST_WORKSPACE_FAULT_MODE: "exit",
    SHENSI_TEST_WORKSPACE_FAULT_COUNT: "1",
  },
  stdio: "ignore",
  windowsHide: true,
});
const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
assert.equal(exitCode, 86, "故障注入子进程必须在事务提交日志前退出");

const recovered = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
assert.equal(recovered.recovery.recoveredTransactions, 1, "启动恢复必须识别已发布但未写入 committed 日志的事务");
assert.deepEqual(recovered.state.conversations.map((item) => item.id), ["conversation-new", "conversation-old"], "断电后不得回滚最新对话");
assert.equal(recovered.state.activeConversationId, "conversation-new");

await rm(root, { recursive: true, force: true });
console.log("Conversation durable commit and power-loss recovery passed");
