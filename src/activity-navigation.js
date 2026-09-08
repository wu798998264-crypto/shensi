const normalizedText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const findActivityBlockIndex = (blockTexts = [], location = {}) => {
  if (!blockTexts.length) return -1;
  const anchor = normalizedText(location.anchorText);
  if (anchor) {
    const anchoredIndex = blockTexts.findIndex((text) => normalizedText(text).includes(anchor));
    if (anchoredIndex >= 0) return anchoredIndex;
  }
  const storedIndex = Number(location.blockIndex);
  if (Number.isInteger(storedIndex)) return Math.max(0, Math.min(storedIndex, blockTexts.length - 1));
  return 0;
};
