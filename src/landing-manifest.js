import { contentRevision } from "./workspace-operations.js";

const text = (value = "", max = 240) => String(value ?? "").trim().slice(0, max);

const documentKind = (documentId = "", target = {}) => {
  if (/^chapter-\d+$/.test(documentId)) return "chapter";
  if (target?.moduleId === "outline") return "outline";
  if (target?.moduleId === "canon") return "canon";
  if (target?.moduleId === "memory") return "memory";
  if (target?.moduleId === "reports") return "report";
  if (target?.moduleId === "library") return "reference";
  return "document";
};

export const buildLandingManifest = ({
  source = "",
  documents = [],
  workspaceKind = "",
  workspacePath = "",
  workspaceName = "",
  batchLandingReceipt = null,
  projectionReceipt = null,
  createdAt = Date.now(),
} = {}) => {
  const receipts = new Map((batchLandingReceipt?.results ?? []).map((receipt) => [receipt.targetDocumentId, receipt]));
  const segments = (Array.isArray(documents) ? documents : [])
    .filter((document) => document?.documentId && typeof document.content === "string")
    .slice(0, 1000)
    .map((document, index) => {
      const content = String(document.content ?? "");
      const target = document.target ?? {};
      const receipt = receipts.get(document.documentId);
      const targetWorkspaceKind = text(receipt?.workspaceKind || target.workspaceKind || workspaceKind, 40);
      const targetWorkspacePath = text(receipt?.workspacePath || target.workspacePath || workspacePath, 500);
      const targetWorkspaceName = text(receipt?.workspaceName || target.workspaceName || workspaceName, 180);
      return {
        id: `segment-${String(index + 1).padStart(4, "0")}`,
        order: index + 1,
        documentId: text(document.documentId, 180),
        title: text(document.title ?? target.title ?? target.chapterTitle ?? document.documentId, 180),
        kind: documentKind(document.documentId, target),
        moduleId: text(target.moduleId || "", 80),
        viewId: text(target.viewId || "", 80),
        chapterNumber: Number(target.chapterNumber || document.documentId.match(/^chapter-(\d+)$/)?.[1] || 0) || null,
        characters: content.length,
        hash: contentRevision(content),
        ...(receipt ? {
          targetPath: text(receipt.targetPath, 500),
          operation: text(receipt.operation, 40),
          previousHash: text(receipt.previousHash, 160),
          writtenHash: text(receipt.writtenHash, 160),
          verifiedHash: text(receipt.verifiedHash, 160),
          receiptVerified: receipt.verified === true && receipt.writtenHash === receipt.verifiedHash,
          operationId: text(receipt.operationId, 160),
          requestedTitle: text(receipt.requestedTitle || document.title, 180),
          targetDirectoryId: text(receipt.targetDirectoryId || target.moduleId, 80),
          contentType: text(receipt.contentType, 80),
          versionId: text(receipt.versionId, 180),
          workspaceKind: targetWorkspaceKind,
          workspacePath: targetWorkspacePath,
          workspaceName: targetWorkspaceName,
          navigationTarget: {
            documentId: text(receipt.navigationTarget?.documentId || document.documentId, 180),
            moduleId: text(receipt.navigationTarget?.moduleId || target.moduleId, 80),
            workspaceKind: text(receipt.navigationTarget?.workspaceKind || targetWorkspaceKind, 40),
            workspacePath: text(receipt.navigationTarget?.workspacePath || targetWorkspacePath, 500),
            workspaceName: text(receipt.navigationTarget?.workspaceName || targetWorkspaceName, 180),
          },
        } : {}),
      };
    });
  return {
    schemaVersion: batchLandingReceipt ? 2 : 1,
    type: "longform_landing_manifest",
    createdAt,
    workspaceKind: text(workspaceKind, 40),
    workspacePath: text(workspacePath, 500),
    workspaceName: text(workspaceName, 180),
    sourceCharacters: String(source ?? "").length,
    segmentCount: segments.length,
    totalCharacters: segments.reduce((total, segment) => total + segment.characters, 0),
    segments,
    ...(batchLandingReceipt ? { batchLandingReceipt } : {}),
    ...(projectionReceipt ? { projectionReceipt } : {}),
  };
};

export const validateLandingManifest = (manifest, documents = []) => {
  const source = Array.isArray(documents) ? documents : [];
  if (!manifest || ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.segments)) return false;
  if (manifest.segments.length !== source.length) return false;
  if (manifest.schemaVersion === 2 && (manifest.batchLandingReceipt?.verified !== true
    || manifest.batchLandingReceipt?.failed !== 0
    || manifest.segments.some((segment) => segment.receiptVerified !== true))) return false;
  return manifest.segments.every((segment, index) => {
    const document = source[index];
    return segment.documentId === document?.documentId
      && segment.characters === String(document?.content ?? "").length
      && segment.hash === contentRevision(String(document?.content ?? ""));
  });
};
