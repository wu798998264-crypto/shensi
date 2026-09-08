import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

for (const action of ["copy", "cut", "paste-formatted", "paste-text", "insert-link", "insert-document"]) {
  assert.match(source, new RegExp(`data-text-edit-action="${action}"`), `missing context action: ${action}`);
}
assert.doesNotMatch(source, /data-text-edit-action="insert-card"/u, "文档正文右键菜单不应提供插入卡片");
assert.match(source, /id="noteLinkDialog"/u, "link dialog markup is required");
assert.match(source, /const openNoteLinkDialog =/u, "toolbar and context menu must share the link dialog");
assert.match(source, /insertNoteLink = \([^)]*rawUrl|insertNoteLink = async/u, "link insertion handler is required");
assert.doesNotMatch(source, /const insertNoteLink = \(\) => \{[\s\S]{0,180}window\.prompt/u, "link insertion must not depend on native prompt");
assert.match(source, /action === "paste-formatted"/u, "formatted paste handler is required");
assert.match(source, /action === "paste-text"/u, "plain-text paste handler is required");
assert.match(source, /const documentReferenceIdFromHref =/u, "document references need a stable href decoder");
assert.match(source, /selectDocument\(documentId\)/u, "document reference clicks must switch to the target document");
assert.match(source, /noteReferenceEntriesForCurrentWorkspace = \(\) =>/u, "document references must be built from the workspace hierarchy");
assert.match(source, /NOTE_REFERENCE_OPTION_LIMIT = 360/u, "document reference picker must cap rendered options");
assert.match(source, /data-note-reference-kind="\$\{escapeHtml\(entry\.kind\)\}"/u, "document reference tree targets must retain target kind");
assert.match(source, /id="noteReferenceTree" class="move-document-tree note-reference-tree"/u, "document reference picker must reuse the structured move tree style");
assert.match(source, /data-note-reference-tree-key/u, "document reference hierarchy must support expand and collapse");
assert.match(source, /activateNoteReferenceTarget/u, "folder and directory references must have a navigation handler");
assert.match(source, /noteReferenceFilterFrame/u, "document reference filtering must coalesce rapid input");
assert.match(source, /id="editor"[^>]+data-text-edit-context/u, "document editor must expose the shared context menu");
assert.match(source, /whiteboard-generation-inline-mentions[^>]+data-text-edit-context/u, "card text editor must expose the shared context menu");

console.log("rich text context menu checks passed");
