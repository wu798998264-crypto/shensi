import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRankingSourceFixture, rankingSourceById, assertRankingSourceUrl } from "./ranking-source-registry.mjs";

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_URLS = Object.freeze({
  qidian: "https://www.qidian.com/rank/",
  jjwxc: "https://www.jjwxc.net/topten.php",
});
const FIXTURE_FILES = Object.freeze({ qidian: "qidian.html", jjwxc: "jjwxc.html" });

const fetchPublicHtml = async ({ sourceId, url, signal }) => {
  const safeUrl = assertRankingSourceUrl(sourceId, url);
  const timeoutSignal = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(safeUrl, {
    method: "GET",
    redirect: "error",
    signal: requestSignal,
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Shensi-Ranking-Scan/1.0 (public-page-readonly)" },
  });
  if (!response.ok) throw new Error(`${sourceId} 公开榜单返回 HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > RESPONSE_LIMIT) throw new Error(`${sourceId} 榜单响应超过安全上限`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > RESPONSE_LIMIT) throw new Error(`${sourceId} 榜单响应超过安全上限`);
  return new TextDecoder("utf-8").decode(buffer);
};

const readFixture = async (fixtureRoot, sourceId) => {
  const filename = FIXTURE_FILES[sourceId];
  if (!fixtureRoot || !filename) return "";
  return readFile(join(fixtureRoot, filename), "utf8");
};

export const createRankingCollectors = ({ fixtureRoot = "", browserService = null } = {}) => Object.fromEntries([
  ...["qidian", "jjwxc"].map((sourceId) => [sourceId, async ({ contract, collectedAt, signal }) => {
    const source = rankingSourceById(sourceId);
    const sourceUrl = DEFAULT_URLS[sourceId];
    const html = fixtureRoot
      ? await readFixture(fixtureRoot, sourceId)
      : await fetchPublicHtml({ sourceId, url: sourceUrl, signal });
    const items = parseRankingSourceFixture(sourceId, html, {
      rankingId: contract.rankings?.[0] || "ranking",
      channel: contract.channel,
      collectedAt,
      sourceUrl,
    }).slice(0, contract.topN);
    return { items, parserVersion: source.parserVersion, sourceUrls: [sourceUrl] };
  }]),
  ...["fanqie", "qimao", "ciweimao", "dianzhong"].map((sourceId) => [sourceId, async ({ contract, collectedAt }) => {
    if (!browserService) throw new Error(`${rankingSourceById(sourceId).name} 尚未配置隔离受控浏览会话`);
    if (contract.allowBrowserAccess !== true) throw new Error(`${rankingSourceById(sourceId).name} 浏览访问未获本轮明确授权`);
    throw new Error(`${rankingSourceById(sourceId).name} 实时解析器尚未通过 fixture 与真实页面双重核验`);
  }]),
  ["heiyan", async ({ contract }) => {
    const items = Array.isArray(contract.userSuppliedItems) ? contract.userSuppliedItems.slice(0, contract.topN) : [];
    if (!items.length) throw new Error("黑岩不读取登录态；请由用户上传公开榜单数据后再分析");
    return { items, parserVersion: "user-supplied-v1", sourceUrls: [] };
  }],
]);
