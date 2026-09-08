import { sha256HexSync, stableVersionJson } from "./version-integrity.js";

const cleanText = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n");

const plainTextFromHtml = (value = "") => cleanText(value)
  .replace(/<br\s*\/?\s*>/giu, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/giu, "\n")
  .replace(/<[^>]+>/gu, "")
  .replace(/&nbsp;/giu, " ")
  .replace(/&lt;/giu, "<")
  .replace(/&gt;/giu, ">")
  .replace(/&amp;/giu, "&")
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

const itemView = (moduleId, item) => item?.[2]?.workspaceView ?? (moduleId === "manuscript" ? "novel" : "default");

export const documentExportContentPayload = (document = {}) => ({
  documentId: String(document.documentId || ""),
  title: String(document.title || ""),
  path: String(document.path || ""),
  text: cleanText(document.text),
  markdown: cleanText(document.markdown),
  order: Math.max(0, Number(document.order) || 0),
});

export const documentExportContentHash = (document = {}) => (
  sha256HexSync(stableVersionJson(documentExportContentPayload(document)))
);

export const buildDocumentExportManifest = ({
  state = {},
  moduleId = "manuscript",
  viewId = "novel",
  documentIds = null,
  scopeLabel = "",
  textForDocument = null,
  markdownForDocument = null,
  pathForDocument = null,
} = {}) => {
  const documents = state.documents && typeof state.documents === "object" ? state.documents : {};
  const moduleItems = Array.isArray(state.moduleItems?.[moduleId]) ? state.moduleItems[moduleId] : [];
  const itemById = new Map(moduleItems.map((item) => [item[0], item]));
  const requestedIds = Array.isArray(documentIds)
    ? documentIds
    : moduleItems.filter((item) => itemView(moduleId, item) === viewId && item?.[2]?.alias !== true).map((item) => item[0]);
  const seen = new Set();
  const snapshots = [];
  for (const documentId of requestedIds) {
    if (seen.has(documentId)) continue;
    seen.add(documentId);
    const documentState = documents[documentId];
    const item = itemById.get(documentId);
    if (!documentState || documentId === "library-trash" || item?.[2]?.alias === true) continue;
    if (documentState.virtual === true || documentState.documentKind === "whiteboard") continue;
    const title = String(documentState.title || item?.[1] || documentId || "未命名文档").trim() || "未命名文档";
    const markdown = cleanText(typeof markdownForDocument === "function"
      ? markdownForDocument(documentState, documentId)
      : documentState.markdown || plainTextFromHtml(documentState.html));
    const text = cleanText(typeof textForDocument === "function"
      ? textForDocument(documentState, documentId)
      : plainTextFromHtml(documentState.html) || markdown);
    const snapshot = documentExportContentPayload({
      documentId,
      title,
      path: typeof pathForDocument === "function" ? pathForDocument(documentId, documentState) : title,
      text,
      markdown,
      order: snapshots.length,
    });
    snapshots.push({ ...snapshot, contentHash: documentExportContentHash(snapshot) });
  }
  const manifestPayload = {
    schemaVersion: 1,
    moduleId: String(moduleId || ""),
    viewId: String(viewId || ""),
    scopeLabel: String(scopeLabel || ""),
    documentCount: snapshots.length,
    documents: snapshots,
  };
  return {
    ...manifestPayload,
    manifestHash: sha256HexSync(stableVersionJson(manifestPayload)),
  };
};
