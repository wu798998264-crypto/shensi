import { parseRankingBlocks } from "./shared-html.mjs";

export const JJWXC_PARSER_VERSION = "jjwxc-public-ranking-v1";
export const parseJjwxcRankingHtml = (html, options = {}) => parseRankingBlocks(html, {
  platformId: "jjwxc",
  rankingId: options.rankingId || "ranking",
  rankingName: options.rankingName || "晋江公开榜单",
  channel: options.channel || "female",
  collectedAt: options.collectedAt || new Date().toISOString(),
  sourceUrl: options.sourceUrl || "https://www.jjwxc.net/topten.php",
  baseUrl: "https://www.jjwxc.net/",
  blockPattern: /<tr\b[^>]*data-book-id=["'][^"']+["'][^>]*>[\s\S]*?<\/tr>/gi,
});
