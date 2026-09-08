const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const xmlEscape = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const dosDateTime = (input = new Date()) => {
  const date = input instanceof Date && Number.isFinite(input.getTime()) ? input : new Date();
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
};

export const zipStore = (entries, createdAt = new Date()) => {
  const localParts = [];
  const centralParts = [];
  const stamp = dosDateTime(createdAt);
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf8");
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(stamp.time, 10);
    localHeader.writeUInt16LE(stamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(stamp.time, 12);
    centralHeader.writeUInt16LE(stamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const documentParagraphs = (text, { preset = "body" } = {}) => String(text ?? "")
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n")
  .split("\n")
  .map((line, index) => {
    if (line === "\f") return '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>';
    if (!line) return '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>';
    const titleLine = index === 0 && ["manuscript", "screenplay"].includes(preset);
    const sceneHeading = preset === "screenplay" && /^(?:INT\.|EXT\.|内景|外景|场景|第.{1,12}场)/iu.test(line.trim());
    const paragraphProperties = titleLine
      ? '<w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="280"/></w:pPr>'
      : `<w:pPr><w:spacing w:line="${preset === "screenplay" ? 300 : 360}" w:lineRule="auto" w:after="${sceneHeading ? 180 : 120}"/>${sceneHeading ? '<w:keepNext/>' : ""}</w:pPr>`;
    const runProperties = titleLine
      ? '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>'
      : sceneHeading ? '<w:rPr><w:b/></w:rPr>' : "";
    return `<w:p>${paragraphProperties}<w:r>${runProperties}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
  })
  .join("");

export const whiteboardExportFileName = ({ title = "", text = "", extension = "docx" } = {}) => {
  const firstLine = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const stem = String(title || firstLine || "白板卡片")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80) || "白板卡片";
  const safeExtension = String(extension || "docx").replace(/[^a-z0-9]/gi, "").toLowerCase() || "docx";
  return `${stem}.${safeExtension}`;
};

export const createWhiteboardDocx = ({ text = "", title = "", createdAt = new Date(), preset = "body" } = {}) => {
  const normalizedText = String(text ?? "");
  const fileName = whiteboardExportFileName({ title, text: normalizedText, extension: "docx" });
  const documentTitle = fileName.replace(/\.docx$/i, "");
  const isoDate = (createdAt instanceof Date && Number.isFinite(createdAt.getTime()) ? createdAt : new Date()).toISOString();
  const entries = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${DOCX_MIME_TYPE}.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    },
    {
      name: "docProps/core.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(documentTitle)}</dc:title><dc:creator>神思创作引擎</dc:creator><cp:lastModifiedBy>神思创作引擎</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>神思创作引擎</Application><AppVersion>1.0</AppVersion></Properties>',
    },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentParagraphs(normalizedText, { preset })}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="${preset === "screenplay" ? 1260 : 1440}" w:bottom="1440" w:left="${preset === "screenplay" ? 1800 : 1440}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    },
    {
      name: "word/styles.xml",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="宋体" w:hAnsi="SimSun"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="正文"/><w:qFormat/></w:style></w:styles>',
    },
    {
      name: "word/_rels/document.xml.rels",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    },
  ];
  return { bytes: zipStore(entries, createdAt), fileName, mimeType: DOCX_MIME_TYPE };
};

const safePathSegment = (value, fallback = "未命名") => String(value ?? "")
  .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
  .replace(/\s+/g, " ")
  .replace(/[. ]+$/g, "")
  .trim()
  .slice(0, 80) || fallback;

const safeRelativeDocxPath = (value, fallbackTitle) => {
  const segments = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => safePathSegment(segment, "未命名"))
    .filter(Boolean);
  const fileName = safePathSegment(segments.pop() || fallbackTitle || "未命名文档").replace(/\.docx$/i, "");
  return [...segments, `${fileName}.docx`].join("/");
};

const safeRelativeMarkdownPath = (value, fallbackTitle) => {
  const segments = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => safePathSegment(segment, "未命名"))
    .filter(Boolean);
  const fileName = safePathSegment(segments.pop() || fallbackTitle || "未命名文档").replace(/\.md$/i, "");
  return [...segments, `${fileName}.md`].join("/");
};

export const createDocumentDocx = ({ text = "", title = "", createdAt = new Date(), preset = "body" } = {}) => (
  createWhiteboardDocx({ text, title: title || "未命名文档", createdAt, preset })
);

export const createScreenplayDocx = ({ text = "", title = "", createdAt = new Date() } = {}) => (
  createDocumentDocx({ text, title, createdAt, preset: "screenplay" })
);

export const createMarkdownDocument = ({ markdown = "", title = "" } = {}) => {
  const normalized = String(markdown ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trimEnd();
  return {
    bytes: Buffer.from(`${normalized}\n`, "utf8"),
    fileName: `${safePathSegment(title, "未命名文档").replace(/\.md$/i, "")}.md`,
    mimeType: "text/markdown; charset=utf-8",
  };
};

export const createDocumentBundle = ({ documents = [], title = "神思导出", createdAt = new Date() } = {}) => {
  const source = Array.isArray(documents) ? documents : [];
  if (!source.length) throw new Error("没有可导出的文档");
  const usedPaths = new Set();
  const entries = source.map((document, index) => {
    const documentTitle = safePathSegment(document?.title, `未命名文档 ${index + 1}`);
    const requestedPath = safeRelativeDocxPath(document?.path, documentTitle);
    let path = requestedPath;
    let suffix = 2;
    while (usedPaths.has(path.toLowerCase())) {
      path = requestedPath.replace(/\.docx$/i, ` (${suffix}).docx`);
      suffix += 1;
    }
    usedPaths.add(path.toLowerCase());
    const docx = createDocumentDocx({ text: String(document?.text ?? ""), title: documentTitle, createdAt });
    return { name: path, content: docx.bytes };
  });
  const fileName = `${safePathSegment(title, "神思导出")}.zip`;
  return { bytes: zipStore(entries, createdAt), fileName, mimeType: "application/zip" };
};

export const createMarkdownBundle = ({ documents = [], title = "神思导出", createdAt = new Date() } = {}) => {
  const source = Array.isArray(documents) ? documents : [];
  if (!source.length) throw new Error("没有可导出的文档");
  const usedPaths = new Set();
  const entries = source.map((document, index) => {
    const documentTitle = safePathSegment(document?.title, `未命名文档 ${index + 1}`);
    const requestedPath = safeRelativeMarkdownPath(document?.path, documentTitle);
    let path = requestedPath;
    let suffix = 2;
    while (usedPaths.has(path.toLowerCase())) {
      path = requestedPath.replace(/\.md$/i, ` (${suffix}).md`);
      suffix += 1;
    }
    usedPaths.add(path.toLowerCase());
    return {
      name: path,
      content: createMarkdownDocument({ markdown: String(document?.markdown ?? ""), title: documentTitle }).bytes,
    };
  });
  const fileName = `${safePathSegment(title, "神思导出")}.zip`;
  return { bytes: zipStore(entries, createdAt), fileName, mimeType: "application/zip" };
};
