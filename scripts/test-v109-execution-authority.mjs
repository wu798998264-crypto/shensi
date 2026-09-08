import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import { documentDeleteAllowed, folderDeleteAllowed, manuscriptVolumeDeleteSelection } from "../src/document-tree.js";
import { directoryDeletionDocumentIds, orphanTreeReferenceTrashPayload } from "../src/orphan-tree-reference.js";
import { resolveProjectCapabilityPlan } from "../src/module-registry.js";
import { explicitSelfCheckRequested, runShensiOrchestration } from "../src/server/shensi-orchestrator.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { transferWorkspaceDocuments } from "../src/server/workspace-document-transfer.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appSource = await readFile(join(root, "src", "app.js"), "utf8");
const transferSource = await readFile(join(root, "src", "server", "workspace-document-transfer.mjs"), "utf8");

assert.equal(explicitSelfCheckRequested("写一章并直接落盘"), false);
assert.equal(explicitSelfCheckRequested("写完后自检并修改，再落盘"), true);
assert.equal(explicitSelfCheckRequested("不要自检，直接写入正文"), false);

const directPlan = resolveProjectCapabilityPlan({
  activeModule: "manuscript",
  prompt: "续写下一章并落盘",
  contextDomain: "novel",
  targetDocumentId: "chapter-2",
});
assert.equal(directPlan.capabilities.includes("effect_reviewer"), false);

const reviewedPlan = resolveProjectCapabilityPlan({
  activeModule: "manuscript",
  prompt: "续写下一章，自检并修改后落盘",
  contextDomain: "novel",
  targetDocumentId: "chapter-2",
});
assert.equal(reviewedPlan.capabilities.includes("effect_reviewer"), true);

assert.equal(folderDeleteAllowed({ node: { type: "folder" }, moduleId: "reports", viewId: "default", workspaceKind: "project" }), true);
assert.equal(folderDeleteAllowed({ node: { type: "folder", authorCockpitFixed: true }, moduleId: "reports", viewId: "default", workspaceKind: "project" }), false);
assert.equal(folderDeleteAllowed({ node: { type: "folder" }, moduleId: "manuscript", viewId: "novel", workspaceKind: "project" }), true);
assert.equal(documentDeleteAllowed({ documentId: "chapter-1", moduleId: "manuscript", workspaceKind: "project" }), true);
assert.equal(documentDeleteAllowed({ documentId: "report-novel", moduleId: "reports", workspaceKind: "project" }), false);
assert.equal(documentDeleteAllowed({ documentId: "board-1", moduleId: "whiteboard", workspaceKind: "project" }), true);
assert.deepEqual(orphanTreeReferenceTrashPayload({
  documentId: "missing-note",
  located: { moduleId: "library", item: ["missing-note", "旧目录记录"] },
}), {
  title: "旧目录记录",
  moduleId: "library",
  item: ["missing-note", "旧目录记录"],
  moduleItems: { library: [["missing-note", "旧目录记录"]] },
  structure: [{ type: "document", id: "missing-note", label: "旧目录记录", missingContent: true }],
  missingContentReference: true,
});
assert.deepEqual(directoryDeletionDocumentIds({
  tokens: ["document:missing-attachment"],
  documents: {},
  directoryItemIds: ["missing-attachment"],
  tree: [],
}), ["missing-attachment"], "目录仍显示但正文实体缺失的附件必须可以删除");
assert.deepEqual(directoryDeletionDocumentIds({
  tokens: ["folder:legacy-folder"],
  documents: { "real-note": { title: "真实文档" } },
  directoryItemIds: ["real-note", "missing-attachment"],
  tree: [{
    type: "folder",
    id: "legacy-folder",
    children: [
      { type: "document", id: "real-note" },
      { type: "document", id: "missing-attachment" },
    ],
  }],
}), ["real-note", "missing-attachment"], "删除文件夹时真实文档和孤立附件目录项必须一并进入回收站");
const orphanVolumeSelection = manuscriptVolumeDeleteSelection({
  folderId: "manuscript-volume:legacy",
  items: [["orphan-document", "第一章", { folderId: "manuscript-volume:legacy", folderLabel: "旧分卷" }]],
  folders: [],
});
assert.deepEqual(orphanVolumeSelection.documentIds, ["orphan-document"]);
assert.match(appSource, /const documentCount = selection\.documentIds\.length/u);
assert.match(appSource, /const hydratedDocumentIds = documentIds\.filter/u);
assert.match(appSource, /const treeDocumentIds = \[\.\.\.new Set\(items\.map/u);
assert.match(appSource, /treeDocumentIds\.forEach\(removeDocumentFromWorkspaceState\)/u);
assert.match(appSource, /const deleteDocument = async \(documentId\)/u);
assert.match(appSource, /orphanTreeReferenceTrashPayload\(\{ documentId, located: locatedDocument/u);
assert.match(appSource, /directoryDeletionDocumentIds\(\{/u);
assert.match(appSource, /forceFullState: hasOrphanReferences/u);
assert.match(appSource, /else if \(ui\.deleteDocumentId\) await deleteDocument/u);
assert.doesNotMatch(appSource, /longForm: taskRoute\.reviewTier/u);
assert.doesNotMatch(appSource, /正文写入前质量门禁未通过/u);
assert.match(appSource, /status: "running",\s*\n\s*result: "Agent 已完成生成，正在确认落盘"/u);
assert.match(appSource, /pending\.pending = false;\s*\n\s*const landingSucceeded/u);
assert.match(appSource, /"reports", "library", "index"/u);
assert.match(transferSource, /"reports", "library", "index"/u);

const invokedStages = [];
const orchestration = await runShensiOrchestration({
  shensiRoot: root,
  settings: {},
  messages: [{ role: "user", content: "直接写第一章正文并落盘，不要自检。主角在雨夜收到一封来自未来的信。" }],
  projectContext: "作品：测试作品。目标：第一章。当前正文为空。",
  postwriteProjectContext: "作品：测试作品。没有额外正史冲突。",
  activeModule: "manuscript",
  contextDomain: "novel",
  workspaceKind: "project",
  targetDocumentId: "chapter-1",
  cwd: root,
  runModel: async ({ shensiRuntime }) => {
    const stage = shensiRuntime?.stage || "unknown";
    invokedStages.push(stage);
    if (stage === "planning") return {
      text: JSON.stringify({
        action: "generate",
        taskType: "write_chapter",
        target: "第一章正文",
        intent: "完成雨夜来信开篇",
        question: "",
        capsule: "主角在雨夜收到来自未来的信",
        evidencePlan: [],
        productionPlan: ["完成开篇"],
        hardConstraints: [],
        desiredEffects: ["悬念"],
        chapterMission: "开篇",
        narrativeMode: "外部行动",
        endingFunction: "方向转换",
        protectedAssets: [],
        recentReuseRisks: [],
        canonRisks: [],
        decisionGap: { key: "", impact: "ordinary", inferable: true, alreadyAnswered: true, evidence: "" },
        plotAssessment: null,
        conceptBindings: [],
        narrativeLock: null,
        guidanceState: null,
        routeAdaptation: { decision: "stay", confidence: "high", reason: "用户明确直接执行", evidence: ["用户指令"] },
        contextAssessment: { sufficient: true, confidence: "high", needs: [] },
      }),
    };
    if (stage === "creative") return { text: "【候选稿】\n雨落在旧站台上。林舟拆开信封，落款日期却是十年以后。" };
    throw new Error(`unexpected self-check stage: ${stage}`);
  },
});
assert.equal(orchestration.execution.status, "ready_to_land");
assert.equal(orchestration.execution.validationStatus, "passed");
assert.equal(orchestration.reviewArtifact?.type, "shensi_native_review");
assert.equal(orchestration.reviewArtifact?.verdict, "passed");
assert.equal(orchestration.reviewArtifact?.reviewerProfile, "direct");
assert.deepEqual(invokedStages.filter((stage) => /evaluation|check|review/u.test(stage)), []);
assert.match(orchestration.text, /雨落在旧站台上/u);

const transferRoot = await mkdtemp(join(tmpdir(), "shensi-v109-transfer-"));
try {
  const appRoot = join(transferRoot, "app");
  const sourcePath = join(appRoot, "runtime", "source");
  const targetPath = join(appRoot, "runtime", "target");
  const sourceState = createBlankProjectState("粘贴源");
  sourceState.documents["paste-source"] = { title: "待粘贴文档", html: "<p>真实粘贴内容</p>", moduleId: "library", workspaceView: "default" };
  sourceState.histories["paste-source"] = [];
  sourceState.moduleItems.library.push(["paste-source", "待粘贴文档", { workspaceView: "default", rootPlacement: true }]);
  sourceState.customFolders.push(
    { id: "folder-root", label: "待移动目录", moduleId: "library", viewId: "default", parentLocationId: "library:default:root", parentLabel: "资料库", parentOptions: {}, folderPath: "待移动目录" },
    { id: "folder-child", label: "子目录", moduleId: "library", viewId: "default", parentLocationId: "folder-root", parentLabel: "待移动目录", parentOptions: { customFolderId: "folder-root", customFolderLabel: "待移动目录", customFolderPath: "待移动目录" }, folderPath: "待移动目录/子目录" },
  );
  sourceState.documents["folder-document"] = { title: "目录正文", html: "<p>跨工作区文件夹正文</p>", moduleId: "library", workspaceView: "default", customFolderId: "folder-child", customFolderPath: "待移动目录/子目录" };
  sourceState.histories["folder-document"] = [{ id: "folder-version", document: structuredClone(sourceState.documents["folder-document"]) }];
  sourceState.moduleItems.library.push(["folder-document", "目录正文", { workspaceView: "default", customFolderId: "folder-child", customFolderLabel: "子目录", customFolderPath: "待移动目录/子目录" }]);
  const targetState = createBlankProjectState("粘贴目标");
  await saveWorkspaceState({ appRoot, requestedPath: sourcePath, state: sourceState });
  await saveWorkspaceState({ appRoot, requestedPath: targetPath, state: targetState });
  const transferred = await transferWorkspaceDocuments({
    appRoot,
    operation: "copy",
    sourceWorkspacePath: sourcePath,
    documentIds: ["paste-source"],
    targetWorkspacePath: targetPath,
    targetWorkspaceKind: "project",
    targetModuleId: "reports",
    targetViewId: "default",
    targetLocationId: "reports:default:root",
  });
  assert.equal(transferred.transferred.length, 1);
  const loadedTarget = await loadWorkspaceState({ appRoot, requestedPath: targetPath });
  const pastedId = transferred.transferred[0].targetDocumentId;
  assert.match(loadedTarget.state.documents[pastedId].html, /真实粘贴内容/u);
  assert.equal(loadedTarget.state.moduleItems.reports.some(([documentId]) => documentId === pastedId), true);

  const deletedState = structuredClone(loadedTarget.state);
  delete deletedState.documents[pastedId];
  delete deletedState.histories[pastedId];
  deletedState.moduleItems.reports = deletedState.moduleItems.reports.filter(([documentId]) => documentId !== pastedId);
  await saveWorkspaceState({
    appRoot,
    requestedPath: targetPath,
    state: deletedState,
    expectedStateStamp: loadedTarget.stateStamp,
  });
  const reloadedAfterDelete = await loadWorkspaceState({ appRoot, requestedPath: targetPath });
  assert.equal(Boolean(reloadedAfterDelete.state.documents[pastedId]), false);
  assert.equal(reloadedAfterDelete.state.moduleItems.reports.some(([documentId]) => documentId === pastedId), false);

  const copiedFolder = await transferWorkspaceDocuments({
    appRoot,
    operation: "copy",
    sourceWorkspacePath: sourcePath,
    sourceFolder: { id: "folder-root", label: "待移动目录", moduleId: "library", viewId: "default" },
    targetWorkspacePath: targetPath,
    targetWorkspaceKind: "project",
    targetModuleId: "reports",
    targetViewId: "default",
    targetLocationId: "reports:default:root",
  });
  assert.equal(copiedFolder.transferred.length, 1);
  assert.ok(copiedFolder.transferredFolderId);
  const sourceAfterFolderCopy = await loadWorkspaceState({ appRoot, requestedPath: sourcePath });
  assert.equal(Boolean(sourceAfterFolderCopy.state.documents["folder-document"]), true, "copy must retain the source folder document");

  const movedFolder = await transferWorkspaceDocuments({
    appRoot,
    operation: "move",
    sourceWorkspacePath: sourcePath,
    sourceFolder: { id: "folder-root", label: "待移动目录", moduleId: "library", viewId: "default" },
    targetWorkspacePath: targetPath,
    targetWorkspaceKind: "project",
    targetModuleId: "reports",
    targetViewId: "default",
    targetLocationId: "reports:default:root",
  });
  assert.equal(movedFolder.transferred.length, 1);
  assert.ok(movedFolder.transferredFolderId);
  const targetAfterFolderMove = await loadWorkspaceState({ appRoot, requestedPath: targetPath });
  const movedDocumentId = movedFolder.transferred[0].targetDocumentId;
  assert.match(targetAfterFolderMove.state.documents[movedDocumentId].html, /跨工作区文件夹正文/u);
  assert.equal(targetAfterFolderMove.state.histories[movedDocumentId].length, 1);
  assert.match(targetAfterFolderMove.state.documents[movedDocumentId].customFolderPath, /待移动目录(?: \(2\))?\/子目录/u);
  const sourceAfterFolderMove = await loadWorkspaceState({ appRoot, requestedPath: sourcePath });
  assert.equal(Boolean(sourceAfterFolderMove.state.documents["folder-document"]), false);
  assert.equal(sourceAfterFolderMove.state.customFolders.some((folder) => ["folder-root", "folder-child"].includes(folder.id)), false);
} finally {
  await rm(transferRoot, { recursive: true, force: true });
}

console.log("Shensi execution authority regressions passed");
