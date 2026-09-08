import { createPublicKey, sign, verify } from "node:crypto";
import { basename } from "node:path";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;

const clean = (value = "", max = 200) => String(value || "").trim().slice(0, max);
const semver = (value = "") => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(clean(value, 80));
const sha256 = (value = "") => /^[a-f0-9]{64}$/.test(clean(value, 64).toLowerCase());

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, canonical(value[key])]));
};

export const stableJson = (value) => JSON.stringify(canonical(value));

const normalizeAsset = (asset = {}) => {
  const name = basename(clean(asset.name, 180));
  if (!name || name !== clean(asset.name, 180) || /[\\/:*?"<>|]/.test(name)) throw new Error("更新制品文件名无效");
  const sizeBytes = Number(asset.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error(`更新制品大小无效：${name}`);
  const digest = clean(asset.sha256, 64).toLowerCase();
  if (!sha256(digest)) throw new Error(`更新制品 SHA-256 无效：${name}`);
  const kind = ["installer", "portable", "symbols", "bundle"].includes(asset.kind) ? asset.kind : "bundle";
  const platform = ["win32-x64", "win32-arm64", "darwin-arm64", "darwin-x64"].includes(asset.platform) ? asset.platform : "";
  if (!platform) throw new Error(`更新制品平台无效：${name}`);
  return {
    name,
    kind,
    platform,
    sizeBytes,
    sha256: digest,
    authenticodePublisher: clean(asset.authenticodePublisher, 300),
  };
};

export const normalizeReleaseManifest = (manifest = {}, { requireSignature = true } = {}) => {
  if (Number(manifest.schemaVersion) !== RELEASE_MANIFEST_SCHEMA_VERSION) throw new Error("更新清单协议版本不受支持");
  const product = clean(manifest.product, 120);
  const version = clean(manifest.version, 80);
  const buildId = clean(manifest.buildId, 40);
  const channel = clean(manifest.channel, 40);
  const commit = clean(manifest.commit, 64).toLowerCase();
  const publishedAt = clean(manifest.publishedAt, 80);
  const runtimeBuildHash = clean(manifest.runtimeBuildHash, 80).toLowerCase();
  const minimumSupportedVersion = clean(manifest.minimumSupportedVersion, 80);
  const rollbackCompatibleFrom = clean(manifest.rollbackCompatibleFrom, 80);
  const supportEndsAt = clean(manifest.supportEndsAt, 80);
  const dataSchemaVersion = Number(manifest.dataSchemaVersion);
  if (!product || !semver(version) || !["stable", "beta", "internal"].includes(channel)) throw new Error("更新清单产品、版本或通道无效");
  if (!/^[1-9]\d{12,30}$/.test(buildId)) throw new Error("更新清单 buildId 无效");
  if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{16,64}$/.test(runtimeBuildHash)) throw new Error("更新清单缺少可追溯提交或构建哈希");
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) throw new Error("更新清单发布时间无效");
  if (!semver(minimumSupportedVersion) || !semver(rollbackCompatibleFrom)) throw new Error("更新清单支持版本边界无效");
  if (!Number.isSafeInteger(dataSchemaVersion) || dataSchemaVersion <= 0) throw new Error("更新清单数据 schema 版本无效");
  if (supportEndsAt && Number.isNaN(Date.parse(supportEndsAt))) throw new Error("更新清单支持截止日期无效");
  const assets = (Array.isArray(manifest.assets) ? manifest.assets : []).map(normalizeAsset);
  if (!assets.length) throw new Error("更新清单没有制品");
  if (new Set(assets.map((asset) => asset.name.toLocaleLowerCase("en-US"))).size !== assets.length) throw new Error("更新清单包含重复制品名");
  const normalized = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product,
    version,
    buildId,
    channel,
    commit,
    publishedAt: new Date(publishedAt).toISOString(),
    runtimeBuildHash,
    dataSchemaVersion,
    minimumSupportedVersion,
    rollbackCompatibleFrom,
    supportEndsAt: supportEndsAt ? new Date(supportEndsAt).toISOString() : "",
    assets,
  };
  if (requireSignature) {
    const signature = manifest.signature ?? {};
    if (Number(signature.schemaVersion) !== 1 || signature.algorithm !== "Ed25519" || !clean(signature.keyId, 120) || !clean(signature.value, 1_000)) {
      throw new Error("更新清单缺少有效签名描述");
    }
    normalized.signature = { schemaVersion: 1, algorithm: "Ed25519", keyId: clean(signature.keyId, 120), value: clean(signature.value, 1_000) };
  }
  return normalized;
};

export const releaseManifestPayload = (manifest = {}) => {
  const normalized = normalizeReleaseManifest(manifest, { requireSignature: false });
  return Buffer.from(stableJson(normalized), "utf8");
};

export const signReleaseManifest = ({ manifest, privateKeyPem, keyId }) => {
  if (!String(privateKeyPem || "").includes("PRIVATE KEY")) throw new Error("缺少更新清单 Ed25519 私钥");
  if (!clean(keyId, 120)) throw new Error("缺少更新清单签名密钥 ID");
  const unsigned = normalizeReleaseManifest(manifest, { requireSignature: false });
  return {
    ...unsigned,
    signature: {
      schemaVersion: 1,
      algorithm: "Ed25519",
      keyId: clean(keyId, 120),
      value: sign(null, releaseManifestPayload(unsigned), privateKeyPem).toString("base64url"),
    },
  };
};

export const verifyReleaseManifest = ({ manifest, publicKeyPem, expectedKeyId = "" }) => {
  const normalized = normalizeReleaseManifest(manifest);
  if (!String(publicKeyPem || "").includes("PUBLIC KEY")) throw new Error("缺少更新清单固定公钥");
  if (expectedKeyId && normalized.signature.keyId !== expectedKeyId) throw new Error("更新清单签名密钥 ID 不受信任");
  const valid = verify(null, releaseManifestPayload(normalized), createPublicKey(publicKeyPem), Buffer.from(normalized.signature.value, "base64url"));
  if (!valid) throw new Error("更新清单签名无效");
  return normalized;
};

export const releaseManifestAsset = (manifest, name) => normalizeReleaseManifest(manifest).assets.find((asset) => asset.name === basename(String(name || ""))) ?? null;
