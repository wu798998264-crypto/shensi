import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  explicitCurrentDocumentRequest,
  generalDocumentContextIds,
} from "../src/request-routing.js";

assert.equal(explicitCurrentDocumentRequest("为当前文档起一个标题"), true);
assert.equal(explicitCurrentDocumentRequest("沿用上一章的氛围"), false);

const ids = generalDocumentContextIds({
  text: "为当前文档起一个标题",
  currentDocumentId: "chapter-8",
  referenceIds: ["chapter-9", "chapter-7"],
  existingDocumentIds: ["chapter-7", "chapter-8", "chapter-9"],
  documents: [
    { id: "chapter-7", title: "建议标题" },
    { id: "chapter-8", title: "未命名" },
    { id: "chapter-9", title: "影渠" },
  ],
});
assert.equal(ids[0], "chapter-8", "明确当前文档时，当前文档必须先于历史引用和相邻章节");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /const currentDocumentId = targetDocumentId \|\| boundDocumentId/u);
assert.match(appSource, /const targetDocumentId = state\.workspaceKind === "notebook"[\s\S]{0,900}explicitlyNamedDocument/u);
assert.match(appSource, /const requiredReferenceIds = \[\.\.\.new Set\(referenceIds\)\][\s\S]{0,500}compileContextSections/u);
assert.match(appSource, /const titleOnlyContext =[^;]+target\?\.operation === "rename"/su);
assert.match(appSource, /titleOnlyContext \? \[\] : conversationContext/u);

console.log("Current-document context priority tests passed");
