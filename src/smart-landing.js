const text = (value, max = 240) => String(value ?? "").trim().slice(0, max);

export const splitLandingBlocks = (value = "") => String(value)
  .replace(/\r\n?/g, "\n")
  .trim()
  .split(/\n\s*\n+/)
  .map((content) => content.trim())
  .filter(Boolean)
  .slice(0, 600);

export const normalizeSmartLandingPlan = (value, { documentIds = [], blockCount = 0 } = {}) => {
  if (!value || typeof value !== "object" || !Array.isArray(value.documents)) return null;
  const allowedDocuments = new Set(documentIds.map(String));
  const claimedBlocks = new Set();
  const documents = [];
  for (const raw of value.documents.slice(0, 200)) {
    const documentId = text(raw?.documentId, 180);
    const targetHint = text(raw?.targetHint, 180);
    if ((!documentId || !allowedDocuments.has(documentId)) && !targetHint) continue;
    const blocks = [...new Set((Array.isArray(raw?.blocks) ? raw.blocks : [])
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 1 && index <= blockCount))];
    if (!blocks.length || blocks.some((index) => claimedBlocks.has(index))) continue;
    blocks.forEach((index) => claimedBlocks.add(index));
    documents.push({
      ...(documentId && allowedDocuments.has(documentId) ? { documentId } : {}),
      ...(targetHint ? { targetHint } : {}),
      ...(text(raw?.title, 180) ? { title: text(raw.title, 180) } : {}),
      blocks,
    });
  }
  if (!documents.length) return null;
  return {
    summary: text(value.summary, 300) || `已识别 ${documents.length} 个落盘目标`,
    documents,
  };
};

export const materializeSmartLandingPlan = (plan, source = "") => {
  const blocks = splitLandingBlocks(source);
  if (!plan?.documents?.length || !blocks.length) return [];
  return plan.documents.map((document) => ({
    ...document,
    content: document.blocks.map((index) => blocks[index - 1]).filter(Boolean).join("\n\n").trim(),
  })).filter((document) => document.content);
};
