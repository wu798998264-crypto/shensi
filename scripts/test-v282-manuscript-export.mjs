import assert from "node:assert/strict";

import { buildDocumentExportManifest } from "../src/document-export-contract.js";
import { createManuscriptExport, DOCUMENT_EXPORT_FORMATS } from "../src/server/document-export.mjs";
import { readFile } from "node:fs/promises";

const zipEntries = (bytes) => {
  const buffer = Buffer.from(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    entries.push({
      name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      content: buffer.subarray(contentStart, contentStart + size),
    });
    offset = contentStart + size;
  }
  return entries;
};

const state = {
  documents: {
    "chapter-1": { title: "第1章 起点", html: "<p>一。</p>", markdown: "# 第1章 起点\n\n一。" },
    "chapter-2": { title: "第2章 空章", html: "", markdown: "" },
    "chapter-3": { title: "第1章 起点", html: "<p>同名文档正文。</p>" },
    board: { title: "白板", documentKind: "whiteboard" },
    virtual: { title: "虚拟报告", virtual: true, html: "<p>不得导出。</p>" },
    "script-1": { title: "第1集 开场", html: "<p>内景。夜。</p>" },
    "script-2": { title: "第2集 转折", html: "<p>外景。日。</p>" },
  },
  moduleItems: {
    manuscript: [
      ["chapter-2", "第2章 空章", { workspaceView: "novel" }],
      ["board", "白板", { workspaceView: "novel" }],
      ["chapter-1", "第1章 起点", { workspaceView: "novel" }],
      ["virtual", "虚拟报告", { workspaceView: "novel" }],
      ["chapter-3", "第1章 起点", { workspaceView: "novel" }],
      ["script-2", "第2集 转折", { workspaceView: "script" }],
      ["script-1", "第1集 开场", { workspaceView: "script" }],
    ],
  },
};

const beforeState = JSON.stringify(state);
const manifest = buildDocumentExportManifest({
  state,
  moduleId: "manuscript",
  viewId: "novel",
  pathForDocument: (_documentId, document) => `小说正文/${document.title}`,
});
assert.equal(manifest.documentCount, 3);
assert.deepEqual(manifest.documents.map(({ documentId }) => documentId), ["chapter-2", "chapter-1", "chapter-3"]);
assert.equal(manifest.documents[0].text, "");
assert.equal(manifest.documents.every(({ contentHash }) => /^[a-f\d]{64}$/u.test(contentHash)), true);
assert.equal(JSON.stringify(state), beforeState, "构建导出清单不得修改工作区状态");

const scriptManifest = buildDocumentExportManifest({ state, moduleId: "manuscript", viewId: "script" });
assert.equal(scriptManifest.documentCount, 2);
assert.deepEqual(scriptManifest.documents.map(({ documentId }) => documentId), ["script-2", "script-1"]);

for (const format of DOCUMENT_EXPORT_FORMATS) {
  const separate = createManuscriptExport({
    mode: "separate",
    format,
    title: "小说正文",
    documents: manifest.documents,
    documentCount: manifest.documentCount,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
  });
  assert.equal(separate.fileCount, 3, `${format} 分别导出数量`);
  assert.equal(separate.mimeType, "application/zip");
  const entries = zipEntries(separate.bytes);
  assert.equal(entries.length, 3, `${format} ZIP 文件数`);
  assert.equal(new Set(entries.map(({ name }) => name.toLocaleLowerCase())).size, 3, `${format} 同名文件不得覆盖`);

  const complete = createManuscriptExport({
    mode: "complete",
    format,
    title: "小说全本",
    documents: manifest.documents,
    documentCount: manifest.documentCount,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
  });
  assert.equal(complete.fileCount, 1, `${format} 全本导出数量`);
  assert.equal(complete.documentCount, 3);
  if (format === "pdf") assert.equal(complete.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  if (["docx", "screenplay"].includes(format)) {
    const documentXml = zipEntries(complete.bytes).find(({ name }) => name === "word/document.xml")?.content.toString("utf8") || "";
    assert.match(documentXml, /第2章 空章/u);
    assert.match(documentXml, /第1章 起点/u);
  }
  if (format === "epub") {
    const epubEntries = zipEntries(complete.bytes);
    assert.equal(epubEntries[0].name, "mimetype");
    assert.equal(epubEntries.filter(({ name }) => /^OEBPS\/chapter-\d+\.xhtml$/u.test(name)).length, 3);
    assert.equal(epubEntries.some(({ name }) => name === "OEBPS/nav.xhtml"), true);
  }
  if (format === "markdown") {
    const markdown = complete.bytes.toString("utf8");
    assert.ok(markdown.indexOf("第2章 空章") < markdown.indexOf("第1章 起点"));
    assert.equal((markdown.match(/# 第2章 空章/gu) || []).length, 1, "正文首行同名标题不得重复");
  }
  if (format === "text") assert.ok(complete.bytes.toString("utf8").indexOf("第2章 空章") < complete.bytes.toString("utf8").indexOf("第1章 起点"));
}

assert.throws(() => createManuscriptExport({
  mode: "complete",
  format: "docx",
  title: "错误清单",
  documents: [{ ...manifest.documents[0], text: "被篡改" }],
  documentCount: 1,
}), /校验失败/u);

assert.throws(() => createManuscriptExport({
  mode: "complete",
  format: "docx",
  title: "错误数量",
  documents: manifest.documents,
  documentCount: 2,
}), /数量/u);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /id="separateExportHeading">分别导出/u);
assert.match(appSource, /id="completeExportHeading">全本导出/u);
assert.equal((appSource.match(/data-export-mode="separate"/gu) || []).length, 6);
assert.equal((appSource.match(/data-export-mode="complete"/gu) || []).length, 6);

console.log("Shensi v2.82 manuscript export tests passed");
