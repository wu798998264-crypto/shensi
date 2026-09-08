const INTERNAL_PROTOCOL_KEYS = /(?:target_?document_?id|targetdocumentid|target_?revision|targetrevision|operation|content_?format|contentformat|requested_?title|requestedtitle|target_?directory(?:_?id)?|targetdirectory|navigation_?target|navigationtarget|receipt_?verified|receiptverified)\s*["']?\s*[:：]/iu;

const protocolObjectText = (value = "") => {
  const source = String(value ?? "").trim();
  if (!source || !INTERNAL_PROTOCOL_KEYS.test(source)) return false;
  return /^(?:```(?:json|ya?ml)?\s*)?[{[]/iu.test(source)
    || /^(?:```ya?ml\s*)?(?:target_?document_?id|targetdocumentid|operation)\s*:/iu.test(source);
};

export const stripInternalAssistantProtocol = (value = "") => {
  let source = String(value ?? "").replace(/\r\n?/gu, "\n");
  source = source.replace(/```(?:json|ya?ml)?\s*\n([\s\S]*?)```/giu, (full, body) => (
    INTERNAL_PROTOCOL_KEYS.test(body) ? "" : full
  ));
  const lines = source.split("\n");
  const kept = [];
  let protocolDepth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!protocolDepth && protocolObjectText(trimmed)) {
      protocolDepth = Math.max(1, (trimmed.match(/[\[{]/gu) ?? []).length - (trimmed.match(/[\]}]/gu) ?? []).length);
      continue;
    }
    if (protocolDepth) {
      protocolDepth += (trimmed.match(/[\[{]/gu) ?? []).length - (trimmed.match(/[\]}]/gu) ?? []).length;
      if (protocolDepth <= 0) protocolDepth = 0;
      continue;
    }
    if (INTERNAL_PROTOCOL_KEYS.test(trimmed) && /^(?:[-*]\s*)?["']?(?:target_?document_?id|targetdocumentid|target_?revision|targetrevision|operation|content_?format|contentformat|requested_?title|requestedtitle|target_?directory(?:_?id)?|targetdirectory)/iu.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
};
