import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const validBuildId = (value) => /^(?:[1-9]\d{12,30}|dev-[a-f0-9]{8,64})$/.test(String(value || ""));

const releaseBuildPath = (appRoot) => join(appRoot, "release-build.json");

/**
 * 生成基于 UTC 时间戳的 buildId，格式 yyyyMMddHHmmssfff（17 位数字）。
 * 与 release-build.json 中既有的 buildId 格式一致，并通过 validBuildId 校验。
 */
export const generateBuildId = (date = new Date()) => {
  const pad = (value, width) => String(value).padStart(width, "0");
  const utc = new Date(date);
  return (
    String(utc.getUTCFullYear()) +
    pad(utc.getUTCMonth() + 1, 2) +
    pad(utc.getUTCDate(), 2) +
    pad(utc.getUTCHours(), 2) +
    pad(utc.getUTCMinutes(), 2) +
    pad(utc.getUTCSeconds(), 2) +
    pad(utc.getUTCMilliseconds(), 3)
  );
};

/**
 * 读取 release-build.json；缺失或不可解析时返回 null。
 */
export const readReleaseBuildManifest = async (appRoot) => {
  try {
    return JSON.parse((await readFile(releaseBuildPath(appRoot), "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
};

/**
 * 读取 release-build.json，并在 buildId 失效（缺失或格式非法）时生成新的时间戳 buildId，
 * 同时尽量写回 release-build.json。返回标准化的构建身份，供 server.mjs 与
 * update-data-guard.mjs 使用。
 */
export const ensureFreshBuildIdentity = async ({
  appRoot,
  packageMetadata = {},
  now = new Date(),
} = {}) => {
  const manifest = await readReleaseBuildManifest(appRoot);
  const previousBuildId = String(manifest?.buildId || "").trim();
  let buildId = previousBuildId;
  let createdAt = String(manifest?.createdAt || "");
  let persisted = false;

  if (!validBuildId(buildId)) {
    buildId = generateBuildId(now);
    createdAt = createdAt || now.toISOString();
    const next = {
      schemaVersion: Number(manifest?.schemaVersion ?? 1),
      version: String(packageMetadata.version || manifest?.version || "0.0.0"),
      dataSchemaVersion: Number(packageMetadata.dataSchemaVersion ?? manifest?.dataSchemaVersion ?? 1),
      buildId,
      commit: String(manifest?.commit || "UNCOMMITTED"),
      createdAt,
      publishable: manifest?.publishable !== false,
    };
    try {
      // appRoot 在已安装目录下可能只读；此时仅在内存中使用新生成的 buildId。
      await mkdir(dirname(releaseBuildPath(appRoot)), { recursive: true });
      await writeFile(releaseBuildPath(appRoot), `${JSON.stringify(next, null, 2)}\n`, "utf8");
      persisted = true;
    } catch {
      persisted = false;
    }
  } else {
    persisted = Boolean(manifest);
  }

  const dataSchemaVersion = Number(manifest?.dataSchemaVersion ?? packageMetadata.dataSchemaVersion ?? 1);
  if (!Number.isSafeInteger(dataSchemaVersion) || dataSchemaVersion <= 0) throw new Error("dataSchemaVersion 无效");
  if (!validBuildId(buildId)) throw new Error("buildId 无效");

  return {
    schemaVersion: 1,
    version: String(packageMetadata.version || manifest?.version || "0.0.0"),
    dataSchemaVersion,
    buildId,
    packaged: Boolean(manifest && validBuildId(previousBuildId)),
    commit: String(manifest?.commit || ""),
    createdAt,
    refreshed: !validBuildId(previousBuildId),
    persisted,
  };
};

export const loadBuildIdentity = async ({ appRoot, packageMetadata = {}, runtimeBuildHash = "" } = {}) => {
  let packaged = null;
  try { packaged = JSON.parse((await readFile(join(appRoot, "release-build.json"), "utf8")).replace(/^\uFEFF/, "")); } catch {}
  const dataSchemaVersion = Number(packaged?.dataSchemaVersion ?? packageMetadata.dataSchemaVersion ?? 1);
  if (!Number.isSafeInteger(dataSchemaVersion) || dataSchemaVersion <= 0) throw new Error("dataSchemaVersion 无效");
  const packagedBuildId = String(packaged?.buildId || "").trim();
  const buildId = validBuildId(packagedBuildId)
    ? packagedBuildId
    : `dev-${String(runtimeBuildHash || "unversioned").replace(/[^a-f0-9]/gi, "").toLowerCase().slice(0, 24).padEnd(8, "0")}`;
  if (!validBuildId(buildId)) throw new Error("buildId 无效");
  return {
    schemaVersion: 1,
    version: String(packageMetadata.version || packaged?.version || "0.0.0"),
    dataSchemaVersion,
    buildId,
    packaged: Boolean(packaged && validBuildId(packagedBuildId)),
    commit: String(packaged?.commit || ""),
    createdAt: String(packaged?.createdAt || ""),
  };
};
