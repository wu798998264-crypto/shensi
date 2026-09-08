import { createHash, createPublicKey, verify } from "node:crypto";

const CACHE_MS = 30_000;
const FAILURE_BACKOFF_MIN_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 300_000;
let cached = null;
let refreshInFlight = null;
let consecutiveFailures = 0;
let retryAt = 0;
const REMOTE_PACKAGE_LIMITS = Object.freeze({ skill: 4 * 1024 * 1024, module: 2 * 1024 * 1024, group: 2 * 1024 * 1024, template: 2 * 1024 * 1024 });

export const assertRemoteMarketplaceSkillIdentity = ({ artifactId, skillId } = {}) => {
  const outer = String(artifactId || "");
  const inner = String(skillId || "");
  if (!outer || !inner || outer !== inner) throw new Error("远程 Skill 包 ID 与签名广场 artifactId 不一致，已拒绝跨身份覆盖");
  return true;
};

const configuredBaseUrl = () => {
  const raw = String(process.env.SHENSI_MARKETPLACE_URL || "").trim().replace(/\/$/, "");
  if (!raw) return "";
  const url = new URL(raw);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Skill 广场只允许 HTTPS 或本机联调地址");
  return url.href.replace(/\/$/, "");
};

const pinnedPublicKey = () => String(process.env.SHENSI_MARKETPLACE_PUBLIC_KEY_PEM || "").replace(/\\n/g, "\n").trim();

const disconnected = (message = "云端分享与下载服务尚未连接；当前仅显示本地官方目录") => ({
  connected: false,
  mode: "local_catalog",
  message,
  remoteItems: [],
  health: null,
});

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ShensiCreativeEngine-MarketplaceClient" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`远程 Skill 广场返回 HTTP ${response.status}`);
  return response.json();
};

export const marketplaceArtifactSignaturePayload = (record = {}) => Buffer.from(JSON.stringify({
  schemaVersion: 2,
  artifactId: String(record.artifactId),
  version: String(record.version),
  assetType: String(record.assetType),
  packageFormat: String(record.packageFormat),
  sha256: String(record.sha256).toLowerCase(),
  sizeBytes: Number(record.sizeBytes),
  objectKey: String(record.objectKey),
  publisherRole: record.publisherRole === "admin" ? "admin" : "user",
  trustLevel: record.trustLevel === "official" ? "official" : record.trustLevel === "verified" ? "verified" : "community",
}), "utf8");

const validPackageDeclaration = (item = {}) => {
  const type = ["skill", "module", "group", "template"].includes(item.assetType) ? item.assetType : "";
  const expectedFormat = type === "skill" ? "shensi-skill-package-v1" : type ? "shensi-capability-package-v1" : "";
  const sizeBytes = Number(item.sizeBytes);
  return Boolean(type && item.packageFormat === expectedFormat && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= REMOTE_PACKAGE_LIMITS[type]);
};

export const verifyRemoteMarketplaceCatalogItem = (item = {}) => {
  try {
    if (item.signature?.schemaVersion !== 2 || item.signature?.algorithm !== "Ed25519" || !item.objectKey || !validPackageDeclaration(item)) return false;
    return verify(null, marketplaceArtifactSignaturePayload(item), createPublicKey(pinnedPublicKey()), Buffer.from(String(item.signature.signature || ""), "base64url"));
  } catch {
    return false;
  }
};

const publicRemoteItem = (item = {}) => ({
  id: `remote:${String(item.artifactId || "")}@${String(item.version || "")}`,
  remoteArtifactId: String(item.artifactId || ""),
  remoteVersion: String(item.version || ""),
  assetType: ["skill", "module", "group", "template"].includes(item.assetType) ? item.assetType : "skill",
  packageFormat: String(item.packageFormat || ""),
  name: String(item.name || item.artifactId || "远程能力").slice(0, 160),
  author: String(item.author || "Skill 广场发布者").slice(0, 120),
  description: String(item.description || "").slice(0, 2_000),
  version: String(item.version || ""),
  hash: String(item.sha256 || ""),
  sizeBytes: Number(item.sizeBytes) || 0,
  trustLevel: item.trustLevel === "official" ? "official" : item.trustLevel === "verified" ? "verified" : "community",
  publisherRole: item.publisherRole === "admin" ? "admin" : "user",
  sourceType: "team_server",
  sourceLabel: "神思 Skill 广场",
  installed: false,
  downloadable: verifyRemoteMarketplaceCatalogItem(item),
  rating: Number(item.rating) || 0,
  ratingCount: Number(item.ratingCount) || 0,
  reviews: Array.isArray(item.reviews) ? item.reviews.slice(0, 50).map((review) => ({
    id: String(review.id || ""),
    authorName: String(review.authorName || "神思用户").slice(0, 80),
    avatarUrl: String(review.avatarUrl || "").slice(0, 500),
    rating: Number(review.rating) || 0,
    comment: String(review.comment || "").slice(0, 1_000),
    createdAt: review.createdAt || 0,
    updatedAt: review.updatedAt || review.createdAt || 0,
  })) : [],
  remote: true,
});

const nextFailureBackoffMs = () => Math.min(
  FAILURE_BACKOFF_MAX_MS,
  FAILURE_BACKOFF_MIN_MS * (2 ** Math.max(0, consecutiveFailures - 1)),
);

const refreshRemoteMarketplace = (baseUrl) => {
  if (refreshInFlight) return refreshInFlight;

  let refresh;
  refresh = (async () => {
    try {
      const [health, catalog] = await Promise.all([
        fetchJson(`${baseUrl}/health`),
        fetchJson(`${baseUrl}/v1/catalog?limit=100`),
      ]);
      const requiredHealthy = health.connected === true
        && health.postgres === true
        && health.objectStorage === true
        && health.malwareScanner === true
        && health.artifactSigning === true
        && health.signedCatalog === true
        && pinnedPublicKey().includes("PUBLIC KEY");
      if (!requiredHealthy) throw new Error("远程 Skill 广场健康检查未全部通过");
      if (catalog.connected !== true || !Array.isArray(catalog.items)) throw new Error("远程 Skill 广场目录响应无效");
      const value = {
        connected: true,
        mode: "remote_service",
        message: "已连接远程 Skill 广场；制品均需通过哈希、恶意文件扫描和服务端签名门禁。",
        remoteItems: catalog.items.map(publicRemoteItem).filter((item) => item.remoteArtifactId && item.remoteVersion && item.downloadable),
        health,
        baseUrl,
        capabilities: { catalog: true, download: true, publish: false, rating: false },
      };
      consecutiveFailures = 0;
      retryAt = 0;
      cached = { baseUrl, expiresAt: Date.now() + CACHE_MS, value };
      return value;
    } catch (error) {
      consecutiveFailures += 1;
      retryAt = Date.now() + nextFailureBackoffMs();
      const value = disconnected(`云端分享与下载服务尚未连接：${String(error.message || error).slice(0, 200)}`);
      cached = { baseUrl, expiresAt: retryAt, value };
      return value;
    } finally {
      if (refreshInFlight === refresh) refreshInFlight = null;
    }
  })();
  refreshInFlight = refresh;
  return refresh;
};

export const readRemoteMarketplace = async ({ force = false } = {}) => {
  let baseUrl;
  try { baseUrl = configuredBaseUrl(); } catch (error) { return disconnected(`云端分享与下载服务尚未连接：${error.message}`); }
  if (!baseUrl) return disconnected();

  const now = Date.now();
  const matchingCache = cached?.baseUrl === baseUrl ? cached : null;
  if (!force && matchingCache?.expiresAt > now) return structuredClone(matchingCache.value);
  if (retryAt > now) return structuredClone(matchingCache?.value ?? disconnected());
  if (refreshInFlight) {
    if (force) return structuredClone(await refreshInFlight);
    return structuredClone(matchingCache?.value ?? disconnected());
  }

  const refresh = refreshRemoteMarketplace(baseUrl);
  if (force) return structuredClone(await refresh);
  return structuredClone(matchingCache?.value ?? disconnected());
};

const parseRemoteId = (value = "") => {
  const match = String(value).match(/^remote:(.+)@([^@]+)$/);
  if (!match) throw new Error("远程广场制品 ID 无效");
  return { artifactId: match[1], version: match[2] };
};

export const downloadRemoteMarketplaceArtifact = async (id) => {
  const remote = await readRemoteMarketplace({ force: true });
  if (!remote.connected) throw new Error(remote.message || "远程 Skill 广场未连接");
  const { artifactId, version } = parseRemoteId(id);
  const descriptor = await fetchJson(`${remote.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/${encodeURIComponent(version)}/download`);
  const artifact = descriptor.artifact ?? {};
  if (artifact.artifactId !== artifactId || artifact.version !== version) throw new Error("远程广场返回了错误制品");
  if (!artifact.signature?.signature || !artifact.objectKey || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256)) || !validPackageDeclaration(artifact)) throw new Error("远程制品缺少有效签名、哈希或包类型声明");
  if (artifact.signature.schemaVersion !== 2 || artifact.signature.algorithm !== "Ed25519") throw new Error("远程制品签名协议版本不受支持");
  const signatureValid = verify(null, marketplaceArtifactSignaturePayload(artifact), createPublicKey(pinnedPublicKey()), Buffer.from(artifact.signature.signature, "base64url"));
  if (!signatureValid) throw new Error("远程制品签名校验失败");
  const response = await fetch(descriptor.downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`远程制品下载失败（${response.status}）`);
  const expectedBytes = Number(artifact.sizeBytes) || 0;
  const typeLimit = REMOTE_PACKAGE_LIMITS[artifact.assetType] || 0;
  if (expectedBytes <= 0 || expectedBytes > typeLimit) throw new Error("远程制品大小超过客户端类型上限");
  const reader = response.body.getReader();
  const chunks = [];
  const hash = createHash("sha256");
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes || total > typeLimit) { await reader.cancel(); throw new Error("远程制品下载字节超过声明值"); }
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    hash.update(chunk);
  }
  if (total !== expectedBytes || hash.digest("hex") !== String(artifact.sha256).toLowerCase()) throw new Error("远程制品字节或 SHA-256 校验失败");
  return { artifact, bytes: Buffer.concat(chunks, total) };
};
