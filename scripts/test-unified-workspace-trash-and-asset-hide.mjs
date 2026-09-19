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
  saveWorkspaceAttachment,
  saveWorkspaceState,
} = await import("../src/server/workspace.mjs");
const {
  moveAssetEntriesToTrash,
  permanentlyDeleteAssetTrashEntries,
  restoreAssetTrashEntries,
} = await import("../src/server/asset-trash-service.mjs");
const {
  ASSET_TRASH_RETENTION_MS,
  assetHistoryEntryIsPurged,
  assetHistoryEntryIsTrashed,
  expiredAssetTrashEntries,
  moveHistoricalAssetsToTrash,
  normalizeAssetHistoryTombstones,
  permanentlyDeleteHistoricalAssets,
  restoreHistoricalAssets,
} = await import("../src/asset-history-policy.js");
const { buildWorkspaceAssetCatalog } = await import("../src/server/global-asset-catalog.mjs");
const { mergeGlobalHistoricalAssets } = await import("../src/global-history-assets.js");

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
  const trashed = moveHistoricalAssetsToTrash(workspace, asset, { now: "2026-08-29T00:00:00.000Z" });
  assert.deepEqual(trashed.workspace.workspaceAssets, workspace.workspaceAssets, "移入资产回收站时不得提前删除工作区资产记录");
  assert.deepEqual(trashed.workspace.documents, workspace.documents, "移入资产回收站时不得修改白板卡片或引用");
  assert.equal(assetHistoryEntryIsTrashed(trashed.workspace, asset), true, "即使仍被卡片引用，资产也应允许进入资产回收站");
  assert.equal(trashed.workspace.assetHistoryTombstones[0].expiresAt, "2026-09-28T00:00:00.000Z");
  assert.equal(expiredAssetTrashEntries(trashed.workspace, { now: "2026-09-27T23:59:59.999Z" }).length, 0);
  assert.equal(expiredAssetTrashEntries(trashed.workspace, { now: "2026-09-28T00:00:00.000Z" }).length, 1, "满 30 天必须进入自动清理范围");
  const restoredTombstones = restoreHistoricalAssets(trashed.workspace, asset);
  assert.equal(restoredTombstones.length, 0, "恢复应只移除对应回收站标记");

  const purged = permanentlyDeleteHistoricalAssets(trashed.workspace, asset, { now: "2026-09-01T00:00:00.000Z" });
  assert.equal(purged.workspace.workspaceAssets.length, 0, "彻底删除必须移除工作区资产记录");
  assert.equal(purged.workspace.documents.whiteboard.canvas.assets.length, 0, "彻底删除必须移除白板资产历史记录");
  assert.equal(purged.workspace.documents.whiteboard.canvas.nodes.length, 1, "仍在白板上的当前卡片不得被资产库清理误删");
  assert.equal(assetHistoryEntryIsPurged(purged.workspace, asset), true, "彻底删除后必须保留不可复活的清理标记");
  assert.equal(restoreHistoricalAssets(purged.workspace, asset).length, 1, "恢复不得复活已经彻底删除的资产");
  const catalogWorkspace = { workspacePath: "C:/catalog-test", name: "资产目录测试" };
  const [trashedCatalogAsset] = buildWorkspaceAssetCatalog({ workspace: catalogWorkspace, state: trashed.workspace });
  assert.equal(trashedCatalogAsset?.assetTrash?.status, "trashed", "回收站资产必须携带跨工作区恢复所需的状态和期限");
  assert.equal(mergeGlobalHistoricalAssets({ catalogAssets: [trashedCatalogAsset] })[0]?.assetTrash?.status, "trashed", "全局目录合并不得丢失资产回收站状态");
  assert.equal(buildWorkspaceAssetCatalog({ workspace: catalogWorkspace, state: purged.workspace }).length, 0, "彻底删除资产不得被全局目录重新扫描复活");

  const migratedLegacy = normalizeAssetHistoryTombstones([{ ...asset, hiddenAt: "2025-01-01T00:00:00.000Z" }], { now: "2026-09-19T00:00:00.000Z" });
  assert.equal(migratedLegacy[0].deletedAt, "2026-09-19T00:00:00.000Z", "旧隐藏记录升级时必须从迁移时重新计算保留期");
  assert.equal(Date.parse(migratedLegacy[0].expiresAt) - Date.parse(migratedLegacy[0].deletedAt), ASSET_TRASH_RETENTION_MS);

  const assetProject = await createWorkspaceProject({ appRoot, name: "资产彻底删除测试" });
  const unreferencedAttachment = await saveWorkspaceAttachment({
    appRoot,
    requestedPath: assetProject.workspacePath,
    name: "待彻底删除.png",
    mimeType: "image/png",
    base64: Buffer.from("unreferenced-asset").toString("base64"),
  });
  const referencedAttachment = await saveWorkspaceAttachment({
    appRoot,
    requestedPath: assetProject.workspacePath,
    name: "仍被卡片使用.png",
    mimeType: "image/png",
    base64: Buffer.from("referenced-asset").toString("base64"),
  });
  const assetProjectState = createBlankProjectState({ name: assetProject.name, workspacePath: assetProject.workspacePath });
  const assetWhiteboardId = "asset-trash-whiteboard";
  assetProjectState.activeDocument = assetWhiteboardId;
  assetProjectState.documents[assetWhiteboardId] = {
    title: "资产回收站白板",
    documentKind: "whiteboard",
    moduleId: "manuscript",
    workspaceView: "novel",
  };
  assetProjectState.workspaceAssets = [
    { id: "delete-unreferenced", kind: "image", origin: "upload", attachment: unreferencedAttachment },
    { id: "delete-referenced", kind: "image", origin: "upload", attachment: referencedAttachment },
  ];
  assetProjectState.documents[assetWhiteboardId].canvas = {
    nodes: [{ id: "live-node", kind: "image", assetId: "delete-referenced", file: referencedAttachment.relativePath }],
    edges: [],
    assets: [assetProjectState.workspaceAssets[1]],
  };
  await saveWorkspaceState({ appRoot, requestedPath: assetProject.workspacePath, state: assetProjectState });
  await moveAssetEntriesToTrash({
    appRoot,
    requestedPath: assetProject.workspacePath,
    assets: assetProjectState.workspaceAssets,
    now: "2026-09-19T00:00:00.000Z",
  });
  let trashedAssetState = await loadWorkspaceState({ appRoot, requestedPath: assetProject.workspacePath });
  assert.equal(trashedAssetState.state.assetHistoryTombstones.filter((entry) => entry.status === "trashed").length, 2, "跨工作区删除也必须写入来源工作区的资产回收站");
  await restoreAssetTrashEntries({
    appRoot,
    requestedPath: assetProject.workspacePath,
    assets: [assetProjectState.workspaceAssets[0]],
  });
  trashedAssetState = await loadWorkspaceState({ appRoot, requestedPath: assetProject.workspacePath });
  assert.equal(trashedAssetState.state.assetHistoryTombstones.filter((entry) => entry.status === "trashed").length, 1, "恢复必须精确移除对应资产的回收站标记");
  const serviceResult = await permanentlyDeleteAssetTrashEntries({
    appRoot,
    requestedPath: assetProject.workspacePath,
    assets: assetProjectState.workspaceAssets,
    now: "2026-09-19T00:00:00.000Z",
  });
  assert.equal(serviceResult.deletedCount, 2);
  assert.equal(await stat(join(assetProject.workspacePath, unreferencedAttachment.relativePath)).catch(() => null), null, "无任何引用的媒体文件必须物理删除");
  assert.ok(await stat(join(assetProject.workspacePath, referencedAttachment.relativePath)), "仍被白板卡片使用的媒体文件必须安全保留");
  const deletedAssetState = await loadWorkspaceState({ appRoot, requestedPath: assetProject.workspacePath });
  assert.equal(deletedAssetState.state.workspaceAssets.length, 0, "彻底删除后资产记录不得复活");
  assert.equal(deletedAssetState.state.assetHistoryTombstones.filter((entry) => entry.status === "purged").length, 2, "彻底删除标记必须随工作区持久化");
  assert.equal(deletedAssetState.state.documents[assetWhiteboardId].canvas.nodes.length, 1, "彻底删除资产历史不得误删当前白板卡片");

  const appSource = await readFile(join(process.cwd(), "src", "app.js"), "utf8");
  assert.match(appSource, /workspaceTrash:\s*\[\]/u);
  assert.match(appSource, /\/api\/workspaces\/trash\/restore/u);
  assert.match(appSource, /id="whiteboardAssetShowTrash"/u);
  assert.match(appSource, /清空回收站/u);
  assert.match(appSource, /data-whiteboard-asset-action="permanent-delete"/u);
  assert.match(appSource, /restoreAssetsFromHistoryLibrary/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
}

console.log("unified workspace and 30-day asset trash tests passed");
