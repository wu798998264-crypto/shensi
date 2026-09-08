const ALLOWED_TAGS = new Set([
  "A", "B", "BLOCKQUOTE", "BR", "CODE", "COL", "COLGROUP", "DD", "DEL", "DIV", "DL", "DT",
  "EM", "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "I", "IMG", "LI", "OL", "P", "PRE", "S",
  "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD",
  "TR", "U", "UL", "VIDEO",
]);

const GLOBAL_ATTRIBUTES = new Set(["data-align"]);
const TAG_ATTRIBUTES = {
  A: new Set(["href", "title"]),
  COL: new Set(["data-column-width"]),
  DIV: new Set(["class", "data-markdown-table"]),
  FIGURE: new Set(["class", "contenteditable", "data-artifact-id", "data-artifact-status", "data-generation-job-id"]),
  IMG: new Set(["alt", "data-attachment-path", "loading", "src", "title"]),
  TABLE: new Set(["data-resizable-table"]),
  SPAN: new Set(["style"]),
  TD: new Set(["colspan", "rowspan", "data-align"]),
  TH: new Set(["colspan", "rowspan", "data-align"]),
  TR: new Set(["data-row-height"]),
  VIDEO: new Set(["aria-label", "controls", "data-attachment-path", "muted", "playsinline", "preload", "src"]),
};

const TAG_CLASSES = {
  DIV: new Set(["markdown-table-wrap"]),
  FIGURE: new Set(["document-image"]),
};

const VOID_TAGS = new Set(["BR", "COL", "HR", "IMG"]);

const safeNavigationUrl = (value = "") => {
  const source = String(value).trim();
  return /^(https?:|mailto:|#|\/(?!\/))/i.test(source);
};

const safeAttachmentPath = (value = "") => {
  const source = String(value).trim().replaceAll("\\", "/");
  if (!source || source.startsWith("/") || /^[a-z]:/i.test(source) || source.includes("\u0000")) return false;
  const parts = source.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && parts[0].toLowerCase() !== ".shensi";
};

const safeInlineColorStyle = (value = "") => {
  const declarations = String(value || "").split(";").map((part) => part.trim()).filter(Boolean);
  const safe = [];
  for (const declaration of declarations) {
    const match = declaration.match(/^(color|background-color)\s*:\s*(#[0-9a-f]{3,8}|rgba?\(\s*[\d. %]+(?:\s*,\s*[\d. %]+){2,3}\s*\)|transparent)$/iu);
    if (!match) continue;
    safe.push(`${match[1].toLowerCase()}: ${match[2].toLowerCase()}`);
  }
  return safe.join("; ");
};

const normalizedAttributeValue = (tag, name, value) => {
  const allowed = new Set([...(TAG_ATTRIBUTES[tag] ?? []), ...GLOBAL_ATTRIBUTES]);
  if (name.startsWith("on") || name === "srcdoc" || name === "src" || !allowed.has(name)) return null;
  if (name === "style") {
    const safeStyle = tag === "SPAN" ? safeInlineColorStyle(value) : "";
    return safeStyle || null;
  }
  if (name === "href" && !safeNavigationUrl(value)) return null;
  if (name === "data-attachment-path" && !safeAttachmentPath(value)) return null;
  if (["data-artifact-id", "data-generation-job-id"].includes(name) && !/^[A-Za-z0-9:_-]{1,180}$/.test(value)) return null;
  if (name === "data-artifact-status" && !["planned", "queued", "submitting", "running", "polling", "downloading", "cancel_requested", "complete", "retry_required", "reconciliation_required", "waiting_credentials", "waiting_storage", "cancelled", "failed"].includes(value)) return null;
  if (name === "class") {
    const classes = value.split(/\s+/).filter((className) => TAG_CLASSES[tag]?.has(className));
    return classes.length ? [...new Set(classes)].join(" ") : null;
  }
  if (name === "contenteditable" && value !== "false") return null;
  if (name === "loading" && !["eager", "lazy"].includes(value)) return null;
  if (name === "preload" && !["auto", "metadata", "none"].includes(value)) return null;
  if (["colspan", "rowspan"].includes(name)) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 20) return null;
  }
  if (name === "data-column-width") {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 64 || number > 1600) return null;
  }
  if (name === "data-row-height") {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 28 || number > 1200) return null;
  }
  if (["data-markdown-table", "data-resizable-table"].includes(name) && value !== "true") return null;
  return value;
};

const sanitizeElement = (element, documentRef) => {
  for (const child of Array.from(element.children)) sanitizeElement(child, documentRef);
  const tag = element.tagName;
  if (!ALLOWED_TAGS.has(tag)) {
    element.replaceWith(...Array.from(element.childNodes));
    return;
  }
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    const normalized = normalizedAttributeValue(tag, name, value);
    if (normalized == null) element.removeAttribute(attribute.name);
    else if (normalized !== value) element.setAttribute(attribute.name, normalized);
  }
  if (tag === "A" && element.hasAttribute("href")) element.setAttribute("rel", "noreferrer");
};

const sanitizeWithDom = (html = "", documentRef = globalThis.document) => {
  const template = documentRef.createElement("template");
  template.innerHTML = String(html ?? "");
  for (const child of Array.from(template.content.children)) sanitizeElement(child, documentRef);
  return template.innerHTML;
};

const decodeAttributeEntities = (value = "") => String(value)
  .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (match, hexadecimal, decimal) => {
    const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
    try { return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ""; } catch { return ""; }
  })
  .replace(/&(amp|quot|apos|lt|gt);/gi, (match, entity) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity.toLowerCase()]);

const escapeAttributeValue = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const tagEndIndex = (source, start) => {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
};

const parseSafeAttributes = (tag, source = "") => {
  const attributes = new Map();
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (cursor >= source.length || source[cursor] === "/") break;
    const nameStart = cursor;
    while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) cursor += 1;
    const name = source.slice(nameStart, cursor).toLowerCase();
    if (!name) { cursor += 1; continue; }
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(source[cursor] || "")) cursor += 1;
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor++] : "";
      const valueStart = cursor;
      if (quote) {
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        if (cursor >= source.length) break;
        value = source.slice(valueStart, cursor);
        cursor += 1;
      } else {
        while (cursor < source.length && !/[\s>]/.test(source[cursor])) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
    }
    if (attributes.has(name)) continue;
    const normalized = normalizedAttributeValue(tag, name, decodeAttributeEntities(value));
    if (normalized != null) attributes.set(name, normalized);
  }
  return attributes;
};

const sanitizeWithoutDom = (html = "") => {
  const source = String(html ?? "");
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart < 0) return output + source.slice(cursor);
    output += source.slice(cursor, tagStart);
    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    const tagEnd = tagEndIndex(source, tagStart);
    if (tagEnd < 0) return `${output}&lt;${source.slice(tagStart + 1)}`;
    const token = source.slice(tagStart, tagEnd + 1);
    const parsed = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b([\s\S]*?)>$/);
    if (!parsed) {
      output += "&lt;";
      cursor = tagStart + 1;
      continue;
    }
    const closing = Boolean(parsed[1]);
    const tag = parsed[2].toUpperCase();
    cursor = tagEnd + 1;
    if (!ALLOWED_TAGS.has(tag)) continue;
    const tagName = tag.toLowerCase();
    if (closing) {
      if (!VOID_TAGS.has(tag)) output += `</${tagName}>`;
      continue;
    }
    const attributes = parseSafeAttributes(tag, parsed[3]);
    if (tag === "A" && attributes.has("href")) attributes.set("rel", "noreferrer");
    const serializedAttributes = [...attributes.entries()]
      .map(([name, value]) => ` ${name}="${escapeAttributeValue(value)}"`).join("");
    output += `<${tagName}${serializedAttributes}>`;
  }
  return output;
};

export const sanitizeDocumentHtml = (html = "") => {
  if (globalThis.document?.createElement) return sanitizeWithDom(html, globalThis.document);
  return sanitizeWithoutDom(html);
};
