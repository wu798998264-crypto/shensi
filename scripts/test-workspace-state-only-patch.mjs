import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankNotebookState } from "../src/data.js";
import { workspaceStateOnlyPatchPayload } from "../src/workspace-state-patch.js";

const heavyState = {
  schemaVersion: 19,
  workspaceKind: "notebook",
  projectName: "状态增量",
  activeModule: "manuscript",
  activeDocument: "note-1",
  activeConversationId: "conversation-main",
  conversations: [{ id: "conversation-main", messages: [{ id: "m1", role: "user", content: "保留" }] }],
  messages: [{ id: "m1", role: "user", content: "保留" }],
  workspaceAssets: [{ id: "asset-1" }],
  documents: { "note-1": { html: "很大的正文" } },
  histories: { "note-1": [{ html: "很大的历史" }] },
  viewHistories: { manuscript: [{ state: "很大的视图历史" }] },
  volumeHistories: { volume: [{ state: "很大的分卷历史" }] },
  trash: [{ id: "trash-1", payload: "很大的回收站" }],
};
const patch = workspaceStateOnlyPatchPayload(heavyState);
assert.equal(patch.activeDocument, "note-1");
assert.deepEqual(patch.conversations, heavyState.conversations);
assert.deepEqual(patch.workspaceAssets, heavyState.workspaceAssets);
for (const excluded of ["documents", "histories", "viewHistories", "volumeHistories", "trash"]) {
  assert.equal(Object.hasOwn(patch, excluded), false, `state-only payload must exclude ${excluded}`);
}
patch.conversations[0].messages[0].content = "已修改副本";
assert.equal(heavyState.conversations[0].messages[0].content, "保留", "state-only payload must be an immutable request snapshot");

const appRoot = await mkdtemp(join(tmpdir(), "shensi-state-patch-"));
process.env.SHENSI_DATA_ROOT = appRoot;
const { loadWorkspaceState, saveWorkspaceState } = await import("../src/server/workspace.mjs");
const workspacePath = join(appRoot, "笔记", "状态增量");
try {
  const initial = createBlankNotebookState({ name: "状态增量", workspacePath });
  initial.documents["note-1"] = { title: "不能丢失", html: "<p>正文</p>", markdown: "正文", documentKind: "note" };
  initial.moduleItems.manuscript.push(["note-1", "不能丢失"]);
  initial.histories["note-1"] = [{ id: "history-1", html: "<p>历史</p>" }];
  initial.trash = [{ id: "trash-1", kind: "document", documentId: "old-note" }];
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: initial });
  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  const statePatch = workspaceStateOnlyPatchPayload({
    ...loaded.state,
    activeDocument: "note-1",
    activeModule: "manuscript",
  });
  const documentIds = Object.keys(loaded.state.documents);
  await saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    expectedStateStamp: loaded.stateStamp,
    state: {
      ...statePatch,
      documents: {},
      statePatch: { mode: "preserve-current-v1" },
      documentPatch: { mode: "delta-v1", documentIds },
    },
  });
  const saved = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(saved.state.activeDocument, "note-1");
  assert.equal(saved.state.documents["note-1"].html, "<p>正文</p>");
  assert.equal(saved.state.histories["note-1"][0].id, "history-1");
  assert.equal(saved.state.trash[0].id, "trash-1");
} finally {
  await rm(appRoot, { recursive: true, force: true });
}

console.log("Workspace state-only patch contract passed");
