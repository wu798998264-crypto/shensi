const decode = (value = "") => String(value)
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const field = (block, className) => decode(block.match(new RegExp(`<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"))?.[1] || "");
const link = (block) => {
  const matched = block.match(/<a[^>]+class=["'][^"']*book-name[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    || block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*book-name[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  return { href: matched?.[1] || "", title: decode(matched?.[2] || "") };
};

export const parseRankingBlocks = (html = "", { platformId, rankingId, rankingName, channel, collectedAt, sourceUrl, baseUrl, blockPattern }) => {
  const blocks = [...String(html).matchAll(blockPattern)].map((match) => match[0]);
  return blocks.map((block, index) => {
    const itemLink = link(block);
    const metric = block.match(/class=["'][^"']*metric[^"']*["'][^>]*data-name=["']([^"']+)["'][^>]*>([\s\S]*?)<\//i);
    const metricName = decode(metric?.[1] || "");
    const metricValueText = decode(metric?.[2] || "").replaceAll(",", "");
    const metricValue = Number(metricValueText);
    return {
      platformId,
      rankingId,
      rankingName,
      channel,
      genre: field(block, "category"),
      rank: Number(field(block, "rank")) || index + 1,
      title: itemLink.title,
      author: field(block, "author"),
      bookUrl: itemLink.href ? new URL(itemLink.href, baseUrl).href : "",
      coverUrl: "",
      tags: field(block, "category") ? [field(block, "category")] : [],
      synopsis: field(block, "intro").slice(0, 1_200),
      wordCount: null,
      status: field(block, "status"),
      publicMetrics: {},
      rawPublicMetrics: metricName ? { [metricName]: Number.isFinite(metricValue) ? metricValue : metricValueText } : {},
      collectedAt,
      sourceUrl,
      sourceMode: "direct",
      fieldCompleteness: 0,
      warnings: [],
    };
  });
};
