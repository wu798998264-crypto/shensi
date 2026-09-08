const clean = (value, maximum = 1_200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
const list = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 80)).filter(Boolean))].slice(0, 30);

export const normalizeRankingEntry = (value = {}) => {
  const normalized = {
    platformId: clean(value.platformId, 80),
    rankingId: clean(value.rankingId, 120),
    rankingName: clean(value.rankingName, 160),
    channel: ["male", "female", "all"].includes(value.channel) ? value.channel : "all",
    genre: clean(value.genre, 120),
    rank: Math.max(0, Number(value.rank) || 0),
    title: clean(value.title, 240),
    author: clean(value.author, 160),
    bookUrl: clean(value.bookUrl, 2_048),
    coverUrl: clean(value.coverUrl, 2_048),
    tags: list(value.tags),
    synopsis: clean(value.synopsis, 1_200),
    wordCount: Number.isFinite(Number(value.wordCount)) ? Math.max(0, Number(value.wordCount)) : null,
    status: clean(value.status, 80),
    publicMetrics: value.publicMetrics && typeof value.publicMetrics === "object" ? { ...value.publicMetrics } : {},
    rawPublicMetrics: value.rawPublicMetrics && typeof value.rawPublicMetrics === "object" ? { ...value.rawPublicMetrics } : {},
    collectedAt: clean(value.collectedAt, 80),
    sourceUrl: clean(value.sourceUrl, 2_048),
    sourceMode: ["direct", "controlled_browser", "user_supplied"].includes(value.sourceMode) ? value.sourceMode : "user_supplied",
    fieldCompleteness: 0,
    warnings: list(value.warnings),
  };
  const present = ["platformId", "rankingId", "rank", "title", "author", "collectedAt", "sourceUrl"]
    .filter((key) => Boolean(normalized[key])).length;
  normalized.fieldCompleteness = Number((present / 7).toFixed(3));
  return normalized;
};

const duplicateKey = (item) => `${item.platformId}\u0000${item.title.toLocaleLowerCase()}\u0000${item.author.toLocaleLowerCase()}`;

export const assessRankingData = (entries = [], { parserVersion = "unknown", minimumEntries = 15 } = {}) => {
  const normalized = entries.map(normalizeRankingEntry);
  const seen = new Set();
  const validItems = [];
  const invalidItems = [];
  const duplicates = [];
  const missingFields = { platformId: 0, rankingId: 0, rank: 0, title: 0, author: 0, collectedAt: 0, sourceUrl: 0 };
  for (const item of normalized) {
    for (const field of Object.keys(missingFields)) if (!item[field]) missingFields[field] += 1;
    if (!item.rank || !item.title || !item.author) { invalidItems.push(item); continue; }
    const key = duplicateKey(item);
    if (seen.has(key)) { duplicates.push(item); continue; }
    seen.add(key);
    validItems.push(item);
  }
  const warnings = [];
  if (validItems.length < minimumEntries) warnings.push(`有效条目仅 ${validItems.length} 条，数据稀疏`);
  if (invalidItems.length) warnings.push(`${invalidItems.length} 条缺少排名、书名或作者`);
  if (duplicates.length) warnings.push(`${duplicates.length} 条重复作品已排除`);
  const status = validItems.length === 0 ? "failed" : validItems.length < minimumEntries || invalidItems.length > 0 ? "partial" : "ok";
  return {
    status,
    totalEntries: normalized.length,
    validEntries: validItems.length,
    duplicateEntries: duplicates.length,
    invalidEntries: invalidItems.length,
    missingFields,
    warnings,
    parserVersion,
    validItems,
  };
};
