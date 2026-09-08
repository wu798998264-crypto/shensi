import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildDocumentTree, documentWorkspaceView, ensureDocumentTreeMetadata } from "../src/document-tree.js";
import { rememberedModuleDocument } from "../src/workspace-conversation-policy.js";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const cases = [
  { id: "chapter-1", title: "第一章", documentState: { contextDomain: "novel" }, expected: "novel" },
  { id: "legacy-script", title: "影视剧本 第一集", documentState: {}, expected: "script" },
  { id: "legacy-short-drama", title: "短剧 第一集", documentState: {}, expected: "script" },
  { id: "script-by-deliverable", title: "第一集", documentState: { deliverableType: "short_drama_script" }, expected: "script" },
  { id: "prompt-video-1", title: "第一集视频提示词", documentState: {}, expected: "prompts" },
];

for (const testCase of cases) {
  assert.equal(documentWorkspaceView({
    moduleId: "manuscript",
    item: [testCase.id, testCase.title, {}],
    documentState: { title: testCase.title, ...testCase.documentState },
  }), testCase.expected, `${testCase.title} 应归入 ${testCase.expected}`);
}

const state = {
  workspaceKind: "project",
  moduleItems: {
    manuscript: cases.map(({ id, title }) => [id, title, {}]),
    outline: [], canon: [], memory: [], reports: [], library: [], index: [],
  },
  documents: Object.fromEntries(cases.map(({ id, title, documentState }) => [id, { title, ...documentState }])),
};
ensureDocumentTreeMetadata(state);
for (const testCase of cases) {
  const item = state.moduleItems.manuscript.find(([id]) => id === testCase.id);
  assert.equal(documentWorkspaceView({ moduleId: "manuscript", item, documentState: state.documents[testCase.id] }), testCase.expected);
}

for (const viewId of ["novel", "script", "prompts"]) {
  const ids = buildDocumentTree({
    moduleId: "manuscript",
    viewId,
    items: state.moduleItems.manuscript,
    documents: state.documents,
    workspaceKind: "project",
  }).flatMap((node) => node.type === "document" ? [node.id] : node.children?.map((child) => child.id) ?? []);
  for (const testCase of cases.filter((entry) => entry.expected === viewId)) {
    assert.ok(ids.includes(testCase.id), `${testCase.title} 必须显示在 ${viewId} 目录`);
  }
}

assert.equal(rememberedModuleDocument({
  moduleId: "manuscript",
  viewId: "script",
  remembered: { manuscript: "chapter-1", "manuscript:script": "script-by-deliverable" },
  documentIds: ["legacy-script", "script-by-deliverable"],
}), "script-by-deliverable", "同一板块的不同视图必须分别恢复最近文档");
assert.equal(rememberedModuleDocument({
  moduleId: "manuscript",
  viewId: "prompts",
  remembered: { "manuscript:prompts": "deleted-prompt" },
  documentIds: ["prompt-video-1"],
}), "prompt-video-1", "首次进入或记忆文档已删除时必须打开视图最上方第一项");

assert.match(appSource, /const itemWorkspaceView = \(moduleId, item\) => documentWorkspaceView/u, "应用层目录切换必须复用统一文体映射");
assert.match(appSource, /state\.moduleLastDocuments/u, "作品载入必须保留各板块最近打开文档");
assert.match(appSource, /rememberedModuleDocument\(\{[\s\S]{0,180}documentIds/u, "首次进入板块必须按板块首项打开，之后恢复最近位置");
assert.match(appSource, /moduleLastDocuments\[`\$\{presentationId\}:\$\{resolvedViewId\}`\]/u, "导航记忆必须按板块和视图分别保存");
assert.match(appSource, /const viewId = option\.dataset\.moduleView;[\s\S]{0,500}rememberedModuleDocument\(\{[\s\S]{0,160}viewId/u, "切换分类时必须恢复该分类上次打开的文档");
assert.match(appSource, /ui\.documentPreviewKey = manuscriptDocumentHasSubstantiveContent\(documentId\)[\s\S]{0,100}currentDocumentPreviewKey/u, "打开有内容正文必须默认进入预览");
assert.match(appSource, /const confirmedView = creativeWorkspaceView\(guidanceDeliverableType\);[\s\S]{0,220}selectCreativeWorkspaceView\(guidanceDeliverableType\)/u, "创作文体确认后必须切换相应目录");
const landedLinkHandler = appSource.slice(appSource.indexOf('elements.chatFeed.addEventListener("click"'), appSource.indexOf("const olderMessagesButton", appSource.indexOf('elements.chatFeed.addEventListener("click"')));
assert.match(landedLinkHandler, /const landedDocumentId[\s\S]*selectDocument\(landedDocumentId\)/u, "对话底部落盘链接必须通过统一文档选择逻辑切换目录");

console.log("v5.4.1 workspace view navigation tests passed");
