import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  fullTextImportDocumentTitle,
  fullTextImportInstructionRequested,
} from "../src/full-text-import-contract.js";

assert.equal(fullTextImportInstructionRequested("请把这本小说全文导入并落盘"), true);
assert.equal(fullTextImportInstructionRequested("全文导入"), true);
assert.equal(fullTextImportInstructionRequested("不要导入全文，只检查章节格式"), false);
assert.equal(fullTextImportInstructionRequested("全文导入功能如何工作？"), false);
assert.equal(fullTextImportInstructionRequested("测试一下全文导入规则是否存在"), false);
assert.equal(fullTextImportInstructionRequested("写前十章正文"), false);
assert.equal(fullTextImportInstructionRequested("请生成第一章完整小说正文并直接落盘"), false);
assert.equal(fullTextImportInstructionRequested("分析前三章完整小说正文的问题，然后修改并落盘"), false);
assert.equal(fullTextImportInstructionRequested("请将附件全文拆分并落盘"), true);
assert.equal(fullTextImportDocumentTitle({ bookTitle: "苍鳞御主", chapterTitle: "退婚", chapterNumber: 1 }), "苍鳞御主｜退婚");
assert.equal(fullTextImportDocumentTitle({ bookTitle: "苍鳞御主", chapterTitle: "第1章", chapterNumber: 1 }), "苍鳞御主");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /confirmFullTextImportPreview\(payload\)/u, "必须在物化完整章节前弹出确认框");
assert.ok(app.indexOf("confirmFullTextImportPreview(payload)") < app.indexOf('fetch("/api/workspace/full-text-import/materialize"'), "确认必须发生在拆分物化之前");
assert.match(app, /只读预览没有创建或修改任何正文文档/u);
assert.match(app, /snapshotDocument\(id,\s*"全文导入初始版本"/u);
assert.match(app, /kind:\s*"full_text_import_v1"/u);
assert.match(app, /assertFullTextImportReadback/u);
assert.match(app, /书名仅用于文档名称和分组，没有写入正文/u);

console.log("full-text explicit-trigger, confirmation-before-write, document-title and UI acceptance contract tests passed");
