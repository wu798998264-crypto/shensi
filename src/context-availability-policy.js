const plainText = (document = {}) => {
  const html = String(document.html || "")
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .trim();
  return html || String(document.markdown || document.content || document.text || "").trim();
};

export const contextAvailabilityDecision = ({ missingRequiredIds = [], documents = {}, explicitReferenceIds = [] } = {}) => {
  const explicit = new Set((explicitReferenceIds ?? []).map(String));
  const ids = [...new Set((missingRequiredIds ?? []).map(String).filter(Boolean))].sort();
  const readableIds = ids.filter((id) => Boolean(plainText(documents?.[id])));
  const missingIds = ids.filter((id) => !readableIds.includes(id));
  if (readableIds.length) return { status: "retry_read", missingIds, readableIds };
  if (missingIds.some((id) => explicit.has(id)) || missingIds.length) return { status: "ask_fresh_start", missingIds, readableIds };
  return { status: "ready", missingIds: [], readableIds: [] };
};
