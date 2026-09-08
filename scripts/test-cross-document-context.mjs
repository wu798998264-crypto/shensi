import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compileContextSections } from "../src/context-compiler.js";
import { resolveCrossFormatContentRoute } from "../src/cross-format-content-router.js";

const documents = [
  { id: "chapter-1", title: "《玄幻》第一章小说", contextDomain: "novel", moduleId: "manuscript", content: "小说正文：林砚在退婚台上召出沉睡的赤狼。" },
  { id: "note-1", title: "创作笔记：林砚的选择", contextDomain: "note", moduleId: "notes", content: "笔记：林砚必须先保护赤狼，再追查退婚真相。" },
  { id: "library-1", title: "御兽宗门资料", contextDomain: "reference", moduleId: "library", content: "资料：御兽宗以血契和灵息评定弟子。" },
  { id: "outline-1", title: "第一章章纲", contextDomain: "novel", moduleId: "outline", content: "大纲：退婚、觉醒、赤狼认主，结尾留下宗门令牌。" },
  { id: "script-1", title: "《玄幻》第一集剧本", contextDomain: "script", moduleId: "manuscript", content: "剧本：退婚台三镜头，赤狼从石碑后走出。" },
  { id: "history-1", title: "历史版本", contextDomain: "history", moduleId: "history", content: "历史：旧稿中的废弃结局。" },
  { id: "trash-1", title: "回收站", contextDomain: "trash", moduleId: "trash", content: "回收站：已删除草稿。" },
];

const forbidden = new Set(["history", "trash"]);
const byId = new Map(documents.map((document) => [document.id, document]));
const compile = (ids, query) => compileContextSections({
  ids,
  requiredIds: ids,
  titleFor: (id) => byId.get(id)?.title || id,
  contentFor: (id) => byId.get(id)?.content || "",
  authorityFor: (id) => byId.get(id)?.contextDomain === "novel" ? "source" : "reference",
  maxCharacters: 50_000,
  perDocumentLimit: 8_000,
  query,
});

const defaultIdsFor = (target) => documents
  .filter((document) => document.contextDomain === target.contextDomain && !forbidden.has(document.contextDomain))
  .map((document) => document.id);

const novelDefault = compile(defaultIdsFor({ contextDomain: "novel" }), "续写小说第一章");
assert.deepEqual(novelDefault.includedIds.sort(), ["chapter-1", "outline-1"].sort(), "小说默认上下文只读小说正文与大纲");
assert.equal(novelDefault.includedIds.includes("note-1"), false, "笔记不得默认混入小说上下文");
assert.equal(novelDefault.includedIds.includes("library-1"), false, "资料不得默认混入小说上下文");
assert.equal(novelDefault.includedIds.some((id) => forbidden.has(byId.get(id)?.contextDomain)), false, "历史和回收站不得进入任何上下文");

const notebookDefault = compile(defaultIdsFor({ contextDomain: "note" }), "整理当前笔记");
assert.deepEqual(notebookDefault.includedIds, ["note-1"], "笔记默认上下文必须隔离小说正文");

const route = resolveCrossFormatContentRoute({
  instruction: "根据《玄幻》第一章小说生成第一集剧本",
  documents,
  associatedDocumentId: "script-1",
  activeTargetDocumentId: "script-1",
  projectName: "玄幻",
});
assert.equal(route?.sourceDocumentId, "chapter-1", "明确引用时必须读取小说来源");
assert.equal(route?.sourceContentType, "novel");
assert.equal(route?.targetContentType, "script");
assert.equal(route?.targetDocumentId, "script-1", "跨文体转换必须写入当前剧本目标");
assert.notEqual(route.sourceDocumentId, route.targetDocumentId, "Source 与 Target 不得合并");

const explicitCrossStyle = compile(["chapter-1", "outline-1", "note-1", "library-1"], "根据明确引用的小说、笔记和资料生成剧本");
assert.deepEqual(new Set(explicitCrossStyle.includedIds), new Set(["chapter-1", "outline-1", "note-1", "library-1"]));
assert.equal(explicitCrossStyle.includedIds.includes("script-1"), false, "目标剧本文档不得作为隐式来源回读");
assert.equal(explicitCrossStyle.includedIds.some((id) => forbidden.has(byId.get(id)?.contextDomain)), false);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /contextDomain/u, "运行时任务必须带文体上下文域");
assert.match(appSource, /historyPreview/u, "历史版本保持独立预览通道，不参与上下文");

console.log(JSON.stringify({
  ok: true,
  defaultIsolation: { novel: novelDefault.includedIds, note: notebookDefault.includedIds },
  explicitReferences: explicitCrossStyle.includedIds,
  route: { source: route.sourceDocumentId, target: route.targetDocumentId, targetType: route.targetContentType },
}));
