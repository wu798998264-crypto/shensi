const escapePattern = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const adapter = ({ id, contentTokens = [], chapterSignal, directorySignal } = {}) => Object.freeze({
  id,
  contentTokens: Object.freeze([...contentTokens]),
  chapterSignal: chapterSignal || /(?:第.{0,18}[章节回卷集]|chapter|reader|read)/i,
  directorySignal: directorySignal || /(?:目录|全部章节|免费阅读|开始阅读|catalog|chapter|reader|read|book)/i,
});

// Site-specific tokens are intentionally data-only. They select rendered DOM
// containers and links; executable page scripts are never evaluated here.
export const OFFICIAL_BOOK_ADAPTERS = Object.freeze([
  adapter({ id: "qidian", contentTokens: ["read-content", "main-text-wrap", "chapter-content"] }),
  adapter({ id: "fanqie", contentTokens: ["muye-reader-content", "reader-content", "chapter-content"] }),
  adapter({ id: "faloo", contentTokens: ["noveContent", "novel-content", "chapter-content"] }),
  adapter({ id: "qimao", contentTokens: ["chapter-content", "reader-content", "content"] }),
  adapter({ id: "shuqi", contentTokens: ["reader-content", "chapter-content", "content"] }),
  adapter({ id: "ciweimao", contentTokens: ["chapter-content", "book-read", "read-content"] }),
  adapter({ id: "motie", contentTokens: ["chapter-content", "read-content", "article-content"] }),
  adapter({ id: "zongheng", contentTokens: ["content", "reader-content", "chapter-content"] }),
  adapter({ id: "chuangshi", contentTokens: ["chapter-content", "read-content", "content"] }),
  adapter({ id: "jjwxc", contentTokens: ["noveltext", "chapter-content", "read-content"] }),
  adapter({ id: "3gsc", contentTokens: ["chapter-content", "read-content", "content"] }),
  adapter({ id: "17k", contentTokens: ["readArea", "chapter-content", "read-content"] }),
  adapter({ id: "hongxiu", contentTokens: ["read-content", "main-text-wrap", "chapter-content"] }),
  adapter({ id: "xxsy", contentTokens: ["read-content", "chapter-content", "article-content"] }),
  adapter({ id: "readnovel", contentTokens: ["read-content", "main-text-wrap", "chapter-content"] }),
  adapter({ id: "yunqi", contentTokens: ["read-content", "main-text-wrap", "chapter-content"] }),
]);

const adapterById = new Map(OFFICIAL_BOOK_ADAPTERS.map((item) => [item.id, item]));
const fallbackAdapter = adapter({ id: "generic", contentTokens: ["chapter", "read-content", "article", "content"] });

export const officialBookAdapter = (sourceId = "") => adapterById.get(String(sourceId)) || fallbackAdapter;

const balancedContainerCandidates = (html, token) => {
  const escaped = escapePattern(token);
  const pattern = new RegExp(`<(?:article|main|div|section)\\b[^>]*(?:id|class)=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:article|main|div|section)>`, "gi");
  return [...String(html).matchAll(pattern)].map((match) => match[1]);
};

export const adapterMainHtml = ({ sourceId = "", html = "", textLength = (value) => String(value).length } = {}) => {
  const selected = officialBookAdapter(sourceId);
  const candidates = selected.contentTokens.flatMap((token) => balancedContainerCandidates(html, token));
  for (const match of String(html).matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)) candidates.push(match[2]);
  const useful = candidates
    .map((candidate) => ({ html: candidate, length: Number(textLength(candidate)) || 0 }))
    .sort((left, right) => right.length - left.length)[0];
  return useful?.length >= 300 ? useful.html : String(html);
};

export const classifyOfficialBookLink = ({ sourceId = "", text = "", url = "", depth = 0 } = {}) => {
  const selected = officialBookAdapter(sourceId);
  const signal = `${text} ${url}`;
  if (/(?:登录|注册|充值|购买|订阅|login|register|pay|order|download|author|comment|rank|排行榜)/i.test(signal)) return "blocked";
  if (selected.chapterSignal.test(signal)) return "chapter";
  if (depth === 0 && selected.directorySignal.test(signal)) return "directory";
  if (depth > 0 && /(?:下一页|上一页|下一章|上一章|page)/i.test(signal)) return "chapter";
  return "other";
};

export const classifyOfficialBookPage = ({ title = "", text = "" } = {}) => {
  const sample = `${title}\n${String(text).slice(0, 3000)}`;
  const short = String(text).length < 2400;
  if (short && /(?:请先登录|账号登录|手机登录|扫码登录|登录(?:后|即可|才可).{0,12}(?:阅读|继续|查看)|输入验证码|sign[ -]?in to (?:read|continue)|log[ -]?in to (?:read|continue))/i.test(sample)) return "login_required";
  if (short && /(?:订阅后阅读|购买本章|付费阅读|VIP章节|充值后|解锁本章|subscribe|purchase|payment)/i.test(sample)) return "paid";
  if (String(text).length < 300) return "insufficient";
  return "readable";
};

export const officialBookAdapterFixture = (sourceId) => {
  const selected = officialBookAdapter(sourceId);
  const token = selected.contentTokens[0];
  return `<html><body><div class="${token}"><h1>第一章 适配器样本</h1><p>${"正版免费章节回归内容。".repeat(40)}</p></div><a href="/book/123456/chapter/2">第二章</a></body></html>`;
};
