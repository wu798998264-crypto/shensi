import assert from "node:assert/strict";

import { sortNotebookChapterItems } from "../src/chapter-document.js";

const items = [
  ["note-a", "普通笔记"],
  ["chapter-10", "第10章 终局"],
  ["chapter-2", "第2章 转折"],
  ["chapter-1", "第1章 开端"],
];
assert.deepEqual(sortNotebookChapterItems(items).map(([id]) => id), ["note-a", "chapter-1", "chapter-2", "chapter-10"]);

const folders = [
  ["a-2", "第2章 A", { customFolderId: "a" }],
  ["b-1", "第1章 B", { customFolderId: "b" }],
  ["a-1", "第1章 A", { customFolderId: "a" }],
];
assert.deepEqual(sortNotebookChapterItems(folders).map(([id]) => id), ["a-1", "b-1", "a-2"], "章节不得跨文件夹交换槽位");

console.log("Shensi v2.82 notebook chapter order baseline tests passed");
