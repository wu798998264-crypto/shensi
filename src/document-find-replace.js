const normalizedSearchText = (value, caseSensitive) => {
  const text = String(value ?? "");
  return caseSensitive ? text : text.toLowerCase();
};

export const findTextMatches = (text, query, { caseSensitive = false, limit = Number.POSITIVE_INFINITY } = {}) => {
  const source = String(text ?? "");
  const needle = String(query ?? "");
  if (!source || !needle || limit <= 0) return [];
  const haystack = normalizedSearchText(source, caseSensitive);
  const normalizedNeedle = normalizedSearchText(needle, caseSensitive);
  const matches = [];
  let cursor = 0;
  while (cursor <= haystack.length - normalizedNeedle.length && matches.length < limit) {
    const start = haystack.indexOf(normalizedNeedle, cursor);
    if (start < 0) break;
    matches.push({ start, end: start + needle.length });
    cursor = start + Math.max(needle.length, 1);
  }
  return matches;
};

export const nextTextMatchIndex = ({ currentIndex = -1, matchCount = 0, direction = 1 } = {}) => {
  const count = Math.max(0, Number(matchCount) || 0);
  if (!count) return -1;
  const current = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < count ? currentIndex : 0;
  const step = Number(direction) < 0 ? -1 : 1;
  return (current + step + count) % count;
};
