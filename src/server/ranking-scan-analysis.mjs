const frequency = (items, getter) => {
  const counts = new Map();
  for (const item of items) for (const value of [].concat(getter(item) || []).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count, share: Number((count / Math.max(1, items.length)).toFixed(3)) })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export const analyzeRankingSnapshots = ({ snapshots = [], scanType = "long", failedPlatforms = [], sourceLedger = [], coverageLedger = {} } = {}) => {
  const items = snapshots.flatMap((snapshot) => snapshot.items || []);
  const qualities = snapshots.map((snapshot) => snapshot.quality || {});
  const collectedAt = snapshots.map((snapshot) => snapshot.collectedAt).filter(Boolean).sort().at(-1) || "";
  const genres = frequency(items, (item) => item.genre || item.tags || []);
  const tags = frequency(items, (item) => item.tags || []);
  const candidates = [...items].sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, Math.min(12, items.length));
  const sparse = qualities.some((quality) => quality.status !== "ok") || items.length < 15;
  return {
    deliverableType: "market_scan_report",
    authorizationState: "candidate_only",
    scanType,
    collectedAt,
    generatedAt: new Date().toISOString(),
    platforms: [...new Set(items.map((item) => item.platformId).filter(Boolean))],
    rankings: [...new Set(items.map((item) => item.rankingName || item.rankingId).filter(Boolean))],
    sampleCount: items.length,
    dataQuality: sparse ? "partial" : "ok",
    coverage: {
      failedPlatforms: [...failedPlatforms],
      sourceCount: sourceLedger.filter((item) => item.status === "success").length,
      analysisLevel: coverageLedger.analysisLevel || "ranking_only",
      mayClaimFullText: coverageLedger.mayClaimFullText === true,
      bodyEvidenceCount: Number(coverageLedger.bodyEvidenceCount) || 0,
      requestedChapters: Number(coverageLedger.requestedChapters) || 0,
      readChapters: Number(coverageLedger.readChapters) || 0,
      bodyCoverageRate: Number(coverageLedger.bodyCoverageRate) || 0,
      missing: [...(coverageLedger.missing || [])],
      warnings: [...(coverageLedger.warnings || [])],
    },
    marketOverview: sparse ? "当前样本不足以形成确定趋势，只能作为方向候选。" : `本次共纳入 ${items.length} 条有效公开榜单样本。`,
    genreDistribution: genres,
    tagDistribution: tags,
    titleSignals: frequency(items, (item) => String(item.title || "").match(/[\u4e00-\u9fff]{2}/g)?.slice(0, 4) || []),
    emergingSignals: genres.filter((item) => item.count >= 2).slice(0, 6),
    saturationRisks: genres.filter((item) => item.share >= 0.35).slice(0, 6),
    platformDifferences: snapshots.map((snapshot) => ({ platformId: snapshot.platformId, sampleCount: snapshot.items?.length || 0, metricNames: [...new Set((snapshot.items || []).flatMap((item) => Object.keys(item.rawPublicMetrics || {})))] })),
    candidates,
    projectFit: "市场信号只供创作引导讨论，不自动改变当前项目题材、设定、大纲或正文。",
    boundary: coverageLedger.mayClaimFullText === true
      ? "不同平台指标保持原名；正文覆盖已按来源、字数和哈希校验；不承诺题材必然成功。"
      : "不同平台指标保持原名；没有正文证据时只做榜单或简介分析，部分章节不得冒充全文分析；不承诺题材必然成功。",
    nextScanSuggestion: scanType === "short" ? "短篇风口变化较快，建议 7 天后复扫。" : "长篇榜单建议 14—30 天后复扫。",
  };
};

export const buildBookDeconstructionHandoff = (items = []) => ({
  items: items.map((item) => ({ title: String(item.title || ""), author: String(item.author || ""), sourceUrl: String(item.bookUrl || item.sourceUrl || "") })).filter((item) => item.title),
  requiresChapterSelection: true,
  allowFullTextFetch: false,
  allowAutomaticDeconstruction: false,
  targetFlow: "existing_novel_reference",
});
