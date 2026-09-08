import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { adapterMainHtml, classifyOfficialBookLink, classifyOfficialBookPage } from "./official-book-adapters.mjs";

export const OFFICIAL_BOOK_SOURCES = Object.freeze([
  { id: "qidian", name: "起点中文网", domains: ["qidian.com"], homepage: "https://www.qidian.com" },
  { id: "fanqie", name: "番茄小说", domains: ["fanqienovel.com"], homepage: "https://fanqienovel.com" },
  { id: "faloo", name: "飞卢小说网", domains: ["faloo.com"], homepage: "https://b.faloo.com" },
  { id: "qimao", name: "七猫中文网", domains: ["qimao.com"], homepage: "https://www.qimao.com" },
  { id: "shuqi", name: "书旗小说", domains: ["shuqi.com"], homepage: "https://www.shuqi.com" },
  { id: "ciweimao", name: "刺猬猫阅读", domains: ["ciweimao.com"], homepage: "https://www.ciweimao.com" },
  { id: "motie", name: "磨铁中文网", domains: ["motie.com"], homepage: "https://www.motie.com" },
  { id: "zongheng", name: "纵横中文网", domains: ["zongheng.com"], homepage: "https://www.zongheng.com" },
  { id: "chuangshi", name: "创世中文网", domains: ["chuangshi.qq.com"], homepage: "https://chuangshi.qq.com" },
  { id: "jjwxc", name: "晋江文学城", domains: ["jjwxc.net"], homepage: "https://www.jjwxc.net" },
  { id: "3gsc", name: "3G书城", domains: ["3gsc.com.cn"], homepage: "https://www.3gsc.com.cn" },
  { id: "17k", name: "17K小说网", domains: ["17k.com"], homepage: "https://www.17k.com" },
  { id: "hongxiu", name: "红袖添香", domains: ["hongxiu.com"], homepage: "https://www.hongxiu.com" },
  { id: "xxsy", name: "潇湘书院", domains: ["xxsy.net"], homepage: "https://www.xxsy.net" },
  { id: "readnovel", name: "小说阅读网", domains: ["readnovel.com"], homepage: "https://www.readnovel.com" },
  { id: "yunqi", name: "云起书院", domains: ["yunqi.qq.com"], homepage: "https://yunqi.qq.com" },
]);

export const BOOK_CATALOG_SOURCES = Object.freeze([
  { id: "wikidata", name: "Wikidata", homepage: "https://www.wikidata.org", kind: "catalog" },
  { id: "openlibrary", name: "Open Library", homepage: "https://openlibrary.org", kind: "catalog" },
  { id: "google-books", name: "Google Books", homepage: "https://books.google.com", kind: "catalog" },
  { id: "official-web", name: "正版小说网站", homepage: "", kind: "web_search" },
]);

const sourceById = new Map(OFFICIAL_BOOK_SOURCES.map((source) => [source.id, source]));
const catalogSourceById = new Map(BOOK_CATALOG_SOURCES.map((source) => [source.id, source]));
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMPORT_PAGES = 600;
const MAX_IMPORT_CHARACTERS = 8_000_000;
const USER_AGENT = "ShensiCreativeEngine/0.36 (+public-readable-book-import)";
export const BOOK_AUTH_REQUIRED_CODE = "BOOK_AUTH_REQUIRED";

export class BookAuthenticationRequiredError extends Error {
  constructor({ source = {}, loginUrl = "", returnUrl = "", reason = "需要登录后读取免费章节" } = {}) {
    super(reason);
    this.name = "BookAuthenticationRequiredError";
    this.code = BOOK_AUTH_REQUIRED_CODE;
    this.authRequired = true;
    this.sourceId = String(source.id || "");
    this.sourceName = String(source.name || "正版小说网站");
    this.loginUrl = String(loginUrl || returnUrl || source.homepage || "");
    this.returnUrl = String(returnUrl || loginUrl || source.homepage || "");
  }
}

export const isBookAuthenticationRequiredError = (error) => error?.code === BOOK_AUTH_REQUIRED_CODE || error?.authRequired === true;

const hostnameFor = (value = "") => String(value).trim().toLowerCase().replace(/\.$/, "");
const domainMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

export const officialBookSourceForUrl = (value) => {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const hostname = hostnameFor(url.hostname);
    return OFFICIAL_BOOK_SOURCES.find((source) => source.domains.some((domain) => domainMatches(hostname, domain))) ?? null;
  } catch {
    return null;
  }
};

const privateIpv4 = (address) => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] >= 224;
};

const privateIp = (address = "") => {
  const normalized = String(address).toLowerCase();
  if (isIP(normalized) === 4) return privateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
};

const validateOfficialUrl = async (value, expectedSourceId = "", { lookupImpl = lookup } = {}) => {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("小说链接格式无效，请粘贴完整的 http:// 或 https:// 链接");
  }
  const source = officialBookSourceForUrl(url);
  if (!source || (expectedSourceId && source.id !== expectedSourceId)) throw new Error("只允许读取已登记的正版小说网站链接");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("小说链接端口不受支持");
  const records = await lookupImpl(url.hostname, { all: true });
  if (!records.length || records.some((record) => privateIp(record.address))) throw new Error("小说链接解析到了不允许访问的网络地址");
  url.hash = "";
  return { url, source };
};

const decodeEntities = (value = "") => String(value)
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'");

const stripHtml = (html = "") => decodeEntities(String(html)
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<(?:script|style|noscript|svg|canvas|template|iframe)[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|canvas|template|iframe)>/gi, " ")
  .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
  .replace(/<\/(?:p|div|article|section|main|header|footer|nav|aside|li|h[1-6]|tr)>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .replace(/\r/g, "")
  .replace(/[\t\f\v ]+/g, " ")
  .replace(/ *\n */g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const htmlTitle = (html = "", fallback = "") => {
  const candidates = [
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1],
    html.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1],
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],
  ];
  return stripHtml(candidates.find(Boolean) || fallback).replace(/\s+/g, " ").slice(0, 180);
};

const mainHtml = (html = "", sourceId = "") => adapterMainHtml({ sourceId, html, textLength: (candidate) => stripHtml(candidate).length });

const extractLinks = (html, baseUrl) => {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]), baseUrl);
      url.hash = "";
      links.push({ url: url.href, text: stripHtml(match[2]).replace(/\s+/g, " ").slice(0, 120) });
    } catch {}
  }
  return links;
};

const loginSignal = (value = "") => /(?:请先登录|登录后|账号登录|手机登录|扫码登录|验证码|sign[ -]?in|log[ -]?in|passport|login)/i.test(String(value));
const paidSignal = (value = "") => /(?:订阅后阅读|购买本章|付费阅读|VIP章节|充值后|解锁本章|subscribe|purchase|payment)/i.test(String(value));

const bookAuthenticationChallenge = ({ source, html = "", returnUrl = "", reason = "需要登录后读取免费章节" } = {}) => {
  const safeSource = source || officialBookSourceForUrl(returnUrl) || {};
  const loginLink = extractLinks(html, returnUrl).find((link) => officialBookSourceForUrl(link.url)?.id === safeSource.id && loginSignal(`${link.text} ${link.url}`));
  return new BookAuthenticationRequiredError({
    source: safeSource,
    loginUrl: loginLink?.url || returnUrl || safeSource.homepage,
    returnUrl: returnUrl || loginLink?.url || safeSource.homepage,
    reason,
  });
};

const readBody = async (response) => {
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > MAX_PAGE_BYTES) throw new Error("网页内容超过单页读取上限");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error("网页内容超过单页读取上限");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const contentType = response.headers.get("content-type") || "";
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "").toLowerCase() || "utf-8";
  try {
    return new TextDecoder(["gbk", "gb2312"].includes(charset) ? "gb18030" : charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

const fetchOfficialHtml = async (value, sourceId, { fetchImpl = fetch, lookupImpl = lookup } = {}) => {
  let current = (await validateOfficialUrl(value, sourceId, { lookupImpl })).url;
  const source = sourceById.get(sourceId) || officialBookSourceForUrl(current);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 5) throw new Error("小说页面重定向异常");
        const redirected = new URL(location, current);
        if (loginSignal(redirected.href) && officialBookSourceForUrl(redirected)?.id !== source?.id) {
          throw bookAuthenticationChallenge({ source, returnUrl: current.href, reason: `需要先登录${source?.name || "正版小说网站"}后读取免费章节` });
        }
        current = (await validateOfficialUrl(redirected, sourceId, { lookupImpl })).url;
        continue;
      }
      if ([401, 403].includes(response.status)) {
        throw bookAuthenticationChallenge({ source, returnUrl: current.href, reason: `${source?.name || "正版小说网站"}要求登录后读取该免费页面` });
      }
      if (!response.ok) throw new Error(`小说页面返回 HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(contentType)) throw new Error("小说页面不是可读取的文本网页");
      return {
        url: response.headers.get("x-shensi-final-url") || current.href,
        html: await readBody(response),
        extractionMode: response.headers.get("x-shensi-extraction-mode") === "controlled_browser_dom"
          ? "controlled_browser_dom"
          : "static_html",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("小说页面重定向次数过多");
};

const parseJsonArray = (text = "") => {
  const source = String(text).replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = source.indexOf("[");
  const end = source.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const normalizeBookResult = (item = {}) => {
  const source = sourceById.get(String(item.sourceId ?? "")) || officialBookSourceForUrl(item.url);
  if (!source || officialBookSourceForUrl(item.url)?.id !== source.id) return null;
  const title = String(item.title ?? "").trim().slice(0, 160);
  if (!title) return null;
  return {
    id: createHash("sha256").update(`${source.id}\n${String(item.url)}`).digest("hex").slice(0, 24),
    sourceId: source.id,
    sourceName: source.name,
    title,
    author: String(item.author ?? "").trim().slice(0, 100),
    description: String(item.description ?? "").trim().slice(0, 400),
    url: String(item.url),
    readableUrl: String(item.readableUrl || item.url),
    availability: ["public_chapters", "public_preview", "metadata_only"].includes(item.availability) ? item.availability : "metadata_only",
    metadata: commonMetadata(item.metadata),
  };
};

const CATALOG_TIMEOUT_MS = 12_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const CATALOG_USER_AGENT = "ShensiCreativeEngine/0.36 (+book-catalog-search)";
const GOOGLE_BOOKS_CACHE_TTL_MS = 10 * 60 * 1000;
const BOOK_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const BOOK_SEARCH_PARTIAL_CACHE_TTL_MS = 45 * 1000;
const BOOK_SEARCH_CACHE_LIMIT = 160;
const DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS = 8_000;
const googleBooksCache = new Map();
const bookSearchCache = new Map();
const bookSearchInFlight = new Map();
const delay = (milliseconds, signal) => new Promise((resolveDelay, rejectDelay) => {
  if (signal?.aborted) return rejectDelay(signal.reason || new DOMException("The operation was aborted", "AbortError"));
  const timer = setTimeout(resolveDelay, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    rejectDelay(signal.reason || new DOMException("The operation was aborted", "AbortError"));
  }, { once: true });
});

const fetchCatalogJson = async (url, { fetchImpl = fetch, signal } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      headers: { "User-Agent": CATALOG_USER_AGENT, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.("content-length")) || 0;
    if (declared > MAX_CATALOG_BYTES) throw new Error("响应超过读取上限");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) throw new Error("响应超过读取上限");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

const fetchCatalogJsonWithBackoff = async (url, { fetchImpl = fetch, attempts = 4, signal } = {}) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchCatalogJson(url, { fetchImpl, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason || error;
      const retryable = /HTTP (?:429|5\d\d)\b/.test(String(error?.message || error));
      if (!retryable || attempt === attempts - 1) throw error;
      await delay(Math.min(4_000, 250 * (2 ** attempt)), signal);
    }
  }
  throw lastError;
};

const firstEntityValue = (claims = {}, property) => claims[property]?.find((claim) => claim?.mainsnak?.datavalue)?.mainsnak?.datavalue?.value;
const entityValues = (claims = {}, property) => (claims[property] ?? []).map((claim) => claim?.mainsnak?.datavalue?.value).filter(Boolean);
const entityIds = (claims = {}, property) => entityValues(claims, property).map((value) => value?.id).filter(Boolean);
const preferredEntityText = (entity = {}, property) => {
  const values = entity[property] ?? {};
  return values["zh-hans"]?.value || values["zh-cn"]?.value || values.zh?.value || values.en?.value || Object.values(values)[0]?.value || "";
};

const wikidataSearchItems = async (query, fetchImpl, signal) => {
  const searchUrl = new URL("https://www.wikidata.org/w/api.php");
  searchUrl.search = new URLSearchParams({ action: "wbsearchentities", search: query, language: "zh", uselang: "zh", format: "json", limit: "20", origin: "*" });
  return (await fetchCatalogJson(searchUrl, { fetchImpl, signal })).search ?? [];
};

export const searchWikidataBookBasics = async (query, { fetchImpl = fetch, signal } = {}) => (await wikidataSearchItems(query, fetchImpl, signal))
  .map((item) => {
    const description = String(item.description || "").trim();
    const positive = /小说|網路小說|网络小说|長篇|长篇|novel|fiction|literary work|book series|书籍|圖書/i.test(description);
    const negative = /电视剧|電視劇|电视节目|動畫|动画|电影|電影|游戏|遊戲|漫画|漫畫|television|film|anime|video game/i.test(description);
    if (!positive || negative) return null;
    return normalizedCatalogResult({
      providerId: "wikidata",
      externalId: item.id,
      title: item.label,
      description,
      url: `https://www.wikidata.org/wiki/${encodeURIComponent(item.id)}`,
      metadata: { identifiers: [{ type: "Wikidata", value: item.id }] },
    });
  })
  .filter(Boolean);
const entityLabel = (entities, id) => preferredEntityText(entities?.[id], "labels") || id;
const plainDate = (value) => String(value?.time ?? value ?? "").replace(/^\+/, "").match(/^\d{4}(?:-\d{2}-\d{2})?/)?.[0] || "";
const uniqueStrings = (values, limit = 30) => [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, limit);
const catalogId = (providerId, externalId) => `${providerId}:${String(externalId ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}`;
const commonMetadata = (metadata = {}) => ({
  subtitle: String(metadata.subtitle ?? "").trim().slice(0, 240),
  publisher: uniqueStrings(Array.isArray(metadata.publisher) ? metadata.publisher : [metadata.publisher], 12),
  publishedDate: String(metadata.publishedDate ?? "").trim().slice(0, 40),
  languages: uniqueStrings(metadata.languages, 16),
  subjects: uniqueStrings(metadata.subjects, 30),
  identifiers: (metadata.identifiers ?? []).map((item) => ({ type: String(item?.type ?? "").trim().slice(0, 40), value: String(item?.value ?? "").trim().slice(0, 160) })).filter((item) => item.type && item.value).slice(0, 30),
  pageCount: Math.max(0, Number(metadata.pageCount) || 0),
  editionCount: Math.max(0, Number(metadata.editionCount) || 0),
  coverUrl: String(metadata.coverUrl ?? "").trim().slice(0, 2_000),
  previewUrl: String(metadata.previewUrl ?? "").trim().slice(0, 2_000),
  officialUrl: String(metadata.officialUrl ?? "").trim().slice(0, 2_000),
  searchSnippet: stripHtml(metadata.searchSnippet ?? "").slice(0, 1_000),
});

const normalizedCatalogResult = (item = {}) => {
  const provider = catalogSourceById.get(String(item.providerId ?? item.sourceId ?? ""));
  const title = String(item.title ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, 180);
  const url = String(item.url ?? "").trim();
  if (!provider || !title || !/^https:\/\//i.test(url)) return null;
  const externalId = String(item.externalId ?? item.id ?? url).trim();
  const metadata = commonMetadata(item.metadata);
  const readableUrl = [metadata.officialUrl, metadata.previewUrl, url].find((candidate) => officialBookSourceForUrl(candidate)) || "";
  return {
    id: catalogId(provider.id, externalId),
    providerId: provider.id,
    externalId: externalId.slice(0, 180),
    sourceId: provider.id,
    sourceName: provider.name,
    title,
    author: uniqueStrings(Array.isArray(item.author) ? item.author : [item.author], 8).join("、").slice(0, 180),
    description: stripHtml(item.description ?? "").slice(0, 1_200),
    url,
    readableUrl,
    availability: ["public_chapters", "public_preview", "metadata_only"].includes(item.availability) ? item.availability : "metadata_only",
    metadata,
  };
};

const linkedWikidataIds = (entities = {}) => uniqueStrings(Object.values(entities).flatMap((entity) => [
  ...entityIds(entity.claims, "P31"),
  ...entityIds(entity.claims, "P50"),
  ...entityIds(entity.claims, "P123"),
  ...entityIds(entity.claims, "P136"),
  ...entityIds(entity.claims, "P407"),
]), 200);

const wikidataEntities = async (ids, fetchImpl, signal) => {
  if (!ids.length) return {};
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|descriptions|claims",
    languages: "zh-hans|zh-cn|zh|en",
    format: "json",
    origin: "*",
  });
  return (await fetchCatalogJson(url, { fetchImpl, signal })).entities ?? {};
};

const wikidataWorksByAuthors = async (authorIds, fetchImpl, signal) => {
  const safeIds = uniqueStrings(authorIds, 8).filter((id) => /^Q\d+$/.test(id));
  if (!safeIds.length) return [];
  const query = `SELECT DISTINCT ?work WHERE { VALUES ?author { ${safeIds.map((id) => `wd:${id}`).join(" ")} } ?work wdt:P50 ?author . } LIMIT 60`;
  const url = new URL("https://query.wikidata.org/sparql");
  url.search = new URLSearchParams({ format: "json", query });
  try {
    const payload = await fetchCatalogJson(url, { fetchImpl, signal });
    return uniqueStrings((payload.results?.bindings ?? []).map((binding) => String(binding.work?.value ?? "").match(/\/(Q\d+)$/)?.[1]), 60);
  } catch {
    return [];
  }
};

export const searchWikidataBooks = async (query, { fetchImpl = fetch, signal } = {}) => {
  const search = await wikidataSearchItems(query, fetchImpl, signal);
  const ids = uniqueStrings(search.map((item) => item.id), 20);
  let entities = await wikidataEntities(ids, fetchImpl, signal);
  let linked = await wikidataEntities(linkedWikidataIds(entities), fetchImpl, signal);
  const authorIds = ids.filter((id) => {
    const entity = entities[id];
    const description = preferredEntityText(entity, "descriptions");
    const typeLabels = entityIds(entity?.claims, "P31").map((typeId) => entityLabel(linked, typeId));
    return /作家|作者|writer|novelist|author/i.test(`${description} ${typeLabels.join(" ")}`);
  });
  const authoredWorkIds = await wikidataWorksByAuthors(authorIds, fetchImpl, signal);
  if (authoredWorkIds.length) {
    entities = { ...entities, ...await wikidataEntities(authoredWorkIds, fetchImpl, signal) };
    linked = { ...linked, ...await wikidataEntities(linkedWikidataIds(entities).filter((id) => !linked[id]), fetchImpl, signal) };
  }
  const candidates = [
    ...search,
    ...authoredWorkIds.map((id) => ({ id, label: preferredEntityText(entities[id], "labels"), description: preferredEntityText(entities[id], "descriptions") })),
  ].filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id) === index);
  return candidates.map((searchItem) => {
    const entity = entities[searchItem.id];
    if (!entity) return null;
    const claims = entity.claims ?? {};
    const description = preferredEntityText(entity, "descriptions") || searchItem.description || "";
    const typeLabels = entityIds(claims, "P31").map((id) => entityLabel(linked, id));
    const positive = /小说|網路小說|网络小说|長篇|长篇|novel|fiction|literary work|book series|书籍|圖書/i.test(`${description} ${typeLabels.join(" ")}`);
    const negative = /电视剧|電視劇|电视节目|動畫|动画|电影|電影|游戏|遊戲|漫画|漫畫|television|film|anime|video game/i.test(`${description} ${typeLabels.join(" ")}`);
    if (!positive || negative) return null;
    const author = entityIds(claims, "P50").map((id) => entityLabel(linked, id));
    const publisher = entityIds(claims, "P123").map((id) => entityLabel(linked, id));
    const subjects = entityIds(claims, "P136").map((id) => entityLabel(linked, id));
    const languages = entityIds(claims, "P407").map((id) => entityLabel(linked, id));
    const image = String(firstEntityValue(claims, "P18") ?? "").trim();
    const officialUrl = String(firstEntityValue(claims, "P856") ?? firstEntityValue(claims, "P953") ?? "").trim();
    return normalizedCatalogResult({
      providerId: "wikidata",
      externalId: searchItem.id,
      title: preferredEntityText(entity, "labels") || searchItem.label,
      author,
      description,
      url: `https://www.wikidata.org/wiki/${encodeURIComponent(searchItem.id)}`,
      metadata: {
        publisher,
        publishedDate: plainDate(firstEntityValue(claims, "P577")),
        languages,
        subjects,
        identifiers: [{ type: "Wikidata", value: searchItem.id }, ...entityValues(claims, "P212").map((value) => ({ type: "ISBN-13", value })), ...entityValues(claims, "P957").map((value) => ({ type: "ISBN-10", value }))],
        coverUrl: image ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image)}?width=360` : "",
        officialUrl: /^https:\/\//i.test(officialUrl) ? officialUrl : "",
      },
    });
  }).filter(Boolean);
};

export const searchOpenLibraryBooks = async (query, { fetchImpl = fetch, signal } = {}) => {
  const url = new URL("https://openlibrary.org/search.json");
  url.search = new URLSearchParams({
    q: query,
    limit: "30",
    fields: "key,title,subtitle,author_name,first_publish_year,language,edition_count,cover_i,subject,isbn,publisher,ebook_access,public_scan_b,ia,number_of_pages_median,first_sentence",
  });
  const payload = await fetchCatalogJson(url, { fetchImpl, signal });
  return (payload.docs ?? []).map((item) => normalizedCatalogResult({
    providerId: "openlibrary",
    externalId: item.key,
    title: item.title,
    author: item.author_name,
    description: Array.isArray(item.first_sentence) ? item.first_sentence[0] : item.first_sentence,
    url: `https://openlibrary.org${item.key}`,
    availability: item.ebook_access === "public" || item.public_scan_b === true ? "public_preview" : "metadata_only",
    metadata: {
      subtitle: item.subtitle,
      publisher: item.publisher,
      publishedDate: item.first_publish_year,
      languages: item.language,
      subjects: item.subject,
      identifiers: (item.isbn ?? []).slice(0, 12).map((value) => ({ type: String(value).length === 13 ? "ISBN-13" : "ISBN", value })),
      pageCount: item.number_of_pages_median,
      editionCount: item.edition_count,
      coverUrl: item.cover_i ? `https://covers.openlibrary.org/b/id/${item.cover_i}-M.jpg` : "",
      previewUrl: item.ia?.[0] ? `https://archive.org/details/${encodeURIComponent(item.ia[0])}` : "",
    },
  })).filter(Boolean);
};

export const searchGoogleBooks = async (query, { fetchImpl = fetch, apiKey = "", signal } = {}) => {
  const cacheKey = createHash("sha256").update(`${String(query).trim().toLowerCase()}\n${apiKey ? "keyed" : "anonymous"}`).digest("hex");
  const cached = googleBooksCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.items);
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.search = new URLSearchParams({ q: query, maxResults: "30", printType: "books", projection: "full", ...(apiKey ? { key: apiKey } : {}) });
  const payload = await fetchCatalogJsonWithBackoff(url, { fetchImpl, signal });
  const items = (payload.items ?? []).map((item) => {
    const volume = item.volumeInfo ?? {};
    const access = item.accessInfo ?? {};
    return normalizedCatalogResult({
      providerId: "google-books",
      externalId: item.id,
      title: volume.title,
      author: volume.authors,
      description: volume.description,
      url: volume.infoLink || `https://books.google.com/books?id=${encodeURIComponent(item.id)}`,
      availability: access.viewability === "ALL_PAGES" ? "public_chapters" : ["PARTIAL", "SAMPLE"].includes(access.viewability) ? "public_preview" : "metadata_only",
      metadata: {
        subtitle: volume.subtitle,
        publisher: volume.publisher,
        publishedDate: volume.publishedDate,
        languages: [volume.language],
        subjects: volume.categories,
        identifiers: (volume.industryIdentifiers ?? []).map((identifier) => ({ type: identifier.type, value: identifier.identifier })),
        pageCount: volume.pageCount,
        coverUrl: volume.imageLinks?.thumbnail?.replace(/^http:/i, "https:") || "",
        previewUrl: volume.previewLink,
        searchSnippet: item.searchInfo?.textSnippet,
      },
    });
  }).filter(Boolean);
  googleBooksCache.set(cacheKey, { expiresAt: Date.now() + GOOGLE_BOOKS_CACHE_TTL_MS, items: structuredClone(items) });
  if (googleBooksCache.size > 200) {
    for (const [key, value] of googleBooksCache) if (value.expiresAt <= Date.now()) googleBooksCache.delete(key);
    while (googleBooksCache.size > 200) googleBooksCache.delete(googleBooksCache.keys().next().value);
  }
  return items;
};

const searchOfficialWebWithModel = async ({ term, settings, cwd, runModel, signal }) => {
  if (typeof runModel !== "function") return [];
  const sites = OFFICIAL_BOOK_SOURCES.map((source) => `${source.id}=${source.name}(${source.domains.join(",")})`).join("；");
  const result = await runModel({
    settings: { ...settings, webSearchEnabled: true, temperature: "0.1", maxOutputTokens: "3500" },
    cwd,
    attachments: [],
    signal,
    system: "你是正版小说网站书目搜索器。只返回公开书目元数据，不获取或输出小说正文，不使用聚合站、盗版站、网盘或转载页面。只输出 JSON 数组。",
    messages: [{ role: "user", content: `搜索书名或作者“${term}”。只检索下列官方小说网站：${sites}\n返回最多 30 条最相关结果。每项字段严格为 sourceId、title、author、description、url、availability；availability 只能是 public_chapters、public_preview、metadata_only。url 必须是作品详情页或官方目录页，不能是搜索结果页。没有可靠结果就返回 []。` }],
  });
  return parseJsonArray(result.text).map(normalizeBookResult).filter(Boolean);
};

const searchResultScore = (item, term) => {
  const query = term.toLowerCase().replace(/\s+/g, "");
  const title = item.title.toLowerCase().replace(/\s+/g, "");
  const author = item.author.toLowerCase().replace(/\s+/g, "");
  return (title === query ? 120 : title.includes(query) ? 80 : query.includes(title) ? 55 : 0)
    + (author.includes(query) ? 40 : 0)
    + (item.availability === "public_chapters" ? 8 : item.availability === "public_preview" ? 4 : 0);
};

const htmlMetaContent = (html = "", names = []) => {
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["']`, "i"),
    ];
    const match = patterns.map((pattern) => String(html).match(pattern)?.[1]).find(Boolean);
    if (match) return decodeEntities(match).replace(/\s+/g, " ").trim();
  }
  return "";
};

const inspectOfficialBookLink = async ({ url, fetchImpl = fetch, lookupImpl = lookup }) => {
  const source = officialBookSourceForUrl(url);
  if (!source) throw new Error("该链接不属于当前支持的正版小说网站");
  const page = await fetchOfficialHtml(url, source.id, { fetchImpl, lookupImpl });
  const pageText = stripHtml(mainHtml(page.html, source.id));
  const title = htmlTitle(page.html, source.name).replace(/\s*[-_|｜].*$/, "").trim() || source.name;
  const author = htmlMetaContent(page.html, ["author", "book:author", "og:novel:author"]).slice(0, 100);
  const description = (htmlMetaContent(page.html, ["description", "og:description"]) || pageText.slice(0, 400)).slice(0, 400);
  const identityTokens = identityTokensFor(new URL(page.url));
  const hasDirectoryOrChapter = extractLinks(page.html, page.url).some((link) => linkedPageAllowed({ link, source, identityTokens, depth: 0 }));
  return normalizeBookResult({
    sourceId: source.id,
    title,
    author,
    description,
    url: page.url,
    readableUrl: page.url,
    availability: hasDirectoryOrChapter ? "public_chapters" : pageText.length >= 300 ? "public_preview" : "metadata_only",
  });
};

const supportedSearchProviderIds = new Set(BOOK_CATALOG_SOURCES.map((source) => source.id));
const normalizedSearchProviderIds = (providerIds) => {
  const requested = Array.isArray(providerIds) ? providerIds.map(String).filter((id) => supportedSearchProviderIds.has(id)) : [];
  return requested.length ? [...new Set(requested)] : BOOK_CATALOG_SOURCES.map((source) => source.id);
};

const searchCacheKeyFor = ({ term, providerIds, settings, catalogMode }) => createHash("sha256").update(JSON.stringify({
  term: String(term).trim().toLocaleLowerCase("zh-CN"),
  providerIds: [...providerIds].sort(),
  provider: String(settings.provider || ""),
  model: String(settings.model || ""),
  connectionId: String(settings.connectionId || settings.id || ""),
  googleBooksKeyed: Boolean(settings.googleBooksApiKey || process.env.GOOGLE_BOOKS_API_KEY),
  catalogMode,
})).digest("hex");

const pruneBookSearchCache = () => {
  for (const [key, value] of bookSearchCache) if (value.expiresAt <= Date.now()) bookSearchCache.delete(key);
  while (bookSearchCache.size > BOOK_SEARCH_CACHE_LIMIT) bookSearchCache.delete(bookSearchCache.keys().next().value);
};

const runSearchProvider = async (provider, timeoutMs) => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutError = new Error(`${provider.name}搜索超过 ${Math.ceil(timeoutMs / 1000)} 秒，已先返回其他来源`);
  timeoutError.code = "BOOK_SEARCH_PROVIDER_TIMEOUT";
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    const aborted = new Promise((_, rejectAbort) => controller.signal.addEventListener("abort", () => rejectAbort(controller.signal.reason || timeoutError), { once: true }));
    const items = await Promise.race([provider.run(controller.signal), aborted]);
    return { ok: true, items: Array.isArray(items) ? items : [], durationMs: Date.now() - startedAt, error: "", timeout: false };
  } catch (error) {
    return {
      ok: false,
      items: [],
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 160),
      timeout: error?.code === "BOOK_SEARCH_PROVIDER_TIMEOUT" || controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
};

const executeOfficialBookSearch = async ({ term, settings, cwd, runModel, fetchImpl, providerIds, providerTimeoutMs, catalogMode }) => {
  const startedAt = Date.now();
  const googleBooksApiKey = settings.googleBooksApiKey || process.env.GOOGLE_BOOKS_API_KEY || "";
  const allProviders = [
    { id: "wikidata", name: "Wikidata", run: (signal) => catalogMode === "fast"
      ? searchWikidataBookBasics(term, { fetchImpl, signal })
      : searchWikidataBooks(term, { fetchImpl, signal }) },
    { id: "openlibrary", name: "Open Library", run: (signal) => searchOpenLibraryBooks(term, { fetchImpl, signal }) },
    { id: "google-books", name: "Google Books", run: (signal) => searchGoogleBooks(term, { fetchImpl, apiKey: googleBooksApiKey, signal }) },
    { id: "official-web", name: "正版小说网站", run: (signal) => searchOfficialWebWithModel({ term, settings, cwd, runModel, signal }) },
  ];
  const providers = allProviders.filter((provider) => providerIds.includes(provider.id));
  const settled = await Promise.all(providers.map((provider) => runSearchProvider(provider, providerTimeoutMs)));
  const sourceStatus = settled.map((result, index) => ({
    id: providers[index].id,
    name: providers[index].name,
    ok: result.ok,
    count: result.items.length,
    error: result.error,
    timeout: result.timeout,
    durationMs: result.durationMs,
  }));
  const items = settled.flatMap((result) => result.items);
  const unique = items.filter((item, index, values) => values.findIndex((candidate) => candidate.url === item.url) === index)
    .sort((left, right) => searchResultScore(right, term) - searchResultScore(left, term) || left.title.localeCompare(right.title, "zh-CN"))
    .slice(0, 60);
  return {
    query: term,
    items: unique,
    sources: [...BOOK_CATALOG_SOURCES, ...OFFICIAL_BOOK_SOURCES],
    providers: sourceStatus,
    providerIds,
    partial: sourceStatus.some((source) => !source.ok),
    cached: false,
    durationMs: Date.now() - startedAt,
  };
};

export const searchOfficialBooks = async ({ query, settings = {}, cwd, runModel, fetchImpl = fetch, lookupImpl = lookup, providerIds: requestedProviderIds, providerTimeoutMs = DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS, cacheResults = true, catalogMode = "detailed" }) => {
  const rawQuery = String(query ?? "").trim();
  const looksLikeUrl = /^https?:\/\//i.test(rawQuery);
  if (looksLikeUrl) {
    const directItem = await inspectOfficialBookLink({ url: rawQuery.slice(0, 2_000), fetchImpl, lookupImpl });
    return {
      query: rawQuery,
      items: directItem ? [directItem] : [],
      sources: [...BOOK_CATALOG_SOURCES, ...OFFICIAL_BOOK_SOURCES],
      providers: [{ id: "direct-link", name: "小说链接", ok: Boolean(directItem), count: directItem ? 1 : 0, error: "" }],
      partial: false,
      directLink: true,
    };
  }
  const term = rawQuery.slice(0, 120);
  if (term.length < 2) throw new Error("请输入至少两个字的书名或作者名");
  const providerIds = normalizedSearchProviderIds(requestedProviderIds);
  const timeoutMs = Math.min(30_000, Math.max(250, Number(providerTimeoutMs) || DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS));
  const normalizedCatalogMode = catalogMode === "fast" ? "fast" : "detailed";
  const canCache = cacheResults !== false && fetchImpl === fetch && lookupImpl === lookup;
  if (!canCache) return executeOfficialBookSearch({ term, settings, cwd, runModel, fetchImpl, providerIds, providerTimeoutMs: timeoutMs, catalogMode: normalizedCatalogMode });
  pruneBookSearchCache();
  const cacheKey = searchCacheKeyFor({ term, providerIds, settings, catalogMode: normalizedCatalogMode });
  const cached = bookSearchCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return { ...structuredClone(cached.result), cached: true, durationMs: 0 };
  if (bookSearchInFlight.has(cacheKey)) return { ...structuredClone(await bookSearchInFlight.get(cacheKey)), coalesced: true };
  const task = executeOfficialBookSearch({ term, settings, cwd, runModel, fetchImpl, providerIds, providerTimeoutMs: timeoutMs, catalogMode: normalizedCatalogMode });
  bookSearchInFlight.set(cacheKey, task);
  try {
    const result = await task;
    bookSearchCache.set(cacheKey, {
      expiresAt: Date.now() + (result.partial ? BOOK_SEARCH_PARTIAL_CACHE_TTL_MS : BOOK_SEARCH_CACHE_TTL_MS),
      result: structuredClone(result),
    });
    pruneBookSearchCache();
    return result;
  } finally {
    if (bookSearchInFlight.get(cacheKey) === task) bookSearchInFlight.delete(cacheKey);
  }
};

const loginRequiredPage = (title, text) => classifyOfficialBookPage({ title, text }) === "login_required";
const paidRestrictedPage = (title, text) => classifyOfficialBookPage({ title, text }) === "paid";
const restrictedPage = (title, text) => loginRequiredPage(title, text) || paidRestrictedPage(title, text) || /客户端阅读/i.test(`${title}\n${text.slice(0, 2500)}`) && text.length < 1800;

const identityTokensFor = (url) => [...new Set(`${url.pathname}${url.search}`.match(/[A-Za-z0-9_-]{5,}/g) ?? [])]
  .filter((token) => /\d{3,}/.test(token) || token.length >= 10)
  .slice(0, 4);

const linkedPageRole = ({ link, source, identityTokens, depth }) => {
  if (officialBookSourceForUrl(link.url)?.id !== source.id) return "blocked";
  const url = new URL(link.url);
  if (/\.(?:jpe?g|png|gif|webp|svg|css|js|json|xml|zip|rar|7z|pdf|epub|apk)(?:$|\?)/i.test(url.pathname)) return "blocked";
  if (identityTokens.length && !identityTokens.some((token) => `${url.pathname}${url.search}`.includes(token))) return "other";
  return classifyOfficialBookLink({ sourceId: source.id, text: link.text, url: `${url.pathname}${url.search}`, depth });
};

const linkedPageAllowed = (input) => ["directory", "chapter"].includes(linkedPageRole(input));

export const importReadableOfficialBook = async ({ url: requestedUrl, sourceId = "", title = "", maxPages = MAX_IMPORT_PAGES, fetchImpl = fetch, lookupImpl = lookup } = {}) => {
  const verified = await validateOfficialUrl(requestedUrl, sourceId, { lookupImpl });
  const source = verified.source;
  const rootUrl = verified.url;
  const identityTokens = identityTokensFor(rootUrl);
  const queue = [{ url: rootUrl.href, depth: 0, label: title || source.name, role: "root" }];
  const queued = new Set([rootUrl.href]);
  const visited = new Set();
  const documents = [];
  const failures = [];
  const fingerprints = new Set();
  const pageLimit = Math.min(Math.max(Number(maxPages) || MAX_IMPORT_PAGES, 1), MAX_IMPORT_PAGES);
  let totalCharacters = 0;
  let authenticationChallenge = null;
  let requestedChapterCount = 0;
  let successfulChapterCount = 0;
  let loginRestrictedCount = 0;
  let paidSkippedCount = 0;
  const extractionModes = new Set();

  while (queue.length && visited.size < pageLimit && totalCharacters < MAX_IMPORT_CHARACTERS) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);
    if (current.role === "chapter") requestedChapterCount += 1;
    try {
      const page = await fetchOfficialHtml(current.url, source.id, { fetchImpl, lookupImpl });
      extractionModes.add(page.extractionMode || "static_html");
      const pageTitle = htmlTitle(page.html, current.label || title || source.name);
      const text = stripHtml(mainHtml(page.html, source.id));
      for (const link of extractLinks(page.html, page.url)) {
        const role = linkedPageRole({ link, source, identityTokens, depth: current.depth });
        if (!["directory", "chapter"].includes(role) || queued.has(link.url) || visited.has(link.url)) continue;
        queued.add(link.url);
        queue.push({ url: link.url, depth: current.depth + 1, label: link.text, role });
      }
      const pageClass = classifyOfficialBookPage({ title: pageTitle, text });
      if (pageClass === "login_required") {
        loginRestrictedCount += 1;
        authenticationChallenge ??= bookAuthenticationChallenge({ source, html: page.html, returnUrl: page.url, reason: `${source.name}要求登录后读取免费章节` });
        continue;
      }
      if (pageClass === "paid") {
        paidSkippedCount += 1;
        continue;
      }
      if (pageClass !== "readable" || restrictedPage(pageTitle, text)) continue;
      const fingerprint = createHash("sha256").update(text).digest("hex");
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      const accepted = text.slice(0, MAX_IMPORT_CHARACTERS - totalCharacters);
      totalCharacters += accepted.length;
      if (current.role === "chapter") successfulChapterCount += 1;
      documents.push({ title: pageTitle, url: page.url, text: accepted, characters: accepted.length, pageType: current.role, extractionMode: page.extractionMode || "static_html" });
    } catch (error) {
      if (isBookAuthenticationRequiredError(error)) {
        loginRestrictedCount += 1;
        authenticationChallenge ??= error;
        continue;
      }
      failures.push({ url: current.url, reason: String(error.message || error).slice(0, 180) });
    }
  }

  const limitReached = queue.length > 0 || visited.size >= pageLimit || totalCharacters >= MAX_IMPORT_CHARACTERS;
  const coverage = {
    sourceId: source.id,
    sourceName: source.name,
    rootUrl: rootUrl.href,
    requestedChapterCount,
    successfulChapterCount,
    loginRestrictedCount,
    paidSkippedCount,
    pagesVisited: visited.size,
    readableDocuments: documents.length,
    characters: totalCharacters,
    failures: failures.length,
    failedUrls: failures.map((failure) => failure.url).slice(0, 100),
    extractionModes: [...extractionModes],
    limitReached,
    completeReadableCoverage: !limitReached && queue.length === 0,
  };
  if (authenticationChallenge) {
    authenticationChallenge.coverage = coverage;
    throw authenticationChallenge;
  }
  if (!documents.length && paidSkippedCount === 0 && !extractionModes.has("controlled_browser_dom")) {
    const challenge = bookAuthenticationChallenge({
      source,
      returnUrl: rootUrl.href,
      reason: `${source.name}需要在关联浏览器中登录或完成页面验证后读取免费章节`,
    });
    challenge.coverage = coverage;
    throw challenge;
  }
  if (!documents.length) throw Object.assign(new Error("没有从该正版页面取得可读取正文；页面可能需要登录、禁止自动读取或只提供元数据"), { coverage });
  const resolvedTitle = String(title || documents[0]?.title || "公开小说样本").replace(/[\r\n]+/g, " ").slice(0, 160);
  const header = [
    `# ${resolvedTitle}｜正版公开信息资料包`,
    "",
    `- 来源平台：${source.name}`,
    `- 入口链接：${rootUrl.href}`,
    `- 实际读取页面：${documents.length}`,
    `- 章节覆盖：请求 ${requestedChapterCount}，成功 ${successfulChapterCount}，登录限制 ${loginRestrictedCount}，付费跳过 ${paidSkippedCount}`,
    `- 实际读取字符：${totalCharacters}`,
    `- 可读取范围遍历：${coverage.completeReadableCoverage ? "已完成" : "达到读取上限，未宣称完整"}`,
    `- 失败页面：${failures.length}`,
    "- 权威状态：公开来源参考资料，不是作品正史；付费和不可访问章节未纳入，需登录的免费章节仅在用户完成隔离登录后读取。",
  ].join("\n");
  const body = documents.map((document, index) => `\n\n---\n\n## 页面 ${index + 1}｜${document.title}\n\n来源：${document.url}\n\n${document.text}`).join("");
  return {
    title: resolvedTitle,
    source,
    coverage,
    documents: documents.map(({ text, ...document }) => document),
    failures: failures.slice(0, 100),
    text: `${header}${body}`,
  };
};

export const BOOK_REFERENCE_SECTIONS = Object.freeze(["description", "links", "publicContent"]);

const safeReferenceLine = (value = "", limit = 2_000) => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, limit);
const safeReferenceUrl = (value = "") => {
  try {
    const url = new URL(String(value ?? "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    url.hash = "";
    return url.href.slice(0, 2_000);
  } catch {
    return "";
  }
};
const safeBookForReference = (book = {}) => {
  const metadata = commonMetadata(book.metadata);
  return {
    id: safeReferenceLine(book.id, 180),
    providerId: safeReferenceLine(book.providerId || book.sourceId, 80),
    sourceId: safeReferenceLine(book.sourceId || book.providerId, 80),
    sourceName: safeReferenceLine(book.sourceName, 120),
    title: safeReferenceLine(book.title, 180) || "未命名小说",
    author: safeReferenceLine(book.author, 180),
    description: stripHtml(book.description ?? "").slice(0, 8_000),
    url: safeReferenceUrl(book.url),
    readableUrl: safeReferenceUrl(book.readableUrl),
    availability: ["public_chapters", "public_preview", "metadata_only"].includes(book.availability) ? book.availability : "metadata_only",
    metadata: {
      ...metadata,
      coverUrl: safeReferenceUrl(metadata.coverUrl),
      previewUrl: safeReferenceUrl(metadata.previewUrl),
      officialUrl: safeReferenceUrl(metadata.officialUrl),
    },
  };
};

const metadataReferenceText = (book, selected) => {
  const sections = [`# ${book.title}｜小说引用资料`, "", `- 资料来源：${book.sourceName || book.sourceId || "公开书目"}`, `- 来源记录：${book.url || "未提供"}`, `- 选用范围：${["基本信息（固定）", ...selected].join("、")}`, "- 权威状态：外部参考资料，不自动写入作品正史。"];
  sections.push("", "## 基本信息", "", `- 书名：${book.title}`, `- 作者：${book.author || "未提供"}`, ...(book.metadata.subtitle ? [`- 副标题：${book.metadata.subtitle}`] : []), `- 可访问状态：${book.availability === "public_chapters" ? "存在公开章节" : book.availability === "public_preview" ? "存在公开预览" : "仅书目资料"}`);
  if (selected.has("description") && book.description) sections.push("", "## 内容简介", "", book.description);
  if (selected.has("links")) {
    const links = [
      book.url ? `- 来源记录：${book.url}` : "",
      book.metadata.officialUrl ? `- 官方链接：${book.metadata.officialUrl}` : "",
      book.metadata.previewUrl ? `- 预览链接：${book.metadata.previewUrl}` : "",
      book.metadata.coverUrl ? `- 封面链接：${book.metadata.coverUrl}` : "",
    ].filter(Boolean);
    if (links.length) sections.push("", "## 来源链接", "", ...links);
  }
  return sections.join("\n").trim();
};

export const createSelectedBookReference = async ({ book: rawBook = {}, selectedSections = [], maxPages, fetchImpl = fetch, lookupImpl = lookup, requireSelectedPublicContent = false } = {}) => {
  const book = safeBookForReference(rawBook);
  const selected = new Set((selectedSections ?? []).filter((section) => BOOK_REFERENCE_SECTIONS.includes(section)));
  const source = sourceById.get(book.sourceId) || catalogSourceById.get(book.providerId) || { id: book.sourceId || "catalog", name: book.sourceName || "公开书目" };
  let publicImport = null;
  let publicContentWarning = "";
  if (selected.has("publicContent")) {
    const readableUrl = [book.readableUrl, book.metadata.officialUrl, book.metadata.previewUrl, book.url].find((candidate) => officialBookSourceForUrl(candidate));
    if (!readableUrl) publicContentWarning = "该结果没有可读取的正版公开页面，已保留基本信息与其他所选资料";
    else {
      try {
        const readableSource = officialBookSourceForUrl(readableUrl);
        publicImport = await importReadableOfficialBook({ url: readableUrl, sourceId: readableSource?.id || book.sourceId, title: book.title, maxPages, fetchImpl, lookupImpl });
      } catch (error) {
        if (isBookAuthenticationRequiredError(error)) throw error;
        if (requireSelectedPublicContent) throw error;
        publicContentWarning = `${String(error.message || error).replace(/^Invalid URL$/i, "小说链接格式无效")}；已保留基本信息与其他所选资料`;
      }
    }
  }
  const metadataText = metadataReferenceText(book, selected);
  const publicText = publicImport ? `\n\n---\n\n## 官方公开章节与试读\n\n${publicImport.text}` : "";
  const coverage = publicImport?.coverage ?? {
    sourceId: source.id,
    sourceName: source.name,
    rootUrl: book.url,
    requestedChapterCount: 0,
    successfulChapterCount: 0,
    loginRestrictedCount: 0,
    paidSkippedCount: 0,
    pagesVisited: 0,
    readableDocuments: 0,
    characters: metadataText.length,
    failures: publicContentWarning ? 1 : 0,
    failedUrls: [],
    extractionModes: [],
    limitReached: false,
    completeReadableCoverage: false,
  };
  return {
    title: book.title,
    source,
    coverage: { ...coverage, selectedSections: [...selected], includesPublicContent: Boolean(publicImport), publicContentWarning },
    documents: publicImport?.documents ?? [],
    failures: publicImport?.failures ?? [],
    text: `${metadataText}${publicText}`,
  };
};
