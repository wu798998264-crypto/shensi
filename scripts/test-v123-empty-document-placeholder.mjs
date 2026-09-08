import assert from "node:assert/strict";
import { readSourceWindow } from "./read-source-window.mjs";

import { createBlankNotebookState, createBlankProjectState } from "../src/data.js";
import { CREATIVE_GUIDANCE_DOCUMENT_ID } from "../src/creative-guidance-record.js";
import {
  clearLegacyNarrativePlaceholderDocument,
  legacyNarrativePlaceholderState,
  narrativeEmptyPlaceholder,
} from "../src/narrative-placeholder.js";

const placeholder = "在右侧对话中确定创作意图后开始填写。";
assert.equal(narrativeEmptyPlaceholder({ documentId: "chapter-1", language: "zh-CN" }), placeholder);
assert.equal(narrativeEmptyPlaceholder({ documentId: "outline-volume-1", language: "zh-CN" }), placeholder);
assert.equal(narrativeEmptyPlaceholder({ documentId: "user-document-1", language: "zh-CN" }), placeholder);
assert.equal(narrativeEmptyPlaceholder({ documentId: "", language: "zh-CN" }), "");

const blank = createBlankProjectState({ name: "空文档占位验收" });
for (const documentId of ["chapter-1", "outline-volume-1", "outline-series"]) {
  assert.equal(blank.documents[documentId], undefined, `${documentId} must not be pre-created`);
  assert.equal(Object.values(blank.moduleItems).flat().some(([id]) => id === documentId), false, `${documentId} must not appear in the file tree`);
}
assert.equal(blank.activeDocument, "");
assert.equal(blank.conversations[0].boundDocumentId, null);
const declaredBlankDocumentIds = Object.values(blank.moduleItems)
  .flat()
  .filter(([, , options = {}]) => !options.alias)
  .map(([documentId]) => documentId)
  .sort();
assert.deepEqual(Object.keys(blank.documents).sort(), declaredBlankDocumentIds, "空作品只能预置目录中声明的系统文档，不能偷偷创建正文、设定或大纲");
for (const [documentId] of blank.moduleItems.memory) {
  assert.equal(blank.documents[documentId]?.html, "", `${documentId} must start as an empty managed memory document`);
}
assert.equal(blank.documents["library-memo"]?.html, "", "每个作品必须带有不主动读取的空白备忘录");
assert.equal(blank.documents["library-memo"]?.readPolicy, "explicit-only");
assert.equal(blank.documents[CREATIVE_GUIDANCE_DOCUMENT_ID], undefined, "创作引导不得预建为作品文档");

const notebook = createBlankNotebookState({ name: "空笔记本验收" });
assert.equal(notebook.activeDocument, "");
assert.deepEqual(notebook.moduleItems.library, []);
assert.deepEqual(notebook.documents, {});
assert.equal(notebook.conversations[0].boundDocumentId, null);

const legacyOutline = { html: `<p>${placeholder}</p>`, markdown: placeholder };
assert.equal(legacyNarrativePlaceholderState("outline-volume-1", legacyOutline).body, true);
assert.equal(clearLegacyNarrativePlaceholderDocument("outline-volume-1", legacyOutline).changed, true);
assert.equal(legacyOutline.html, "");
assert.equal(legacyOutline.markdown, "");

const authored = { html: "<p>用户已经写入的正文。</p>", markdown: "用户已经写入的正文。" };
assert.equal(clearLegacyNarrativePlaceholderDocument("outline-volume-1", authored).changed, false);
assert.match(authored.html, /用户已经写入/u);

const appSource = (await Promise.all([
  ["const ensureStateSchema =", 5],
  ["const migrateLegacyNarrativePlaceholders =", 10],
  ["const syncEditorNarrativePlaceholder =", 45],
  ['elements.editor.addEventListener("pointerdown"', 8],
  ['elements.editor.addEventListener("focus"', 8],
].map(([marker, lines]) => readSourceWindow(new URL("../src/app.js", import.meta.url), marker, lines)))).join("\n");
const cssSource = await readSourceWindow(new URL("../src/styles.css", import.meta.url), ".manuscript-editor[data-empty-placeholder]::before", 30);
assert.match(appSource, /state\.schemaVersion\s*=\s*19/u);
assert.match(appSource, /document-empty-placeholder-ui-v18/u);
assert.match(appSource, /if \(!placeholder \|\| stripHtml\(html\)\)[\s\S]{0,160}clearEditorNarrativePlaceholder/u);
assert.match(appSource, /elements\.editor\.addEventListener\("pointerdown"[\s\S]{0,120}clearEditorNarrativePlaceholder\(\)/u);
assert.match(appSource, /elements\.editor\.addEventListener\("focus"[\s\S]{0,120}clearEditorNarrativePlaceholder\(\)/u);
assert.match(cssSource, /\.manuscript-editor\[data-empty-placeholder\]::before[\s\S]{0,260}pointer-events:\s*none[\s\S]{0,100}user-select:\s*none/u);
assert.match(cssSource, /\.manuscript-editor\[data-empty-placeholder\]:focus::before\s*\{\s*display:\s*none/u);

console.log("Shensi v1.2.3 empty document placeholder contracts passed");
