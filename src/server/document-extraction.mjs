import { inflateRawSync } from "node:zlib";

const TEXT_LIMIT = 80_000;
const MAX_TEXT_LIMIT = 4_000_000;
const MAX_UNCOMPRESSED_ENTRY = 12 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL = 48 * 1024 * 1024;

const decodeXmlEntities = (value) => String(value ?? "")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&apos;", "'")
  .replaceAll("&amp;", "&");

const xmlText = (xml) => decodeXmlEntities(String(xml ?? "")
  .replace(/<w:tab\b[^>]*\/>/gi, "\t")
  .replace(/<a:br\b[^>]*\/>/gi, "\n")
  .replace(/<text:tab\b[^>]*\/>/gi, "\t")
  .replace(/<\/(?:w:p|a:p|text:p|text:h|row|si)>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim());

const findEndOfCentralDirectory = (bytes) => {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
};

export const unzipSelectedEntries = (bytes, predicate = () => true) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) return [];
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) return [];
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  let expanded = 0;
  const entries = [];
  for (let index = 0; index < entryCount && offset + 46 <= bytes.length; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!predicate(name) || name.endsWith("/") || uncompressedSize > MAX_UNCOMPRESSED_ENTRY) continue;
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_ENTRY });
    else continue;
    expanded += content.length;
    if (expanded > MAX_UNCOMPRESSED_TOTAL) throw new Error("压缩文档展开后过大，已停止解析");
    entries.push({ name, content });
  }
  return entries;
};

const naturalPathSort = (left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true });

const extractOpenXml = (bytes, maxCharacters = TEXT_LIMIT) => {
  const entries = unzipSelectedEntries(bytes, (name) => /\.xml$/i.test(name))
    .filter((entry) => /^(?:word\/|ppt\/slides\/|xl\/(?:sharedStrings|worksheets\/)|content\.xml)/i.test(entry.name))
    .sort(naturalPathSort);
  return entries.map((entry) => xmlText(entry.content.toString("utf8"))).filter(Boolean).join("\n\n").slice(0, maxCharacters);
};

const extractRtf = (bytes, maxCharacters = TEXT_LIMIT) => bytes.toString("utf8")
  .replace(/\\u(-?\d+)\??/g, (_, code) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65_536 : Number(code)))
  .replace(/\\'[\da-f]{2}/gi, " ")
  .replace(/\\[a-z]+-?\d* ?/gi, "")
  .replace(/[{}]/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim()
  .slice(0, maxCharacters);

export const extractDocumentText = ({ bytes, name = "", mimeType = "", maxCharacters = TEXT_LIMIT }) => {
  const limit = Math.min(MAX_TEXT_LIMIT, Math.max(TEXT_LIMIT, Number(maxCharacters) || TEXT_LIMIT));
  const fileName = String(name).toLowerCase();
  const textual = mimeType.startsWith("text/") || /\.(?:md|skill|txt|csv|json|xml|html?)$/i.test(fileName);
  if (textual) return { text: bytes.toString("utf8").slice(0, limit), extractionStatus: "extracted" };
  if (/\.rtf$/i.test(fileName)) return { text: extractRtf(bytes, limit), extractionStatus: "extracted" };
  if (/\.(?:docx|xlsx|pptx|odt|ods|odp|wps|et|dps)$/i.test(fileName) || bytes.subarray(0, 2).toString("ascii") === "PK") {
    try {
      const text = extractOpenXml(bytes, limit);
      if (text) return { text, extractionStatus: "extracted" };
    } catch (error) {
      return { text: "", extractionStatus: "binary_only", extractionError: error.message };
    }
  }
  return { text: "", extractionStatus: "binary_only" };
};
