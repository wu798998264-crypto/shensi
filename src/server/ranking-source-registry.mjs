import { parseQidianRankingHtml, QIDIAN_PARSER_VERSION } from "./ranking-sources/qidian.mjs";
import { parseJjwxcRankingHtml, JJWXC_PARSER_VERSION } from "./ranking-sources/jjwxc.mjs";

const SOURCES = Object.freeze([
  { id: "qidian", name: "起点", acquisitionMode: "direct", hosts: ["www.qidian.com", "m.qidian.com"], path: /^\/(?:rank|book)(?:\/|$)/u, parserVersion: QIDIAN_PARSER_VERSION, fixtureVerified: true, liveVerified: false, requiresLogin: false },
  { id: "jjwxc", name: "晋江", acquisitionMode: "direct", hosts: ["www.jjwxc.net", "www.jjwxc.com"], path: /^\/(?:topten\.php|bookbase\.php|onebook\.php)/u, parserVersion: JJWXC_PARSER_VERSION, fixtureVerified: true, liveVerified: false, requiresLogin: false },
  { id: "fanqie", name: "番茄", acquisitionMode: "controlled_browser", hosts: ["fanqienovel.com", "www.fanqienovel.com"], path: /^\/rank(?:\/|$)/u, parserVersion: "unverified", fixtureVerified: false, liveVerified: false, requiresLogin: false },
  { id: "qimao", name: "七猫", acquisitionMode: "controlled_browser", hosts: ["www.qimao.com"], path: /^\/(?:rank|shuku)(?:\/|$)/u, parserVersion: "unverified", fixtureVerified: false, liveVerified: false, requiresLogin: false },
  { id: "ciweimao", name: "刺猬猫", acquisitionMode: "controlled_browser", hosts: ["www.ciweimao.com"], path: /^\/rank(?:\/|$)/u, parserVersion: "unverified", fixtureVerified: false, liveVerified: false, requiresLogin: false },
  { id: "dianzhong", name: "点众", acquisitionMode: "controlled_browser", hosts: ["www.dianzhong.com"], path: /^\//u, parserVersion: "unverified", fixtureVerified: false, liveVerified: false, requiresLogin: false },
  { id: "heiyan", name: "黑岩", acquisitionMode: "user_supplied", hosts: ["www.heiyan.com"], path: /^\//u, parserVersion: "blocked-token-source", fixtureVerified: false, liveVerified: false, requiresLogin: true },
]);
const BY_ID = new Map(SOURCES.map((item) => [item.id, item]));
const PRIVATE_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|0\.0\.0\.0|\[?::1\]?)$/iu;

export const rankingSourceCatalog = () => SOURCES.map(({ hosts, path, ...item }) => ({ ...item, allowedHosts: [...hosts], allowedPath: path.source }));
export const rankingSourceById = (id) => BY_ID.get(String(id)) || null;
export const assertRankingSourceUrl = (sourceId, value) => {
  const source = rankingSourceById(sourceId);
  if (!source) throw new Error("未知扫榜平台");
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("榜单 URL 无效"); }
  if (PRIVATE_HOST.test(url.hostname)) throw new Error("本机或内网地址不允许访问");
  if (url.protocol !== "https:") throw new Error("榜单只允许 HTTPS URL");
  if (!source.hosts.includes(url.hostname.toLowerCase()) || !source.path.test(url.pathname)) throw new Error("榜单 URL 不在平台白名单");
  return url;
};

export const parseRankingSourceFixture = (sourceId, html, options = {}) => {
  if (sourceId === "qidian") return parseQidianRankingHtml(html, options);
  if (sourceId === "jjwxc") return parseJjwxcRankingHtml(html, options);
  throw new Error(`${rankingSourceById(sourceId)?.name || sourceId} 尚未通过安全 fixture 解析核验`);
};
