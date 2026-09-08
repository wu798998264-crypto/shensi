import assert from "node:assert/strict";

import { documentExportContentHash } from "../src/document-export-contract.js";
import { createManuscriptExport, DOCUMENT_EXPORT_FORMATS } from "../src/server/document-export.mjs";

const zipEntries = (bytes) => {
  const source = Buffer.from(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= source.length && source.readUInt32LE(offset) === 0x04034b50) {
    const size = source.readUInt32LE(offset + 18);
    const nameLength = source.readUInt16LE(offset + 26);
    const extraLength = source.readUInt16LE(offset + 28);
    const nameOffset = offset + 30;
    const contentOffset = nameOffset + nameLength + extraLength;
    entries.push({
      name: source.subarray(nameOffset, nameOffset + nameLength).toString("utf8"),
      content: source.subarray(contentOffset, contentOffset + size),
    });
    offset = contentOffset + size;
  }
  return entries;
};

const documents = [
  { documentId: "chapter-2", title: "第2章 回声", text: "第二章正文。", order: 0 },
  { documentId: "chapter-1", title: "第1章 起点", text: "第一章正文。", order: 1 },
  { documentId: "chapter-3", title: "第3章 归途", text: "第三章正文。", order: 2 },
].map((document) => ({ ...document, contentHash: documentExportContentHash(document) }));

const createdAt = new Date("2026-08-24T00:00:00.000Z");
for (const format of DOCUMENT_EXPORT_FORMATS) {
  const separate = createManuscriptExport({
    mode: "separate",
    format,
    title: "作品分别导出",
    documents,
    documentCount: documents.length,
    createdAt,
  });
  assert.equal(separate.documentCount, documents.length, `${format} 分别导出文档数`);
  assert.equal(separate.fileCount, documents.length, `${format} 分别导出文件数`);
  assert.equal(separate.mimeType, "application/zip", `${format} 多文档分别导出必须打包`);
  const separateEntries = zipEntries(separate.bytes);
  assert.equal(separateEntries.length, documents.length, `${format} ZIP 条目数`);
  assert.equal(new Set(separateEntries.map(({ name }) => name.toLocaleLowerCase())).size, documents.length, `${format} 同名保护`);

  const complete = createManuscriptExport({
    mode: "complete",
    format,
    title: "作品全本",
    documents,
    documentCount: documents.length,
    createdAt,
  });
  assert.equal(complete.documentCount, documents.length, `${format} 全本导出文档数`);
  assert.equal(complete.fileCount, 1, `${format} 全本只应有一个文件`);
  if (format === "pdf") assert.equal(Buffer.from(complete.bytes).subarray(0, 5).toString("ascii"), "%PDF-", "PDF 必须可被阅读器识别");
  if (["markdown", "text"].includes(format)) {
    const text = Buffer.from(complete.bytes).toString("utf8");
    assert.ok(text.indexOf("第2章 回声") < text.indexOf("第1章 起点"), `${format} 必须保持目录顺序`);
    assert.ok(text.indexOf("第1章 起点") < text.indexOf("第3章 归途"), `${format} 必须保留全部章节`);
  }
  if (["docx", "screenplay"].includes(format)) {
    const xml = zipEntries(complete.bytes).find(({ name }) => name === "word/document.xml")?.content.toString("utf8") || "";
    assert.ok(xml.indexOf("第2章 回声") < xml.indexOf("第1章 起点"), `${format} 文档 XML 顺序`);
    assert.match(xml, /第3章 归途/u, `${format} 文档 XML 内容`);
  }
  if (format === "epub") {
    const entries = zipEntries(complete.bytes);
    assert.equal(entries[0]?.name, "mimetype", "EPUB mimetype 必须是首条目");
    assert.equal(entries.filter(({ name }) => /^OEBPS\/chapter-\d+\.xhtml$/u.test(name)).length, documents.length, "EPUB 必须包含每个章节");
  }
}

console.log("v3.0 导出矩阵测试通过");
