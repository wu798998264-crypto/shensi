import { sequencedDocumentKind, sequencedDocumentLabel } from "./document-title-policy.js";

const value = (input = "") => String(input ?? "").trim();
const internalDocumentId = (candidate = "") => /^(?:note|document|chapter)-\d{8,}$/u.test(value(candidate));
const LARGE_BATCH_LINK_THRESHOLD = 10;

const titleFromPath = (candidate = "") => {
  const part = value(candidate).split(/[\\/]/u).filter(Boolean).at(-1) || "";
  return part.replace(/\.[^.]+$/u, "").trim();
};

const currentDocumentDisplayTitle = (documentId = "", documentState = null) => {
  const title = value(documentState?.title);
  if (!title) return "";
  return sequencedDocumentKind(documentId)
    ? sequencedDocumentLabel({
      documentId,
      title,
      language: documentState?.titleLanguage || "zh-CN",
      documentState,
    })
    : title;
};

const sectionLabel = (segment = {}) => {
  const viewId = value(segment.viewId);
  if (viewId === "script") return "剧本";
  if (viewId === "novel") return "小说正文";
  if (/prompt/u.test(viewId) || /prompt/u.test(value(segment.contentType))) return "提示词";
  const moduleId = value(segment.moduleId || segment.targetDirectoryId);
  return ({ manuscript: "正文", outline: "大纲", canon: "设定", memory: "记忆", reports: "报告", library: "资料" })[moduleId]
    || "文档";
};

export const verifiedLandingDocumentLinksForManifest = ({ manifest = null, documents = {} } = {}) => {
  const receipt = manifest?.batchLandingReceipt;
  if (manifest?.schemaVersion !== 2 || receipt?.verified !== true || receipt?.failed !== 0) return [];
  const verifiedResults = (receipt.results ?? []).filter((item) => item?.verified === true && item.writtenHash === item.verifiedHash);
  const verifiedIds = new Set(verifiedResults.map((item) => value(item.targetDocumentId)));
  const receiptByDocumentId = new Map(verifiedResults.map((item) => [value(item.targetDocumentId), item]));
  return (manifest.segments ?? [])
    .filter((segment) => segment?.receiptVerified === true && verifiedIds.has(value(segment.documentId)))
    .map((segment) => {
      const documentId = value(segment.navigationTarget?.documentId || segment.documentId);
      const receiptItem = receiptByDocumentId.get(value(segment.documentId));
      const candidates = [
        currentDocumentDisplayTitle(documentId, documents?.[documentId]),
        receiptItem?.requestedTitle,
        receiptItem?.title,
        segment.requestedTitle,
        segment.title,
        titleFromPath(receiptItem?.targetPath || segment.targetPath),
      ].map(value);
      const title = candidates.find((candidate) => candidate && candidate !== documentId && !internalDocumentId(candidate)) || "";
      return {
        documentId,
        title,
        ...value(receiptItem?.workspaceKind || segment.navigationTarget?.workspaceKind || segment.workspaceKind || manifest.workspaceKind)
          ? { workspaceKind: value(receiptItem?.workspaceKind || segment.navigationTarget?.workspaceKind || segment.workspaceKind || manifest.workspaceKind) }
          : {},
        ...value(receiptItem?.workspacePath || segment.navigationTarget?.workspacePath || segment.workspacePath || manifest.workspacePath)
          ? { workspacePath: value(receiptItem?.workspacePath || segment.navigationTarget?.workspacePath || segment.workspacePath || manifest.workspacePath) }
          : {},
        ...value(receiptItem?.workspaceName || segment.navigationTarget?.workspaceName || segment.workspaceName || manifest.workspaceName)
          ? { workspaceName: value(receiptItem?.workspaceName || segment.navigationTarget?.workspaceName || segment.workspaceName || manifest.workspaceName) }
          : {},
      };
    })
    .filter((item, index, items) => item.documentId && item.title && items.findIndex((candidate) => candidate.documentId === item.documentId) === index);
};

export const verifyLandingDelivery = ({ manifest = null, documents = {}, expectedDocumentIds = [] } = {}) => {
  const expectedIds = [...new Set(expectedDocumentIds.map(value).filter(Boolean))];
  const receipt = manifest?.batchLandingReceipt;
  const verifiedResults = (receipt?.results ?? [])
    .filter((item) => item?.verified === true && item.writtenHash === item.verifiedHash);
  const verifiedIds = new Set(verifiedResults.map((item) => value(item.targetDocumentId)));
  const missingReceipts = expectedIds.filter((documentId) => !verifiedIds.has(documentId));
  const links = verifiedLandingDocumentLinksForManifest({ manifest, documents });
  const linkIds = new Set(links.map((item) => item.documentId));
  const receiptById = new Map(verifiedResults.map((item) => [value(item.targetDocumentId), item]));
  const segmentById = new Map((manifest?.segments ?? []).map((item) => [value(item.documentId), item]));
  const requiresIndividualLinks = expectedIds.length > 0 && expectedIds.length <= LARGE_BATCH_LINK_THRESHOLD;
  const missingLinks = requiresIndividualLinks ? expectedIds.filter((documentId) => !linkIds.has(documentId)) : [];
  const invalidLinks = links.filter((item) => (
    !item.title
    || !item.workspacePath
    || !["project", "notebook"].includes(item.workspaceKind)
  ));
  const mismatchedTitles = links.filter((item) => {
    const segment = segmentById.get(item.documentId);
    const receiptItem = receiptById.get(item.documentId);
    const expectedTitle = [
      currentDocumentDisplayTitle(item.documentId, documents?.[item.documentId]),
      receiptItem?.requestedTitle,
      receiptItem?.title,
      segment?.requestedTitle,
      segment?.title,
    ].map(value).find((candidate) => candidate && candidate !== item.documentId && !internalDocumentId(candidate));
    return expectedTitle && item.title !== expectedTitle;
  });
  const ok = manifest?.schemaVersion === 2
    && receipt?.verified === true
    && receipt?.failed === 0
    && expectedIds.length > 0
    && missingReceipts.length === 0
    && missingLinks.length === 0
    && invalidLinks.length === 0
    && mismatchedTitles.length === 0;
  return {
    ok,
    links,
    missingReceipts,
    missingLinks,
    invalidLinks,
    mismatchedTitles,
    reason: ok ? "" : [
      manifest?.schemaVersion !== 2 ? "缺少第二版落盘清单" : "",
      receipt?.verified !== true || receipt?.failed !== 0 ? "批次回读校验未通过" : "",
      !expectedIds.length ? "没有明确目标文档" : "",
      missingReceipts.length ? `缺少文档回执：${missingReceipts.join("、")}` : "",
      missingLinks.length ? `缺少跳转链接：${missingLinks.join("、")}` : "",
      invalidLinks.length ? "跳转链接缺少标题或工作区定位信息" : "",
      mismatchedTitles.length ? "跳转链接标题与文档当前名称不一致" : "",
    ].filter(Boolean).join("；"),
  };
};

export const verifiedLandingManifestReceipt = ({ result = null, documents = {} } = {}) => {
  if ([result?.landingStatus, result?.engineExecution?.status, result?.execution?.status]
    .some((status) => ["verification_pending", "commit_unknown"].includes(status))) return false;
  const manifest = result?.landingManifest;
  const receipt = result?.landingReceipt ?? manifest?.batchLandingReceipt;
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : [];
  const results = Array.isArray(receipt?.results) ? receipt.results : [];
  const delivery = verifyLandingDelivery({
    manifest,
    documents,
    expectedDocumentIds: segments.map((segment) => segment?.documentId),
  });
  const verifiedByDocumentId = new Map(results
    .filter((item) => item?.verified === true && item.writtenHash === item.verifiedHash)
    .map((item) => [value(item.targetDocumentId), item]));
  // A single direct document commit can legitimately share one native
  // transaction with derived state such as the update log.  Those additional
  // verified receipts must not make the direct landing look failed merely
  // because receipt.results is longer than manifest.segments.
  return result?.commitFailed !== true
    && manifest?.schemaVersion === 2
    && receipt?.verified === true
    && receipt?.failed === 0
    && segments.length > 0
    && results.length >= segments.length
    && results.every((item) => item?.verified === true && item.writtenHash === item.verifiedHash)
    && segments.every((segment) => segment?.receiptVerified === true
      && verifiedByDocumentId.has(value(segment.documentId)))
    && delivery.ok;
};

export const landingReceiptPresentation = ({ manifest = null, documents = {}, workspaceKind = "project", workspaceName = "" } = {}) => {
  const links = verifiedLandingDocumentLinksForManifest({ manifest, documents });
  if (links.length <= LARGE_BATCH_LINK_THRESHOLD) return { links, summary: "", largeBatch: false };
  const sections = [...new Set((manifest?.segments ?? []).map(sectionLabel).filter(Boolean))];
  const scope = `${workspaceKind === "notebook" ? "笔记本" : "作品"}${workspaceName ? `“${value(workspaceName)}”` : ""}`;
  return {
    links: [],
    summary: `批量落盘已完成：写入${scope}；覆盖板块：${sections.join("、") || "文档"}；共 ${links.length} 个文档，均已回读校验。`,
    largeBatch: true,
  };
};
