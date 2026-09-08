const normalizedDocumentIdSet = (values = []) => new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean),
);

const substantive = (value = "", title = "", placeholder = "") => {
  const visible = String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Boolean(visible)
    && visible !== String(title ?? "").trim()
    && visible !== String(placeholder ?? "").trim()
    && !/^(?:等待AI写入|等待生成|尚未生成|暂无内容|空白文档)[。.!！]?$/u.test(visible);
};

export const generatedLandingHistoryDocumentIds = ({
  landings = [],
  existingDocumentIds = [],
} = {}) => {
  const existing = normalizedDocumentIdSet(existingDocumentIds);
  const unique = new Set();
  for (const landing of Array.isArray(landings) ? landings : []) {
    const documentId = String(landing?.documentId || "").trim();
    if (!documentId || unique.has(documentId) || !existing.has(documentId)) continue;
    unique.add(documentId);
  }
  return [...unique];
};

export const generatedLandingHistoryPlan = ({ landings = [], documents = {} } = {}) => {
  const documentIds = generatedLandingHistoryDocumentIds({
    landings,
    existingDocumentIds: Object.keys(documents ?? {}),
  });
  return documentIds.reduce((plan, documentId) => {
    const document = documents?.[documentId] ?? {};
    const key = substantive(document.html ?? document.markdown ?? document.text ?? "", document.title, document.placeholder)
      ? "contentSnapshotDocumentIds"
      : "blankBaselineDocumentIds";
    plan[key].push(documentId);
    return plan;
  }, { contentSnapshotDocumentIds: [], blankBaselineDocumentIds: [] });
};
