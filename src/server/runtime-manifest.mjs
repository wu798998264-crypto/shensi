import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
export const RUNTIME_MANIFEST_FILE = "release-runtime-manifest.json";

const RUNTIME_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".md", ".nsh", ".ps1", ".svg", ".txt", ".woff", ".woff2", ".yaml", ".yml",
]);
const RUNTIME_CODE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".svg", ".woff", ".woff2",
]);
const RUNTIME_ASSET_EXTENSIONS = new Set([".ico", ".png", ".svg", ".woff", ".woff2"]);
const ROOT_FILES = ["server.mjs", "index.html", "update-config.json"];
const EXPLICIT_FILES = [
  "scripts/launcher.mjs",
  "scripts/update-installer-helper.mjs",
  "scripts/windows/dreamina-profile-runner.ps1",
];
const BUNDLED_MANIFEST = "packaging/bundled/shensi-bundle-manifest.json";

const posixRelative = (root, path) => relative(root, path).replaceAll("\\", "/");

const addFile = async ({ root, path, files }) => {
  const info = await stat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info?.isFile()) return;
  const relativePath = posixRelative(root, path);
  if (relativePath === RUNTIME_MANIFEST_FILE || relativePath === BUNDLED_MANIFEST) return;
  files.add(path);
};

const addDirectory = async ({ root, directory, files, extensions = RUNTIME_EXTENSIONS }) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await addDirectory({ root, directory: path, files, extensions });
    else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      await addFile({ root, path, files });
    }
  }
};

const bundledRuntimePaths = async (root) => {
  const sourceManifest = await readFile(join(root, BUNDLED_MANIFEST), "utf8")
    .then(JSON.parse)
    .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!sourceManifest?.files || !Array.isArray(sourceManifest.files)) return [];
  return sourceManifest.files
    .filter((file) => file?.role !== "reference-only" && String(file?.path || "").trim())
    .map((file) => join(root, "packaging", "bundled", "skill", "神思", String(file.path)));
};

const publicRuntimeAssetPaths = async (root) => {
  const directory = join(root, "public", "assets");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && /^shensi-[a-z-]+\.(?:ico|png|svg|woff2?)$/iu.test(entry.name)
      && RUNTIME_ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name));
};

export const runtimeManifestPaths = async (rootPath) => {
  const root = resolve(rootPath);
  const files = new Set();
  for (const relativePath of ROOT_FILES) await addFile({ root, path: join(root, relativePath), files });
  for (const relativePath of EXPLICIT_FILES) await addFile({ root, path: join(root, relativePath), files });
  await addDirectory({ root, directory: join(root, "src"), files, extensions: RUNTIME_CODE_EXTENSIONS });
  await addDirectory({ root, directory: join(root, "packaging", "windows", "desktop-app"), files, extensions: RUNTIME_CODE_EXTENSIONS });
  for (const path of await bundledRuntimePaths(root)) await addFile({ root, path, files });
  for (const path of await publicRuntimeAssetPaths(root)) await addFile({ root, path, files });
  return [...files].sort((left, right) => posixRelative(root, left).localeCompare(posixRelative(root, right), "en"));
};

const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

const entriesDigest = (entries) => createHash("sha256")
  .update(JSON.stringify(entries.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 }))))
  .digest("hex");

export const buildRuntimeManifest = async ({
  root: rootPath,
  version = "",
  buildId = "",
  sourceCommit = "",
  sourceDirty = false,
  sourceDirtyHash = "",
} = {}) => {
  const root = resolve(rootPath);
  const entries = [];
  for (const path of await runtimeManifestPaths(root)) {
    const info = await stat(path);
    entries.push({
      path: posixRelative(root, path),
      sizeBytes: info.size,
      sha256: await sha256File(path),
    });
  }
  const sourceHash = entriesDigest(entries);
  return {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    version: String(version || ""),
    buildId: String(buildId || ""),
    sourceCommit: String(sourceCommit || ""),
    sourceDirty: Boolean(sourceDirty),
    sourceDirtyHash: String(sourceDirtyHash || ""),
    algorithm: "sha256",
    sourceHash,
    entries,
  };
};

export const writeRuntimeManifest = async ({ root: rootPath, ...options } = {}) => {
  const root = resolve(rootPath);
  const manifest = await buildRuntimeManifest({ root, ...options });
  await writeFile(join(root, RUNTIME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

export const readRuntimeManifest = async (rootPath) => {
  try {
    return JSON.parse(await readFile(join(resolve(rootPath), RUNTIME_MANIFEST_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

export const verifyRuntimeManifest = async ({
  root: rootPath,
  expectedVersion = "",
  expectedBuildId = "",
  expectedSourceHash = "",
  requireManifest = false,
} = {}) => {
  const root = resolve(rootPath);
  const manifest = await readRuntimeManifest(root);
  if (!manifest) {
    if (requireManifest) throw new Error("发布运行清单缺失；拒绝启动或发布不完整的安装包");
    return { present: false, ok: true, manifest: null };
  }
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION || manifest.algorithm !== "sha256") {
    throw new Error("发布运行清单版本或校验算法无效");
  }
  if (expectedVersion && String(manifest.version) !== String(expectedVersion)) throw new Error("发布运行清单版本与应用版本不一致");
  if (expectedBuildId && String(manifest.buildId) !== String(expectedBuildId)) throw new Error("发布运行清单 buildId 与安装包不一致");
  if (expectedSourceHash && String(manifest.sourceHash) !== String(expectedSourceHash)) throw new Error("发布运行清单哈希与声明值不一致");
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("发布运行清单为空");
  const normalizedEntries = [...manifest.entries].sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
  if (entriesDigest(normalizedEntries) !== String(manifest.sourceHash)) throw new Error("发布运行清单自身摘要校验失败");
  const actualPaths = new Set((await runtimeManifestPaths(root)).map((path) => posixRelative(root, path)));
  const declaredPaths = new Set(normalizedEntries.map((entry) => String(entry.path || "").replaceAll("\\", "/")));
  if (actualPaths.size !== declaredPaths.size || [...actualPaths].some((path) => !declaredPaths.has(path))) {
    throw new Error("发布运行清单与实际运行文件集合不一致");
  }
  for (const entry of normalizedEntries) {
    const path = String(entry.path || "").replaceAll("\\", "/");
    if (!path || path.startsWith("/") || path.includes("../") || path === RUNTIME_MANIFEST_FILE) throw new Error(`发布运行清单路径越界：${path}`);
    const target = join(root, ...path.split("/"));
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new Error(`发布运行文件缺失：${path}`);
    if (Number(entry.sizeBytes) !== info.size || String(entry.sha256) !== await sha256File(target)) throw new Error(`发布运行文件校验失败：${path}`);
  }
  return { present: true, ok: true, manifest };
};

