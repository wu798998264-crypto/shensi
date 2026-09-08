import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetchQuanbenDirectory } from "./quanben-book-source.mjs";
import { closePinnedPublicDispatcher, createPinnedPublicDispatcher, fetchPinnedPublicUrl } from "./pinned-public-fetch.mjs";

const USER_AGENT = "ShensiCreativeEngine/1.0 (+user-selected-web-reference)";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARACTERS = 40_000;
const MAX_TOTAL_CHARACTERS = 120_000;
const MAX_PAGES = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DETAIL_LINK_SIGNAL = /(?:详情|目录|章节|正文|阅读|全文|内容|下一页|article|detail|chapter|read|content)/iu;

const decodeEntities = (value = "") => String(value)
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'");

const normalizedText = (value = "") => String(value)
  .normalize("NFC")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  .replace(/\r/g, "")
  .replace(/[\t\f\v ]+/g, " ")
  .replace(/ *\n */g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const stripHtml = (html = "") => normalizedText(decodeEntities(String(html)
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<(?:script|style|noscript|svg|canvas|template|iframe|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|canvas|template|iframe|nav|header|footer|aside)>/gi, " ")
  .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
  .replace(/<\/(?:p|div|article|section|main|li|h[1-6]|tr)>/gi, "\n")
  .replace(/<[^>]+>/g, " ")));

const privateIpv4 = (address) => {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
};

const privateIp = (address = "") => {
  const normalized = String(address).toLowerCase();
  if (isIP(normalized) === 4) return privateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
};

const resolvePublicWebTarget = async (value, { lookupImpl = lookup } = {}) => {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("公共网页链接格式无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("只允许读取公共 HTTP 或 HTTPS 网页");
  if (!url.hostname || ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new Error("该网页地址不允许访问");
  const literal = isIP(url.hostname);
  if (literal && privateIp(url.hostname)) throw new Error("该网页地址不允许访问");
  let records = literal ? [{ address: url.hostname, family: literal }] : [];
  if (!literal) {
    records = await lookupImpl(url.hostname, { all: true });
    if (!records?.length || records.some((record) => privateIp(record.address))) throw new Error("网页解析到了不允许访问的网络地址");
  }
  url.hash = "";
  return {
    url,
    addresses: records.map((record) => ({ address: String(record.address), family: Number(record.family) || isIP(record.address) })),
  };
};

export const validatePublicWebUrl = async (value, options = {}) => (await resolvePublicWebTarget(value, options)).url;

const sameOriginDetailLinks = (html, pageUrl) => {
  const base = new URL(pageUrl);
  const links = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(decodeEntities(match[1]), base); } catch { continue; }
    url.hash = "";
    const label = stripHtml(match[2]).replace(/\s+/g, " ").trim().slice(0, 160);
    if (url.origin !== base.origin || !DETAIL_LINK_SIGNAL.test(`${label} ${url.pathname}`) || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ url: url.href, label: label || url.pathname });
    if (links.length >= 12) break;
  }
  return links;
};

export const parsePublicWebPage = (html = "", { url = "" } = {}) => {
  const source = String(html);
  const main = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || source.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    || source;
  const title = stripHtml(
    source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
      || source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || "网页资料",
  ).replace(/\s+/g, " ").slice(0, 200);
  return {
    title: title || "网页资料",
    text: stripHtml(main).slice(0, MAX_PAGE_CHARACTERS),
    links: sameOriginDetailLinks(main, url),
  };
};

const readResponseBody = async (response) => {
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > MAX_PAGE_BYTES) throw new Error("网页超过单页读取上限");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error("网页超过单页读取上限");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const charset = response.headers.get("content-type")?.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "").toLowerCase() || "utf-8";
  try { return new TextDecoder(["gbk", "gb2312"].includes(charset) ? "gb18030" : charset).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
};

const fetchPublicHtml = async (value, {
  fetchImpl = fetchPinnedPublicUrl,
  lookupImpl = lookup,
  dispatcherFactory = createPinnedPublicDispatcher,
} = {}) => {
  let current = await resolvePublicWebTarget(value, { lookupImpl });
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const dispatcher = dispatcherFactory({ hostname: current.url.hostname, addresses: current.addresses });
    try {
      const response = await fetchImpl(current.url.href, {
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
        maxResponseBytes: MAX_PAGE_BYTES,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 4) throw new Error("网页重定向异常");
        try { await response.body?.cancel?.(); } catch {}
        current = await resolvePublicWebTarget(new URL(location, current.url), { lookupImpl });
        continue;
      }
      if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
      if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) throw new Error("网页返回了不支持的内容类型");
      return { url: current.url.href, html: await readResponseBody(response) };
    } finally {
      clearTimeout(timeout);
      await closePinnedPublicDispatcher(dispatcher);
    }
  }
  throw new Error("网页重定向次数过多");
};

const isQuanbenWorkUrl = (value = "") => {
  try {
    const url = new URL(String(value));
    return url.hostname.replace(/^www\./i, "").toLowerCase() === "quanben-xiaoshuo.com" && /^\/n\/[^/]+\//i.test(url.pathname);
  } catch { return false; }
};

export const readPublicWebReference = async ({
  url,
  fetchImpl = fetchPinnedPublicUrl,
  lookupImpl = lookup,
  dispatcherFactory = createPinnedPublicDispatcher,
  quanbenDirectoryReader = fetchQuanbenDirectory,
  maxPages = MAX_PAGES,
  maxCharacters = MAX_TOTAL_CHARACTERS,
} = {}) => {
  const safeUrl = await validatePublicWebUrl(url, { lookupImpl });
  if (isQuanbenWorkUrl(safeUrl.href)) {
    const directory = await quanbenDirectoryReader({
      bookUrl: safeUrl.href,
      fetchImpl,
      lookupImpl,
      dispatcherFactory,
    });
    const chapterLines = (directory.chapters || []).map((chapter) => `${chapter.index}. ${chapter.title}\n${chapter.url}`);
    const text = normalizedText([
      `作品：${directory.title || "未命名小说"}`,
      directory.author ? `作者：${directory.author}` : "",
      `目录：${directory.directoryUrl || safeUrl.href}`,
      "",
      ...chapterLines,
    ].filter(Boolean).join("\n"));
    return {
      schemaVersion: 1,
      kind: "book_directory",
      sourceUrl: safeUrl.href,
      finalUrl: directory.directoryUrl || safeUrl.href,
      title: directory.title || "未命名小说",
      fetchedAt: new Date().toISOString(),
      text: text.slice(0, maxCharacters),
      contentCharacters: Math.min(text.length, maxCharacters),
      pages: [{ url: directory.directoryUrl || safeUrl.href, title: directory.title || "未命名小说", text: text.slice(0, maxCharacters) }],
      links: (directory.chapters || []).slice(0, 2_000).map((chapter) => ({ url: chapter.url, label: chapter.title })),
    };
  }

  const queue = [safeUrl.href];
  const visited = new Set();
  const pages = [];
  let totalCharacters = 0;
  while (queue.length && pages.length < Math.max(1, Math.min(MAX_PAGES, Number(maxPages) || MAX_PAGES)) && totalCharacters < maxCharacters) {
    const nextUrl = queue.shift();
    if (!nextUrl || visited.has(nextUrl)) continue;
    visited.add(nextUrl);
    const page = await fetchPublicHtml(nextUrl, { fetchImpl, lookupImpl, dispatcherFactory });
    const parsed = parsePublicWebPage(page.html, { url: page.url });
    const remaining = Math.max(0, maxCharacters - totalCharacters);
    const text = parsed.text.slice(0, remaining);
    pages.push({ url: page.url, title: parsed.title, text });
    totalCharacters += text.length;
    for (const link of parsed.links) if (!visited.has(link.url) && !queue.includes(link.url)) queue.push(link.url);
  }
  const text = pages.map((page) => `# ${page.title}\n来源：${page.url}\n\n${page.text}`).join("\n\n");
  return {
    schemaVersion: 1,
    kind: "web",
    sourceUrl: safeUrl.href,
    finalUrl: pages.at(-1)?.url || safeUrl.href,
    title: pages[0]?.title || safeUrl.hostname,
    fetchedAt: new Date().toISOString(),
    text,
    contentCharacters: text.length,
    pages,
    links: pages.flatMap((page) => [{ url: page.url, label: page.title }]),
  };
};
