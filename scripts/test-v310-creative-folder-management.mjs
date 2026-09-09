import assert from "node:assert/strict";

import { createMissingChapterDocument } from "../src/chapter-document.js";
import {
  documentMatchesPlannedFolder,
  ensurePlannedChapterFolder,
  plannedVolumeFolderForChapter,
} from "../src/creative-folder-management.js";
import { compileTaskContract, evaluateTaskContract } from "../src/task-contract.js";
import { looksLikeWorkspaceOperation, normalizeWorkspaceOperationPlan, workspaceOperationLabel } from "../src/workspace-operations.js";
import { sanitizeDeletedContentWorkspaceRequest } from "../src/deleted-content-access.js";
import fs from "node:fs";

const plannedDocuments = {
  "outline-volume-1": {
    title: "御兽觉醒",
    html: "<h2>第一卷规划</h2><p>章节范围：第1章至第10章</p>",
    moduleId: "outline",
  },
};

const planned = plannedVolumeFolderForChapter({ chapterNumber: 3, documents: plannedDocuments });
assert.equal(planned.folderLabel, "第1卷·御兽觉醒");
assert.equal(planned.sourceDocumentId, "outline-volume-1");
assert.equal(plannedVolumeFolderForChapter({ chapterNumber: 11, documents: plannedDocuments }), null);

const seriesPlanned = plannedVolumeFolderForChapter({
  chapterNumber: 2,
  documents: {
    "outline-series": {
      title: "全集大纲",
      html: "第一卷《废柴开庭》\n章节范围：第1章至第10章\n第二卷《百城争锋》\n章节范围：第11章至第20章",
    },
  },
});
assert.equal(seriesPlanned.folderLabel, "第一卷·废柴开庭", "正式卷标题应去除书名号并绑定对应章节范围");
assert.equal(plannedVolumeFolderForChapter({
  chapterNumber: 2,
  documents: {
    "outline-series": {
      title: "全集大纲",
      html: "第一卷《废柴开庭》\n卷内剧情说明\n第五卷揭示神庭本应存在第十三个无座之位。\n第1章至第10章逐章章纲",
    },
  },
}), null, "正文中的‘第五卷揭示’不得被当成卷标题并错误绑定后续章节范围");

const bareRangePlan = plannedVolumeFolderForChapter({
  chapterNumber: 2,
  documents: {
    "outline-series": {
      title: "全集大纲",
      html: "第一卷《废柴开庭》\n第1章至第10章",
    },
  },
});
assert.equal(bareRangePlan.folderLabel, "第一卷·废柴开庭", "独立一行的纯章节范围仍应作为合法分卷证据");

const state = {
  structureLanguage: "zh-CN",
  documents: { ...structuredClone(plannedDocuments) },
  histories: {},
  moduleItems: { manuscript: [], outline: [["outline-volume-1", "御兽觉醒", { treeGroup: "volumes" }]] },
  customFolders: [],
  expandedFolders: [],
};

const preparation = ensurePlannedChapterFolder({
  state,
  target: { documentId: "chapter-1", chapterNumber: 1 },
  createFolderId: () => "custom-folder:volume-1",
  createdAt: "2026-08-25T00:00:00.000Z",
});
assert.equal(preparation.created, true);
assert.equal(state.customFolders[0].label, "第1卷·御兽觉醒");
assert.equal(state.documents["chapter-1"], undefined, "文件夹应先于正文文档创建");

const creation = createMissingChapterDocument({
  state,
  target: { documentId: "chapter-1", chapterTitle: "契约残兽" },
  treeOptions: preparation.treeOptions,
  updatedAt: "2026-08-25 08:00",
});
assert.equal(creation.created, true);
assert.equal(state.moduleItems.manuscript[0][2].customFolderId, "custom-folder:volume-1");
assert.equal(state.documents["chapter-1"].volumeFolder, "第1卷·御兽觉醒");
assert.equal(documentMatchesPlannedFolder({ state, documentId: "chapter-1", folderLabel: "第1卷·御兽觉醒" }), true);

const appSource = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(
  appSource,
  /document\.target\?\.explicitArtifact\s*&&\s*!\/\^chapter-\\d\+\$\/\.test\(document\.documentId\)/u,
  "即使路由携带 explicitArtifact，chapter-N 也必须走章节创建器以保留规划文件夹绑定",
);

const reused = ensurePlannedChapterFolder({
  state,
  target: { documentId: "chapter-2", chapterNumber: 2 },
  createFolderId: () => "must-not-be-created",
});
assert.equal(reused.created, false);
assert.equal(reused.folderId, "custom-folder:volume-1");
assert.equal(state.customFolders.length, 1, "同名规划文件夹必须复用");

const noPlanState = { documents: {}, moduleItems: { manuscript: [] }, customFolders: [], expandedFolders: [] };
const noPlan = ensurePlannedChapterFolder({
  state: noPlanState,
  target: { documentId: "chapter-1", chapterNumber: 1 },
  createFolderId: () => "unexpected",
});
assert.equal(noPlan.planned, false);
assert.equal(noPlanState.customFolders.length, 0, "没有规划时不得臆造正式文件夹名");

const misleadingSeriesState = {
  documents: {
    "outline-series": {
      title: "全集大纲",
      html: "第五卷：揭示神庭本应存在第十三个无座之位。\n\n七、第1章至第10章逐章章纲",
    },
  },
  moduleItems: { manuscript: [] },
  customFolders: [],
  expandedFolders: [],
};
const misleadingPreparation = ensurePlannedChapterFolder({
  state: misleadingSeriesState,
  target: { documentId: "chapter-1", chapterNumber: 1 },
  createFolderId: () => "must-not-create-misleading-volume",
});
assert.equal(misleadingPreparation.planned, false, "叙述性卷次附近的全局章纲标题不能形成目录规划");
assert.equal(misleadingSeriesState.customFolders.length, 0, "误判路径不得留下悬空分卷目录");

const renameState = {
  documents: {
    ...structuredClone(plannedDocuments),
    "chapter-1": { title: "旧章", html: "正文", volumeFolder: "第1卷·旧名", volumeLabel: "第1卷·旧名" },
  },
  moduleItems: {
    manuscript: [["chapter-1", "第1章　旧章", {
      workspaceView: "novel",
      customFolderId: "custom-folder:old-volume",
      customFolderLabel: "第1卷·旧名",
      customFolderPath: "第1卷·旧名",
      folderId: "custom-folder:old-volume",
      folderLabel: "第1卷·旧名",
      volumeFolder: "第1卷·旧名",
    }]],
  },
  customFolders: [{
    id: "custom-folder:old-volume",
    label: "第1卷·旧名",
    moduleId: "manuscript",
    viewId: "novel",
    parentOptions: {},
    folderPath: "第1卷·旧名",
  }],
  expandedFolders: [],
};
const renamed = ensurePlannedChapterFolder({ state: renameState, target: { documentId: "chapter-1", chapterNumber: 1 } });
assert.equal(renamed.renamed, true);
assert.equal(renameState.customFolders[0].label, "第1卷·御兽觉醒");
assert.equal(renameState.documents["chapter-1"].volumeFolder, "第1卷·御兽觉醒");

const contract = compileTaskContract({
  taskType: "writing",
  instruction: "根据卷纲写第一章并落盘",
  target: {
    documents: [{
      documentId: "chapter-1",
      title: "第1章",
      moduleId: "manuscript",
      plannedFolderLabel: "第1卷·御兽觉醒",
    }],
  },
});
assert.ok(contract.deliverables[0].acceptanceCriteria.includes("target_folder:第1卷·御兽觉醒"));
const wrongFolder = evaluateTaskContract({
  contract,
  documents: { "chapter-1": { title: "第1章", text: "正文", moduleId: "manuscript", volumeFolder: "第001卷-未命名" } },
  receipts: [{ targetDocumentId: "chapter-1", verified: true }],
});
assert.match(wrongFolder.missing[0].reason, /target_folder_mismatch/u);

const operationPlan = normalizeWorkspaceOperationPlan({
  intent: "按规划整理第一卷",
  operations: [
    { type: "folder.ensure", moduleId: "manuscript", viewId: "novel", name: "第1卷·御兽觉醒" },
    { type: "document.move", documentId: "chapter-1", moduleId: "manuscript", viewId: "novel", folderLabel: "第1卷·御兽觉醒" },
  ],
}, {
  documentIds: ["chapter-1"],
  documentTitles: { "chapter-1": "第1章" },
  documentRevisions: { "chapter-1": "r1" },
  folders: [],
});
assert.equal(operationPlan.operations[0].type, "folder.ensure");
assert.equal(operationPlan.operations[1].folderLabel, "第1卷·御兽觉醒");
assert.match(workspaceOperationLabel(operationPlan.operations[0]), /确保文件夹/u);

const renamePlan = normalizeWorkspaceOperationPlan({
  operations: [{ type: "folder.rename", folderId: "custom-folder:old-volume", name: "第1卷·御兽觉醒" }],
}, {
  folders: [{ id: "custom-folder:old-volume", label: "第1卷·旧名" }],
});
assert.equal(renamePlan.operations[0].type, "folder.rename");
assert.equal(normalizeWorkspaceOperationPlan({
  operations: [{ type: "folder.rename", folderId: "missing", name: "新名称" }],
}, { folders: [] }), null, "不存在的文件夹不能进入执行计划");
assert.equal(looksLikeWorkspaceOperation("根据创作规划给正文文件夹命名"), true);
assert.equal(looksLikeWorkspaceOperation("暂时不要给正文文件夹命名"), false);
const composerDispatch = appSource.slice(
  appSource.indexOf("const dispatchComposerContent ="),
  appSource.indexOf("let agentProfileChoiceContext ="),
);
assert.match(composerDispatch, /void sendMessage\(content,[\s\S]{0,220}executionSurface: "agent"/u,
  "目录、正文和其他输入框任务必须统一交给 Agent 判断");
assert.doesNotMatch(appSource, /explicitStructuralOnlyWorkspaceOperation/u,
  "不得恢复根据目录或正文字样抢占任务路由的旧关键词分流");
const safePlanningContext = sanitizeDeletedContentWorkspaceRequest({
  prompt: "根据创作规划给正文文件夹命名",
  documentContext: "## 全集大纲\n第一卷：御兽觉醒\n\n## 已删除内容片段\n不得泄漏",
});
assert.match(safePlanningContext.documentContext, /第一卷：御兽觉醒/u);
assert.doesNotMatch(safePlanningContext.documentContext, /不得泄漏/u);

console.log("Shensi planned folder management passed");
