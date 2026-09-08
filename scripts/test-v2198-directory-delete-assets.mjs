import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildNotebookDocumentTree, documentLocationChoices } from "../src/document-tree.js";
import { visibleWorkspaceModules } from "../src/author-cockpit.js";
import { MODULES } from "../src/data.js";

const legacyFolder = {
  id: "legacy-folder",
  label: "旧笔记文件夹",
  moduleId: "manuscript",
  viewId: "novel",
  parentLocationId: "manuscript:novel:root",
};
const documentState = { title: "真实笔记", html: "<p>正文</p>" };
const moduleItems = { manuscript: [["note-1", "真实笔记", { customFolderId: legacyFolder.id }]], library: [] };
const locations = documentLocationChoices({
  moduleId: "library",
  viewId: "default",
  items: [],
  documents: { "note-1": documentState },
  folders: [legacyFolder],
  workspaceKind: "notebook",
});
assert.ok(locations.some((location) => location.root), "笔记本必须保留可执行移动所需的根位置");
assert.ok(locations.some((location) => location.id === legacyFolder.id), "旧模块元数据下的真实笔记文件夹仍必须可选");

const notebookTree = buildNotebookDocumentTree({
  moduleItems,
  documents: { "note-1": documentState },
  folders: [legacyFolder],
});
assert.equal(notebookTree[0]?.label, legacyFolder.label);
assert.equal(notebookTree[0]?.children?.[0]?.label, documentState.title);

const visibleModules = visibleWorkspaceModules(MODULES);
assert.equal(visibleModules.find((module) => module.id === "reports")?.label, "索引");
assert.equal(visibleModules.some((module) => module.label === "作者驾驶舱"), false);

const [appSource, serverSource, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

assert.match(appSource, /normalizeGenerationAsset,\s*normalizeGenerationAssets/);
assert.match(appSource, /location && !location\.root/);
assert.match(appSource, /workspaceRoot: true/);
assert.match(appSource, /buildNotebookDocumentTree\(/);
assert.match(appSource, /event\.key === "Delete"[\s\S]*?confirmDirectorySelectionDelete\(context\)/);
assert.match(appSource, /const confirmDirectorySelectionDelete = \(context\) =>/);
assert.match(appSource, /documentDeleteAllowed\(\{[\s\S]*?workspaceKind: state\.workspaceKind/);
assert.match(appSource, /const permanentlyDeleteTrashEntry = async \(trashId\) =>/);
assert.match(appSource, /const removeDirectoryOrderEntries = \(\{ documentIds = \[\], folderIds = \[\] \} = \{\}\) =>/);
assert.match(appSource, /removeDirectoryOrderEntries\(\{ documentIds, folderIds: \[\.\.\.customFolderIds\] \}\)/);
assert.match(appSource, /removeDirectoryOrderEntries\(\{ documentIds, folderIds: \[node\.id, \.\.\.selection\.customFolderIds\] \}\)/);
assert.match(appSource, /removeDirectoryOrderEntries\(\{ documentIds, folderIds: \[\.\.\.folderIds, folderId\] \}\)/);
assert.match(appSource, /removeDirectoryOrderEntries\(\{ documentIds: \[documentId\] \}\)/);
assert.match(appSource, /await flushWorkspaceSave\(\{ throwOnError: true \}\)/);
assert.match(appSource, /cacheWorkspaceState\(\{[\s\S]*?prepared: true/);
assert.match(serverSource, /saveWorkspaceState\([\s\S]*?transferDirectoryCache\.expiresAt = 0;/);
assert.match(appSource, /id="whiteboardAssetSort"[\s\S]*?\\uE8CB/);
assert.match(appSource, /const duplicateStandaloneAsset = \(assets, candidate\) =>/);
assert.match(appSource, /资产保存失败，已保留原资产列表/);
assert.match(styles, /\.move-document-tree-document/);

console.log("v2.19.8 directory, delete persistence and standalone asset checks passed");
