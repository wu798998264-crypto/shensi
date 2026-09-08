const PLACEHOLDER_PATTERNS = Object.freeze([
  /^在右侧对话中(?:确定|填写|生成).{0,40}(?:具体内容|本章内容|正文)[。.!！]?$/u,
  /^(?:本章|本集|正文).{0,16}(?:待补充|待创作|待生成|尚未填写|等待作者确认)[。.!！]?$/u,
  /^(?:TODO|TBD|PLACEHOLDER|占位(?:文字|内容)?)[：:\s\S]{0,80}$/iu,
  /^按.{0,40}承接.{0,40}；当前等待确认.{0,60}$/u,
]);

export const memorySourceText = (documentState = {}) => String(documentState.markdown ?? documentState.html ?? "")
  .replace(/^---[\s\S]*?---\s*/u, "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/^#{1,6}\s+.*$/gm, "")
  .replace(/\r\n?/g, "\n")
  .replace(/[\t ]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// Browser-safe revision used only for UI filtering. The server still verifies
// the SHA-256 sourceHash before persisting a review decision.
export const memorySourceRevision = (documentState = {}) => {
  const source = memorySourceText(documentState);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const memoryPlaceholderReason = (documentState = {}) => {
  const source = memorySourceText(documentState).replace(/\s+/g, " ").trim();
  if (!source) return "正文尚未开始";
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(source)) ? "正文只有占位内容" : "";
};

export const memoryReviewMatchesCurrentSource = (documentState = {}) => {
  const review = documentState.memoryBackfillReview;
  return review?.decision === "ignored"
    && String(review.sourceRevision || "") === memorySourceRevision(documentState);
};
