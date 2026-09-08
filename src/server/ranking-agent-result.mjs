import { createHash } from "node:crypto";
import { rankingSourceById } from "./ranking-source-registry.mjs";

const clean = (value, maximum = 4_000) => String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maximum);
const cleanList = (value, maximum = 100) => (Array.isArray(value) ? value : [])
  .map((item) => clean(item, 1_000))
  .filter(Boolean)
  .slice(0, maximum);
const validDate = (value) => Boolean(clean(value, 80)) && !Number.isNaN(Date.parse(value));
const SHA256 = /^[a-f0-9]{64}$/iu;

const extractJson = (text = "") => {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const candidate = fenced || source;
  try { return JSON.parse(candidate); } catch {}
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
  throw new Error("Agent 未返回可解析的结构化扫榜 JSON");
};

const assertPublicEvidenceUrl = (platformId, value) => {
  const source = rankingSourceById(platformId);
  if (!source) throw new Error("Agent 返回了未知平台");
  let url;
  try { url = new URL(clean(value, 2_048)); } catch { throw new Error("Agent 返回的来源链接无效"); }
  if (url.protocol !== "https:" || !source.hosts.includes(url.hostname.toLowerCase())) {
    throw new Error("Agent 返回的来源链接不属于所选平台公开域名");
  }
  return url.toString();
};

const normalizedChapterEvidence = (value, platformId) => {
  const title = clean(value?.title || value?.chapterTitle, 240);
  const url = assertPublicEvidenceUrl(platformId, value?.url || value?.sourceUrl);
  const suppliedText = clean(value?.contentText || value?.text, 2_000_000);
  const computedHash = suppliedText ? createHash("sha256").update(suppliedText, "utf8").digest("hex") : "";
  const reportedHash = clean(value?.contentHash, 80).toLowerCase();
  const contentHash = computedHash || (SHA256.test(reportedHash) ? reportedHash : "");
  const measuredWordCount = suppliedText ? [...suppliedText.replace(/\s+/gu, "")].length : 0;
  const reportedWordCount = Math.max(0, Number(value?.wordCount) || 0);
  const wordCount = measuredWordCount || reportedWordCount;
  const readAt = validDate(value?.readAt) ? new Date(value.readAt).toISOString() : "";
  if (!title || !contentHash || !wordCount || !readAt) throw new Error("章节证据缺少章节名、字数、内容哈希或读取时间");
  if (suppliedText && reportedHash && reportedHash !== computedHash) throw new Error("章节正文哈希与 Agent 报告不一致");
  return {
    title,
    url,
    wordCount,
    contentHash,
    hashVerified: Boolean(suppliedText),
    readAt,
    excerpt: clean(value?.excerpt || suppliedText.slice(0, 240), 240),
  };
};

export const sanitizeRankingAnalysisSummary = (value = "") => clean(value, 20_000)
  .replace(/(?:已经|已|成功)?完成(?:了)?(?:全本|全文|整本)(?:拆解|拆书|分析|阅读)/gu, "当前未取得足以支持全文结论的正文证据")
  .replace(/(?:全本|全文|整本)(?:均|都)?(?:已)?(?:读取|覆盖)/gu, "正文覆盖尚未完整核验");

export const sanitizeRankingAnalysisValue = (value) => {
  if (typeof value === "string") return sanitizeRankingAnalysisSummary(value);
  if (Array.isArray(value)) return value.map(sanitizeRankingAnalysisValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeRankingAnalysisValue(item)]));
  return value;
};

export const parseRankingAgentResult = (value) => {
  if (value && typeof value === "object") return structuredClone(value);
  return extractJson(value);
};

export const validateRankingAgentResult = (input = {}, { platformId = "", requestedTopN = 30 } = {}) => {
  const raw = parseRankingAgentResult(input);
  const selectedPlatform = clean(platformId || raw.platformId, 80);
  if (!selectedPlatform || clean(raw.platformId, 80) !== selectedPlatform) throw new Error("Agent 返回的平台与任务目标不一致");
  const readAt = validDate(raw.readAt) ? new Date(raw.readAt).toISOString() : "";
  if (!readAt) throw new Error("Agent 结果缺少真实读取时间");
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, Math.max(1, Number(requestedTopN) || 30)).map((item) => ({
    ...item,
    platformId: selectedPlatform,
    rankingId: clean(item?.rankingId || raw.rankingId, 120),
    rank: Math.max(0, Number(item?.rank) || 0),
    title: clean(item?.title, 240),
    author: clean(item?.author, 160),
    bookUrl: assertPublicEvidenceUrl(selectedPlatform, item?.bookUrl || item?.sourceUrl),
    sourceUrl: assertPublicEvidenceUrl(selectedPlatform, item?.sourceUrl || item?.bookUrl),
    collectedAt: validDate(item?.collectedAt) ? new Date(item.collectedAt).toISOString() : readAt,
    sourceMode: "controlled_browser",
  }));
  const chapterWarnings = [];
  const chapterEvidence = [];
  for (const evidence of Array.isArray(raw.chapterEvidence) ? raw.chapterEvidence.slice(0, 200) : []) {
    try { chapterEvidence.push(normalizedChapterEvidence(evidence, selectedPlatform)); }
    catch (error) { chapterWarnings.push(`${clean(evidence?.title || "未知章节", 120)}：${clean(error?.message || error, 500)}`); }
  }
  const citations = (Array.isArray(raw.citations) ? raw.citations : []).slice(0, 300).flatMap((citation) => {
    try {
      return [{
        url: assertPublicEvidenceUrl(selectedPlatform, citation?.url || citation?.sourceUrl),
        label: clean(citation?.label || citation?.title || "来源", 240),
        evidenceType: clean(citation?.evidenceType || "public_page", 80),
      }];
    } catch { return []; }
  });
  const requestedChapters = Math.max(0, Number(raw.coverage?.requestedChapters) || 0);
  const totalPublishedChapters = Math.max(0, Number(raw.coverage?.totalPublishedChapters) || 0);
  const readChapters = chapterEvidence.length;
  const fullTextVerified = totalPublishedChapters > 0
    && readChapters >= totalPublishedChapters
    && chapterEvidence.every((item) => item.hashVerified === true);
  const warnings = [...chapterWarnings, ...cleanList(raw.coverage?.warnings, 100)];
  const claimedScope = clean(raw.report?.claimedScope, 80);
  if ((claimedScope === "full_text" || /全文|全本|整本/u.test(clean(raw.report?.summary, 20_000))) && !fullTextVerified) {
    warnings.push("Agent 声称完成全文分析，但缺少可独立核验的完整正文覆盖证据，已自动降级。");
  }
  const analysisLevel = fullTextVerified ? "full_text" : chapterEvidence.length ? "chapter_evidence" : items.some((item) => clean(item.synopsis)) ? "synopsis_analysis" : items.length ? "ranking_only" : "none";
  const accepted = raw.status !== "failed" && items.some((item) => item.rank && item.title && item.author);
  const failures = (Array.isArray(raw.failures) ? raw.failures : []).slice(0, 100).map((failure) => ({
    scope: clean(failure?.scope || "platform", 80),
    reason: clean(failure?.reason || "读取失败", 1_000),
    accessBoundary: clean(failure?.accessBoundary || "", 120),
    url: clean(failure?.url, 2_048),
  }));
  const accessBlocked = failures.some((failure) => /login|required|paywall|captcha|验证码|登录|付费/iu.test(`${failure.accessBoundary} ${failure.reason}`));
  return {
    raw,
    accepted,
    platformId: selectedPlatform,
    rankingId: clean(raw.rankingId, 120),
    readAt,
    status: accepted ? "success" : "failed",
    items,
    chapterEvidence,
    citations,
    failures,
    coverageLedger: {
      platformId: selectedPlatform,
      requestedItems: Math.max(1, Number(requestedTopN) || 30),
      validItems: items.filter((item) => item.rank && item.title && item.author).length,
      requestedChapters,
      readChapters,
      totalPublishedChapters,
      bodyEvidenceCount: chapterEvidence.length,
      bodyCoverageRate: Number(((totalPublishedChapters ? readChapters / totalPublishedChapters : requestedChapters ? readChapters / requestedChapters : 0) * 100).toFixed(1)),
      analysisLevel,
      mayClaimFullText: fullTextVerified,
      missing: cleanList(raw.coverage?.missing, 200),
      warnings,
    },
    report: {
      summary: fullTextVerified ? clean(raw.report?.summary, 20_000) : sanitizeRankingAnalysisSummary(raw.report?.summary),
      claimedScope: fullTextVerified ? "full_text" : analysisLevel,
      trends: Array.isArray(raw.report?.trends) ? structuredClone(raw.report.trends.slice(0, 100)) : [],
      deconstruction: Array.isArray(raw.report?.deconstruction) ? structuredClone(raw.report.deconstruction.slice(0, 100)) : [],
    },
    userActionRequired: accessBlocked ? "平台访问受到登录、付费或验证码限制；请上传你合法取得的正文后继续拆书。" : "",
  };
};

export const aggregateRankingCoverage = (platformLedgers = [], requestedPlatforms = []) => {
  const ledgers = Array.isArray(platformLedgers) ? platformLedgers : [];
  const selected = [...new Set((requestedPlatforms || []).map(String).filter(Boolean))];
  const mayClaimFullText = selected.length > 0 && selected.every((platformId) => ledgers.some((ledger) => ledger.platformId === platformId && ledger.mayClaimFullText === true));
  const bodyEvidenceCount = ledgers.reduce((sum, ledger) => sum + (Number(ledger.bodyEvidenceCount) || 0), 0);
  const requestedChapters = ledgers.reduce((sum, ledger) => sum + (Number(ledger.requestedChapters) || 0), 0);
  const readChapters = ledgers.reduce((sum, ledger) => sum + (Number(ledger.readChapters) || 0), 0);
  return {
    analysisLevel: mayClaimFullText ? "full_text" : bodyEvidenceCount ? "chapter_evidence" : ledgers.some((ledger) => ledger.analysisLevel === "synopsis_analysis") ? "synopsis_analysis" : ledgers.length ? "ranking_only" : "none",
    mayClaimFullText,
    bodyEvidenceCount,
    requestedChapters,
    readChapters,
    bodyCoverageRate: Number(((requestedChapters ? readChapters / requestedChapters : 0) * 100).toFixed(1)),
    platforms: structuredClone(ledgers),
    missing: ledgers.flatMap((ledger) => ledger.missing || []),
    warnings: ledgers.flatMap((ledger) => ledger.warnings || []),
  };
};
