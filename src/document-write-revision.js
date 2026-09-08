import { contentRevision } from "./workspace-operations.js";

const stableItem = (item) => Array.isArray(item)
  ? [String(item[0] ?? ""), String(item[1] ?? "").replace(/\s+/gu, " ").trim(), item[2] && typeof item[2] === "object" ? item[2] : null]
  : null;

export const formalDocumentWriteRevision = ({ documentId = "", document = null, item = null } = {}) => {
  if (!document) return "";
  return contentRevision(JSON.stringify({
    title: String(document.title || ""),
    html: String(document.html || ""),
    item: stableItem(item),
  }));
};

export const documentItemForWriteRevision = ({ state = {}, documentId = "" } = {}) => {
  const id = String(documentId || "");
  for (const items of Object.values(state.moduleItems ?? {})) {
    const item = Array.isArray(items) ? items.find((entry) => entry?.[0] === id) : null;
    if (item) return item;
  }
  return null;
};

export const formalDocumentWriteRevisionFromState = (state = {}, documentId = "") => formalDocumentWriteRevision({
  documentId,
  document: state.documents?.[documentId] ?? null,
  item: documentItemForWriteRevision({ state, documentId }),
});
