import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-unified-trash-"));
process.env.SHENSI_DATA_ROOT = join(tempRoot, "data");

const { createBlankNotebookState, createBlankProjectState } = await import("../src/data.js");
const {
  createWorkspaceNotebook,
  createWorkspaceProject,
  deleteWorkspaceNotebook,
  deleteWorkspaceProject,
  listDeletedWorkspaces,
  loadWorkspaceState,
  permanentlyDeleteDeletedWorkspace,
  restoreDeletedWorkspace,
  saveWorkspaceState,
} = await import("../src/server/workspace.mjs");
const {
  assetHistoryEntryIsSuppressed,
  hideHistoricalAssets,
  unhideHistoricalAssets,
} = await import("../src/asset-history-policy.js");

const appRoot = join(tempRoot, "app");

try {
  const project = await createWorkspaceProject({ appRoot, name: "回收测试作品" });
  const projectState = createBlankProjectState({ name: project.name, workspacePath: project.workspacePath });
  projectState.documents["chapter-trash-proof"] = {
    title: "回收内容证明",
    markdown: "作品恢复后内容、结构与历史都必须仍在。",
    html: "<p>作品恢复后内容、结构与历史都必须仍在。</p>",
    moduleId: "manuscript",
    workspaceView: "novel",
  };
  projectState.moduleItems.manuscript.push(["chapter-trash-proof", "回收内容证明", { workspaceView: "novel" }]);
  projectState.histories["chapter-trash-proof"] = [{ id: "history-proof", content: "旧版本证明" }];
  await saveWorkspaceState({ appRoot, requestedPath: project.workspacePath, state: projectState });
  await deleteWorkspaceProject({ appRoot, requestedPath: project.workspacePath });
  assert.equal(await stat(project.workspacePath).catch(() => null), null, "删除后作品根目录应移入归档");

  const projectTrash = (await listDeletedWorkspaces({ appRoot })).find((entry) => entry.kind === "workspace-project");
  assert.ok(projectTrash?.trashId, "整个作品必须出现在统一回收站索引");
  assert.equal(projectTrash.title, "回收测试作品");
  assert.equal("archivedPath" in projectTrash, false, "回收站接口不应向 UI 暴露内部归档路径");

  await createWorkspaceProject({ appRoot, name: "回收测试作品" });
  const restoredProject = await restoreDeletedWorkspace({ appRoot, trashId: projectTrash.trashId });
  assert.equal(restoredProject.name, "回收测试作品（恢复）", "同名恢复不得覆盖现有作品");
  const restoredState = await loadWorkspaceState({ appRoot, requestedPath: restoredProject.workspacePath });
  assert.equal(restoredState.state.documents["chapter-trash-proof"].markdown, "作品恢复后内容、结构与历史都必须仍在。");
  assert.equal(restoredState.state.histories["chapter-trash-proof"][0].id, "history-proof");

  const notebook = await createWorkspaceNotebook({ name: "回收测试笔记" });
  const notebookState = createBlankNotebookState({ name: notebook.name, workspacePath: notebook.workspacePath });
  await saveWorkspaceState({ appRoot, requestedPath: notebook.workspacePath, state: notebookState });
  await deleteWorkspaceNotebook({ appRoot, requestedPath: notebook.workspacePath });
  const notebookTrash = (await listDeletedWorkspaces({ appRoot })).find((entry) => entry.kind === "workspace-notebook");
  assert.ok(notebookTrash?.trashId, "整个笔记本必须出现在统一回收站索引");
  const restoredNotebook = await restoreDeletedWorkspace({ appRoot, trashId: notebookTrash.trashId });
  const restoredNotebookState = await loadWorkspaceState({ appRoot, requestedPath: restoredNotebook.workspacePath });
  assert.equal(restoredNotebookState.state.workspaceKind, "notebook");

  const deleteOne = await createWorkspaceProject({ appRoot, name: "永久清理甲" });
  const keepOne = await createWorkspaceProject({ appRoot, name: "永久清理乙" });
  await deleteWorkspaceProject({ appRoot, requestedPath: deleteOne.workspacePath });
  await deleteWorkspaceProject({ appRoot, requestedPath: keepOne.workspacePath });
  const beforePermanent = await listDeletedWorkspaces({ appRoot });
  const deleteEntry = beforePermanent.find((entry) => entry.title === "永久清理甲");
  const keepEntry = beforePermanent.find((entry) => entry.title === "永久清理乙");
  assert.ok(deleteEntry && keepEntry);
  await permanentlyDeleteDeletedWorkspace({ appRoot, trashId: deleteEntry.trashId });
  const afterPermanent = await listDeletedWorkspaces({ appRoot });
  assert.equal(afterPermanent.some((entry) => entry.trashId === deleteEntry.trashId), false);
  assert.equal(afterPermanent.some((entry) => entry.trashId === keepEntry.trashId), true, "永久清理必须只删除精确目标归档");

  const asset = {
    id: "asset-hide-proof",
    kind: "image",
    attachment: { relativePath: "assets/proof.png" },
  };
  const workspace = {
    workspaceAssets: [asset],
    documents: {
      whiteboard: { canvas: { nodes: [{ id: "node-proof", assetId: asset.id, file: asset.attachment.relativePath }], assets: [asset] } },
    },
    assetHistoryTombstones: [],
  };
  const hidden = hideHistoricalAssets(workspace, asset, { now: "2026-08-29T00:00:00.000Z" });
  assert.deepEqual(hidden.workspace.workspaceAssets, workspace.workspaceAssets, "隐藏资产不得删除工作区资产记录");
  assert.deepEqual(hidden.workspace.documents, workspace.documents, "隐藏资产不得修改白板卡片或引用");
  assert.equal(assetHistoryEntryIsSuppressed(hidden.workspace, asset), true, "即使仍被卡片引用，资产库也应允许隐藏该条目");
  const unhiddenTombstones = unhideHistoricalAssets(hidden.workspace, asset);
  assert.equal(unhiddenTombstones.length, 0, "取消隐藏应只移除对应隐藏标记");

  const appSource = await readFile(join(process.cwd(), "src", "app.js"), "utf8");
  assert.match(appSource, /workspaceTrash:\s*\[\]/u);
  assert.match(appSource, /\/api\/workspaces\/trash\/restore/u);
  assert.match(appSource, /id="whiteboardAssetShowHidden"/u);
  assert.match(appSource, /unhideAssetsFromHistoryLibrary/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
}

console.log("unified workspace trash and reversible asset hiding tests passed");
