import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { authorCockpitDirectoryContent, authorCockpitSections } from "../src/author-cockpit.js";
import { buildDocumentTree, documentCreationOptions, newDocumentTreeOptions } from "../src/document-tree.js";

// Read only the function regions exercised here, not the complete renderer.
const region = async (start, end) => {
  const stream = createReadStream(new URL("../src/app.js", import.meta.url), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected = [];
  let collecting = false;
  try {
    for await (const line of lines) {
      if (collecting && line.startsWith(end)) break;
      if (line.startsWith(start)) collecting = true;
      if (collecting) selected.push(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  assert.ok(selected.length, `missing source region: ${start}`);
  return selected.join("\n");
};

const snippets = await Promise.all([
  region("const nextUniqueDocumentName =", "const createDocument ="),
  region("const createDocument =", "const createFolder ="),
  region("const createFolder =", "const renameFolder ="),
  region("const renderDirectoryTree =", "const renderDocumentList ="),
  region("const renderAuthorCockpitDocumentList =", "const directoryRootOrderKey ="),
  region("const moduleNavigationDocumentIds =", "const selectModuleRoot ="),
  region("const isReadonlyAuthorCockpitDocument =", "const renderCompilationDecisionSummary ="),
  region("const directoryModuleForTarget =", "const directoryNodeSequence ="),
]);

for (const moduleId of ["index", "reports"]) {
  let sequence = 0;
  const conversation = { id: "chat", messages: [{ role: "user", content: "keep this conversation" }] };
  const state = {
    workspaceKind: "project", activeModule: moduleId, activeDocument: "index-creative-guidance",
    documents: {
      "index-creative-guidance": { title: "创作引导" },
      "index-language-blacklist": { title: "创作合同" },
      "report-compile": { title: "项目总览", derived: true },
      "report-novel": { title: "小说自检", derived: true },
    },
    moduleItems: { index: [["index-creative-guidance", "创作引导"], ["index-language-blacklist", "创作合同"]], reports: [["report-compile", "项目总览"], ["report-novel", "小说自检"]] },
    customFolders: [], expandedFolders: [], directoryOrders: {}, histories: {},
  };
  const elements = { addDocument: {}, listTitle: { dataset: {} }, documentList: { innerHTML: "" }, editor: { dataset: {} } };
  const context = vm.createContext({
    state, elements, console, Set, globalUiPreferences: { uiLanguage: "zh-CN" },
    ui: { directorySelectedTokens: new Set() },
    clone: structuredClone, uid: (prefix) => `${prefix}-${++sequence}`,
    Date: class extends Date { static now() { return ++sequence; } },
    nowTime: () => "12:00", activeViewForModule: () => "default",
    itemsForModuleView: (id) => state.moduleItems[id] || [],
    activeModule: () => ({ id: state.activeModule, label: "索引" }), moduleView: () => null,
    normalizeStructureLanguage: (language) => language,
    documentCreationOptions, newDocumentTreeOptions, buildDocumentTree,
    authorCockpitDirectoryContent, authorCockpitSections,
    orderedDirectoryTree: (tree) => tree,
    directoryRootOrderKey: (id, view) => `${id}:${view}:root`,
    localizeSystemDocumentTitle: ({ title }) => title, localizeDirectoryLabel: ({ label }) => label,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    icon: (_code, label = "") => `<i>${label}</i>`, documentCutInClipboard: () => false,
    isAuthorCockpitModule: (id) => ["index", "reports"].includes(id),
    AUTHOR_COCKPIT_READONLY_DOCUMENT_IDS: new Set(["report-compile", "report-novel", "report-script", "report-adaptation", "index-update-log"]),
    belongsToAuthorCockpitReportCollection: ({ documentId }) => state.moduleItems.reports.some(([id]) => id === documentId),
    activeConversation: () => conversation, saveWorkspace: async () => true,
    openDocumentTab: (documentId) => { state.activeDocument = documentId; },
    ...Object.fromEntries(["snapshotVolume", "snapshotStructure", "bindConversationToCreatedDocument", "synchronizeConversationReferenceContext", "rebuildProjectCompilationStatus", "recordActivity", "persist", "renderAll", "persistExpandedFolderState", "showToast", "ensureDirectorySelectionScope", "syncDirectorySelectionClasses"].map((name) => [name, () => {}])),
  });
  vm.runInContext(snippets.join("\n"), context);
  const docId = vm.runInContext('createDocument("我的文档", { options: { workspaceView: "default", rootPlacement: true } })', context);
  const duplicateDocId = vm.runInContext('createDocument("我的文档", { options: { workspaceView: "default", rootPlacement: true } })', context);
  assert.equal(state.documents[duplicateDocId].title, "我的文档（2）", "same-scope document titles receive a numeric suffix");
  assert.equal(state.moduleItems[moduleId].find(([id]) => id === duplicateDocId)?.[1], "我的文档（2）", "directory label follows the unique document title");
  const boardId = vm.runInContext('createDocument("我的白板", { options: { workspaceView: "default", rootPlacement: true } }, { kind: "whiteboard" })', context);
  assert.equal(await vm.runInContext('createFolder("我的文件夹")', context), true);
  const folderId = state.customFolders[0].id;
  context.folderId = folderId;
  const nestedId = vm.runInContext('createDocument("文件夹里的文档", { options: { workspaceView: "default", customFolderId: folderId, customFolderLabel: "我的文件夹" } })', context);
  assert.equal(await vm.runInContext('createFolder("子文件夹", { id: folderId, options: { customFolderId: folderId, customFolderLabel: "我的文件夹" } })', context), true);

  // Both backing modules contribute to the single visible index, whichever is active.
  state.activeModule = moduleId === "index" ? "reports" : "index";
  vm.runInContext("renderAuthorCockpitDocumentList()", context);
  assert.equal(elements.addDocument.disabled, false);
  const html = elements.documentList.innerHTML;
  for (const id of [docId, boardId, nestedId]) {
    assert.ok(html.includes(`data-document="${id}"`), `created item must be visible: ${id}`);
    assert.equal(html.split(`data-document="${id}"`).length - 1, 1, "do not duplicate an item in summary and editable tree");
  }
  assert.ok(html.includes(`data-folder-toggle="${folderId}"`), "empty and nested folders must use the normal tree renderer");
  assert.ok(html.includes(`data-directory-parent="${folderId}"`));
  assert.ok(html.includes('data-document-kind="whiteboard"'));
  assert.ok(html.includes(`data-directory-module="${moduleId}"`), "actions must preserve the backing directory scope");
  for (const fixed of ["index-creative-guidance", "index-language-blacklist", "report-compile", "report-novel"]) {
    assert.ok(html.includes(`data-document="${fixed}"`), `keep system entry ${fixed}`);
  }
  const ids = vm.runInContext('moduleNavigationDocumentIds("reports")', context);
  for (const id of [docId, boardId, nestedId]) assert.ok(ids.includes(id), "navigation must be able to restore a custom index document");
  assert.equal(vm.runInContext(`isReadonlyAuthorCockpitDocument({ documentId: ${JSON.stringify(docId)}, documentState: state.documents[${JSON.stringify(docId)}] })`, context), false);
  assert.equal(vm.runInContext('isReadonlyAuthorCockpitDocument({ documentId: "report-novel", documentState: state.documents["report-novel"] })', context), true);
  assert.deepEqual(conversation.messages, [{ role: "user", content: "keep this conversation" }]);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(JSON.stringify(authorCockpitDirectoryContent(restored)), JSON.stringify(authorCockpitDirectoryContent(state)), "directory structure survives persistence round-trip");
  context.scopeTarget = { closest: () => ({ dataset: { directoryModule: moduleId } }) };
  assert.equal(vm.runInContext("directoryModuleForTarget(scopeTarget)", context), moduleId, "folder actions must use their backing module even when the other index source is active");
  state.activeModule = "manuscript";
  assert.equal(vm.runInContext("directoryModuleForTarget(scopeTarget)", context), "manuscript", "index projection must not change other module scopes");
  state.readOnly = true;
  vm.runInContext("renderAuthorCockpitDocumentList()", context);
  assert.equal(elements.addDocument.disabled, true, "read-only preview must not become editable");
}

console.log("Index custom document, whiteboard, folder, navigation and read-only regressions passed");
