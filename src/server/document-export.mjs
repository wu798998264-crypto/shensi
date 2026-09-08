import { documentExportContentHash } from "../document-export-contract.js";
import {
  createDocumentDocx,
  createMarkdownDocument,
  createScreenplayDocx,
  zipStore,
} from "./docx-export.mjs";

export const DOCUMENT_EXPORT_FORMATS = Object.freeze(["docx", "pdf", "markdown", "text", "screenplay", "epub"]);
export const DOCUMENT_EXPORT_MODES = Object.freeze(["separate", "complete"]);

const FORMAT_METADATA = Object.freeze({
  docx: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pdf: { extension: ".pdf", mimeType: "application/pdf" },
  markdown: { extension: ".md", mimeType: "text/markdown; charset=utf-8" },
  text: { extension: ".txt", mimeType: "text/plain; charset=utf-8" },
  screenplay: { extension: ".docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  epub: { extension: ".epub", mimeType: "application/epub+zip" },
});

const cleanLines = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n").trim();
const compactTitle = (value = "", fallback = "未命名文档") => String(value || fallback)
  .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
  .replace(/\s+/gu, " ")
  .replace(/[. ]+$/gu, "")
  .trim()
  .slice(0, 100) || fallback;

const xmlEscape = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const normalizedTitle = (value = "") => String(value).replace(/^#{1,6}\s*/u, "").replace(/[\s　]+/gu, "").trim();
const withoutLeadingTitle = (value = "", title = "") => {
  const lines = cleanLines(value).split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first >= 0 && normalizedTitle(lines[first]) === normalizedTitle(title)) lines.splice(first, 1);
  return lines.join("\n").trim();
};

const normalizedDocument = (document = {}, index = 0) => ({
  documentId: String(document.documentId || `document-${index + 1}`).slice(0, 200),
  title: compactTitle(document.title, `未命名文档 ${index + 1}`),
  path: String(document.path || document.title || `未命名文档 ${index + 1}`).slice(0, 500),
  text: String(document.text ?? "").replace(/\r\n?/g, "\n"),
  markdown: String(document.markdown ?? "").replace(/\r\n?/g, "\n"),
  order: Math.max(0, Number(document.order) || index),
  contentHash: String(document.contentHash || ""),
});

export const validateDocumentExportRequest = ({ mode = "", format = "", documents = [], documentCount = 0 } = {}) => {
  if (!DOCUMENT_EXPORT_MODES.includes(mode)) throw new Error("导出模式无效");
  if (!DOCUMENT_EXPORT_FORMATS.includes(format)) throw new Error("导出格式无效");
  if (!Array.isArray(documents) || !documents.length) throw new Error("没有可导出的文档");
  if (documents.length > 5000) throw new Error("单次导出不能超过 5000 个文档");
  if (Number(documentCount) !== documents.length) throw new Error("导出清单数量与页面显示数量不一致");
  for (const document of documents) {
    const expectedHash = documentExportContentHash(document);
    if (!document?.contentHash || document.contentHash !== expectedHash) throw new Error(`文档“${document?.title || "未命名文档"}”导出快照校验失败`);
  }
  const normalized = documents.map(normalizedDocument).sort((left, right) => left.order - right.order);
  const totalCharacters = normalized.reduce((total, document) => total + document.text.length + document.markdown.length, 0);
  if (totalCharacters > 20_000_000) throw new Error("本次导出内容超过两千万字，请缩小导出层级");
  return normalized;
};

const documentText = (document) => [document.title, withoutLeadingTitle(document.text || document.markdown, document.title)]
  .filter((part, index) => index === 0 || part)
  .join("\n\n");

const documentMarkdown = (document) => [`# ${document.title}`, withoutLeadingTitle(document.markdown || document.text, document.title)]
  .filter((part, index) => index === 0 || part)
  .join("\n\n");

const utf16BeHex = (value = "") => {
  let result = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    const safe = code > 0xffff ? 0x003f : code;
    result += safe.toString(16).padStart(4, "0");
  }
  return result.toUpperCase();
};

const pdfMetadataHex = (value = "") => `FEFF${utf16BeHex(value)}`;

const wrappedPdfLines = (value = "", width = 38) => cleanLines(value).split("\n").flatMap((line) => {
  if (!line) return [""];
  const characters = [...line];
  const output = [];
  while (characters.length) output.push(characters.splice(0, width).join(""));
  return output;
});

const pdfPages = (documents) => documents.flatMap((document) => {
  const lines = wrappedPdfLines(documentText(document));
  const pages = [];
  while (lines.length) pages.push(lines.splice(0, 38));
  return pages.length ? pages : [[document.title]];
});

export const createPdfExport = ({ documents = [], title = "神思导出" } = {}) => {
  const pages = pdfPages(documents);
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`,
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>] >>",
  ];
  pages.forEach((lines, index) => {
    const pageNumber = pageObjectNumbers[index];
    const contentNumber = pageNumber + 1;
    const commands = ["BT", "/F1 12 Tf", "18 TL", "56 790 Td"];
    lines.forEach((line, lineIndex) => {
      if (lineIndex) commands.push("T*");
      commands.push(`<${utf16BeHex(line)}> Tj`);
    });
    commands.push("ET");
    const stream = Buffer.from(commands.join("\n"), "ascii");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"), stream, Buffer.from("\nendstream", "ascii")]));
  });
  objects.push(`<< /Title <${pdfMetadataHex(title)}> /Producer <${pdfMetadataHex("神思创作引擎")}> >>`);
  const infoObjectNumber = objects.length;
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const parts = [header];
  const offsets = [0];
  let offset = header.length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "ascii");
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "ascii"), body, Buffer.from("\nendobj\n", "ascii")]);
    parts.push(entry);
    offset += entry.length;
  });
  const xrefOffset = offset;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f ", ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `)].join("\n");
  const trailer = `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObjectNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref + trailer, "ascii")]);
};

const xhtmlParagraphs = (value = "") => cleanLines(value).split("\n")
  .map((line) => line ? `<p>${xmlEscape(line)}</p>` : "<p>&#160;</p>")
  .join("");

export const createEpubExport = ({ documents = [], title = "神思导出", createdAt = new Date() } = {}) => {
  const source = documents.length ? documents : [{ title: "未命名文档", text: "" }];
  const identifier = `urn:shensi:${documentExportContentHash({
    documentId: "epub",
    title,
    path: "",
    text: source.map(documentText).join("\n"),
    markdown: "",
    order: 0,
  }).slice(0, 24)}`;
  const chapters = source.map((document, index) => ({
    id: `chapter-${index + 1}`,
    href: `chapter-${index + 1}.xhtml`,
    title: document.title,
    content: withoutLeadingTitle(document.text || document.markdown, document.title),
  }));
  const entries = [
    { name: "mimetype", content: "application/epub+zip" },
    { name: "META-INF/container.xml", content: '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: "OEBPS/style.css", content: "body{font-family:serif;line-height:1.75;margin:6%;}h1{text-align:center;font-size:1.6em;}p{margin:.6em 0;}" },
    { name: "OEBPS/nav.xhtml", content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xmlEscape(title)}</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${chapters.map((chapter) => `<li><a href="${chapter.href}">${xmlEscape(chapter.title)}</a></li>`).join("")}</ol></nav></body></html>` },
    { name: "OEBPS/content.opf", content: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${identifier}</dc:identifier><dc:title>${xmlEscape(title)}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${createdAt.toISOString().replace(/\.\d{3}Z$/u, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>${chapters.map((chapter) => `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("")}</spine></package>` },
    ...chapters.map((chapter) => ({ name: `OEBPS/${chapter.href}`, content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>${xmlEscape(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>${xmlEscape(chapter.title)}</h1>${xhtmlParagraphs(chapter.content)}</body></html>` })),
  ];
  return zipStore(entries, createdAt);
};

const createSingleFormat = ({ document, format, createdAt }) => {
  const metadata = FORMAT_METADATA[format];
  const text = documentText(document);
  const markdown = documentMarkdown(document);
  if (format === "docx") return { ...createDocumentDocx({ text, title: document.title, createdAt, preset: "manuscript" }), extension: metadata.extension };
  if (format === "screenplay") return { ...createScreenplayDocx({ text, title: document.title, createdAt }), extension: metadata.extension };
  if (format === "pdf") return { bytes: createPdfExport({ documents: [document], title: document.title }), fileName: `${compactTitle(document.title)}.pdf`, mimeType: metadata.mimeType, extension: metadata.extension };
  if (format === "epub") return { bytes: createEpubExport({ documents: [document], title: document.title, createdAt }), fileName: `${compactTitle(document.title)}.epub`, mimeType: metadata.mimeType, extension: metadata.extension };
  if (format === "markdown") return { ...createMarkdownDocument({ markdown, title: document.title }), extension: metadata.extension };
  return { bytes: Buffer.from(`${text}\n`, "utf8"), fileName: `${compactTitle(document.title)}.txt`, mimeType: metadata.mimeType, extension: metadata.extension };
};

const safeRelativePath = (value, title, extension) => {
  const parts = String(value || title).replaceAll("\\", "/").split("/").map((part) => compactTitle(part)).filter(Boolean);
  const stem = compactTitle(parts.pop() || title).replace(/\.[a-z\d]{1,8}$/iu, "");
  return [...parts, `${stem}${extension}`].join("/");
};

const uniqueBundleEntries = ({ documents, format, createdAt }) => {
  const used = new Set();
  return documents.map((document) => {
    const generated = createSingleFormat({ document, format, createdAt });
    const requested = safeRelativePath(document.path, document.title, generated.extension);
    let name = requested;
    let suffix = 2;
    while (used.has(name.toLocaleLowerCase())) {
      name = requested.replace(new RegExp(`${generated.extension.replace(".", "\\.")}$`, "iu"), ` (${suffix})${generated.extension}`);
      suffix += 1;
    }
    used.add(name.toLocaleLowerCase());
    return { name, content: generated.bytes };
  });
};

const createCompleteFormat = ({ documents, format, title, createdAt }) => {
  const metadata = FORMAT_METADATA[format];
  const stem = compactTitle(title, "神思全本");
  if (format === "pdf") return { bytes: createPdfExport({ documents, title: stem }), fileName: `${stem}.pdf`, mimeType: metadata.mimeType };
  if (format === "epub") return { bytes: createEpubExport({ documents, title: stem, createdAt }), fileName: `${stem}.epub`, mimeType: metadata.mimeType };
  if (format === "markdown") {
    const markdown = documents.map(documentMarkdown).join("\n\n---\n\n");
    return { ...createMarkdownDocument({ markdown, title: stem }), fileName: `${stem}.md` };
  }
  const text = documents.map(documentText).join("\n\n\f\n\n");
  if (format === "docx") return { ...createDocumentDocx({ text, title: stem, createdAt, preset: "manuscript" }), fileName: `${stem}.docx` };
  if (format === "screenplay") return { ...createScreenplayDocx({ text, title: stem, createdAt }), fileName: `${stem}.docx` };
  return { bytes: Buffer.from(`${text}\n`, "utf8"), fileName: `${stem}.txt`, mimeType: metadata.mimeType };
};

export const createManuscriptExport = ({ mode, format, title = "神思导出", documents, documentCount, createdAt = new Date() } = {}) => {
  const source = validateDocumentExportRequest({ mode, format, documents, documentCount });
  if (mode === "complete") return {
    ...createCompleteFormat({ documents: source, format, title, createdAt }),
    mode,
    format,
    fileCount: 1,
    documentCount: source.length,
  };
  if (source.length === 1) return {
    ...createSingleFormat({ document: source[0], format, createdAt }),
    mode,
    format,
    fileCount: 1,
    documentCount: 1,
  };
  const entries = uniqueBundleEntries({ documents: source, format, createdAt });
  return {
    bytes: zipStore(entries, createdAt),
    fileName: `${compactTitle(title, "神思分别导出")}.zip`,
    mimeType: "application/zip",
    mode,
    format,
    fileCount: entries.length,
    documentCount: source.length,
  };
};
