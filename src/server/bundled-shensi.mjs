import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const BUNDLED_SHENSI_ID = "shensi-capability-bundle";
export const BUNDLED_SHENSI_ENTRY = "神思.md";
export const BUNDLED_SHENSI_RELATIVE_ROOT = Object.freeze(["packaging", "bundled", "skill", "神思"]);
export const BUNDLED_SHENSI_MANIFEST_RELATIVE_PATH = Object.freeze(["packaging", "bundled", "shensi-bundle-manifest.json"]);

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const portablePath = (value) => String(value).replaceAll("\\", "/");
const compareCodePoints = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const REFERENCE_ONLY_DIRECTORIES = new Set(["原始资料", "版本草案", "废弃设定", "_备份_不参与规则扫描"]);
const FORBIDDEN_DIRECTORIES = new Set(["_备份_不参与规则扫描", ".git", ".shensi", ".trash", "node_modules", "回收站"]);
const SENSITIVE_FILE_NAME = /^(?:_user_meta\.json|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|pfx|p12|jks|keystore))$/i;
const SKIP_FILE_NAMES = new Set([".gitkeep", ".gitignore", ".DS_Store"]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_BUNDLE_FILES = 5_000;
const MAX_BUNDLE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 100 * 1024 * 1024;
const resourceRole = (path) => {
  const segments = portablePath(path).split("/");
  if (segments.some((segment) => REFERENCE_ONLY_DIRECTORIES.has(segment))) return "reference-only";
  return path.toLowerCase().endsWith(".md") ? "runtime-content" : "runtime-data";
};
const fail = (code, message) => {
  throw new Error(`[${code}] ${message}`);
};

const assertInside = (target, parent, code) => {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  fail(code, "内置能力包路径越过应用目录");
};

export const resolveBundledShensiRoot = ({ appRoot } = {}) => {
  const canonicalAppRoot = resolve(String(appRoot || ""));
  if (!appRoot) fail("SHENSI_BUNDLE_APP_ROOT_REQUIRED", "缺少应用根目录");
  const target = resolve(canonicalAppRoot, ...BUNDLED_SHENSI_RELATIVE_ROOT);
  assertInside(target, canonicalAppRoot, "SHENSI_BUNDLE_PATH_UNSAFE");
  return target;
};

export const resolveBundledShensiManifestPath = ({ appRoot } = {}) => {
  const canonicalAppRoot = resolve(String(appRoot || ""));
  if (!appRoot) fail("SHENSI_BUNDLE_APP_ROOT_REQUIRED", "缺少应用根目录");
  const target = resolve(canonicalAppRoot, ...BUNDLED_SHENSI_MANIFEST_RELATIVE_PATH);
  assertInside(target, canonicalAppRoot, "SHENSI_BUNDLE_MANIFEST_PATH_UNSAFE");
  return target;
};

const collectFiles = async (bundleRoot, current = bundleRoot) => {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    fail("SHENSI_BUNDLE_MISSING", `无法读取应用内置能力包：${error?.code || error?.message || "unknown"}`);
  }
  const files = [];
  for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
    if (entry.name !== entry.name.normalize("NFC")) fail("SHENSI_BUNDLE_PATH_NOT_NFC", `能力包路径必须使用 NFC：${entry.name}`);
    if (/[<>:"|?*\u0000-\u001f]/u.test(entry.name) || /[. ]$/u.test(entry.name) || WINDOWS_RESERVED_NAME.test(entry.name)) {
      fail("SHENSI_BUNDLE_WINDOWS_PATH_INVALID", `能力包包含 Windows 不支持的名称：${entry.name}`);
    }
    const target = join(current, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) fail("SHENSI_BUNDLE_SYMLINK_FORBIDDEN", `内置能力包不允许符号链接：${portablePath(relative(bundleRoot, target))}`);
    if (metadata.isDirectory()) {
      if (FORBIDDEN_DIRECTORIES.has(entry.name)) fail("SHENSI_BUNDLE_DIRECTORY_FORBIDDEN", `能力包包含禁止发布的目录：${entry.name}`);
      files.push(...await collectFiles(bundleRoot, target));
      continue;
    }
    if (!metadata.isFile()) fail("SHENSI_BUNDLE_FILE_TYPE_FORBIDDEN", `内置能力包包含不支持的文件类型：${portablePath(relative(bundleRoot, target))}`);
    if (SKIP_FILE_NAMES.has(entry.name)) continue;
    if (SENSITIVE_FILE_NAME.test(entry.name)) fail("SHENSI_BUNDLE_SENSITIVE_FILE_FORBIDDEN", `能力包包含敏感文件名：${entry.name}`);
    if (metadata.size > MAX_BUNDLE_FILE_BYTES) fail("SHENSI_BUNDLE_FILE_TOO_LARGE", `能力包单文件超过限制：${portablePath(relative(bundleRoot, target))}`);
    const content = await readFile(target);
    const path = portablePath(relative(bundleRoot, target));
    files.push({
      path,
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      role: resourceRole(path),
    });
  }
  return files.sort((left, right) => compareCodePoints(left.path, right.path));
};

const bundleDigest = (files) => sha256(files
  .map((file) => `${file.path}\0${file.sizeBytes}\0${file.sha256}`)
  .join("\n"));

const buildShensiManifestAt = async (bundleRoot) => {
  const files = await collectFiles(bundleRoot);
  if (!files.some((file) => file.path === BUNDLED_SHENSI_ENTRY)) fail("SHENSI_BUNDLE_ENTRY_MISSING", `缺少入口 ${BUNDLED_SHENSI_ENTRY}`);
  if (files.length === 0) fail("SHENSI_BUNDLE_EMPTY", "内置能力包为空");
  if (files.length > MAX_BUNDLE_FILES) fail("SHENSI_BUNDLE_FILE_COUNT_EXCEEDED", "内置能力包文件数超过安全限制");
  const collisionKeys = new Map();
  for (const file of files) {
    const key = file.path.normalize("NFC").toLowerCase();
    const previous = collisionKeys.get(key);
    if (previous) fail("SHENSI_BUNDLE_PATH_COLLISION", `能力包路径在 Windows 上冲突：${previous} / ${file.path}`);
    collisionKeys.set(key, file.path);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) fail("SHENSI_BUNDLE_TOTAL_BYTES_EXCEEDED", "内置能力包总体积超过安全限制");
  const digest = bundleDigest(files);
  const contentSummary = Object.fromEntries(["runtime-content", "runtime-data", "reference-only"]
    .map((role) => [role, files.filter((file) => file.role === role).length]));
  const skillFiles = files.filter((file) => /(?:^|\/)SKILL\.md$/i.test(file.path));
  return {
    schemaVersion: 1,
    bundleId: BUNDLED_SHENSI_ID,
    bundleVersion: `sha256:${digest.slice(0, 16)}`,
    bundleSha256: digest,
    entry: BUNDLED_SHENSI_ENTRY,
    fileCount: files.length,
    totalBytes,
    contentSummary,
    skillSummary: {
      routableCount: skillFiles.filter((file) => file.role === "runtime-content").length,
      referenceOnlyCount: skillFiles.filter((file) => file.role === "reference-only").length,
      routablePaths: skillFiles.filter((file) => file.role === "runtime-content").map((file) => file.path),
    },
    externalDependencyCount: 0,
    runtimePolicy: {
      executeBundledScripts: false,
      externalRuleFallback: false,
      referenceOnlyDirectories: [...REFERENCE_ONLY_DIRECTORIES].sort(compareCodePoints),
    },
    files,
  };
};

export const buildBundledShensiManifest = async ({ appRoot } = {}) => buildShensiManifestAt(resolveBundledShensiRoot({ appRoot }));

export const writeBundledShensiManifest = async ({ appRoot } = {}) => {
  const manifest = await buildBundledShensiManifest({ appRoot });
  await writeFile(resolveBundledShensiManifestPath({ appRoot }), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

const parseManifest = async (manifestPath) => {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail("SHENSI_BUNDLE_MANIFEST_INVALID", `无法读取内置能力包清单：${error?.code || error?.message || "unknown"}`);
  }
};

const stableManifest = (manifest) => JSON.stringify(manifest);

export const validateShensiBundlePaths = async ({ bundleRoot, manifestPath, source = "application-bundle" } = {}) => {
  if (!bundleRoot || !manifestPath) fail("SHENSI_BUNDLE_PATHS_REQUIRED", "能力包目录与清单路径不能为空");
  const canonicalBundleRoot = resolve(bundleRoot);
  const canonicalManifestPath = resolve(manifestPath);
  const expected = await parseManifest(canonicalManifestPath);
  if (expected?.schemaVersion !== 1 || expected?.bundleId !== BUNDLED_SHENSI_ID || expected?.entry !== BUNDLED_SHENSI_ENTRY) {
    fail("SHENSI_BUNDLE_MANIFEST_CONTRACT_INVALID", "内置能力包清单协议不受支持");
  }
  const actual = await buildShensiManifestAt(canonicalBundleRoot);
  if (stableManifest(actual) !== stableManifest(expected)) {
    fail("SHENSI_BUNDLE_INTEGRITY_FAILED", "内置能力包文件缺失、被修改或清单已过期");
  }
  return Object.freeze({
    id: actual.bundleId,
    version: actual.bundleVersion,
    sha256: actual.bundleSha256,
    fileCount: actual.fileCount,
    totalBytes: actual.totalBytes,
    entry: join(canonicalBundleRoot, actual.entry),
    root: canonicalBundleRoot,
    verified: true,
    source,
  });
};

export const validateBundledShensi = async ({ appRoot } = {}) => validateShensiBundlePaths({
  bundleRoot: resolveBundledShensiRoot({ appRoot }),
  manifestPath: resolveBundledShensiManifestPath({ appRoot }),
  source: "application-bundle",
});
