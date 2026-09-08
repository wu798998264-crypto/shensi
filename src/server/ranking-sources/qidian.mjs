import { parseRankingBlocks } from "./shared-html.mjs";

export const QIDIAN_PARSER_VERSION = "qidian-public-ssr-v1";
export const parseQidianRankingHtml = (html, options = {}) => parseRankingBlocks(html, {
  platformId: "qidian",
  rankingId: options.rankingId || "ranking",
  rankingName: options.rankingName || "起点公开榜单",
  channel: options.channel || "all",
  collectedAt: options.collectedAt || new Date().toISOString(),
  sourceUrl: options.sourceUrl || "https://www.qidian.com/rank/",
  baseUrl: "https://www.qidian.com/",
  blockPattern: /<li\b[^>]*data-book-id=["'][^"']+["'][^>]*>[\s\S]*?<\/li>/gi,
});
