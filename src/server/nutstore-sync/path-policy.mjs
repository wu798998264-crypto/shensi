import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { logicalPathKey, normalizeLogicalPath } from "./contracts.mjs";

const DEFAULT_ALLOWED_ROOTS = Object.freeze(new Set([
  "作品", "笔记", "回收站", "Skill库", "创作经验", "经验仓", "experience-store", "能力模板",
]));
const NEVER_SYNC_ROOTS = Object.freeze(new Set([
  "DesktopRuntime", "machine-sessions", "updates", "update-coordination", "diagnostics", "runtime",
  "provider-state", "generation-jobs", "generation-attempts", "recovery", "连接", "迁移", "迁移备份",
  "config", "cache", "caches", "logs", "crashpad", "browser-profile",
]));
const TEMP_OR_SECRET = /(?:^|\/)(?:\.git|node_modules|credentials?|secrets?|tokens?|cookies?|crashdumps?)(?:\/|$)|(?:\.tmp|\.lock|\.pending|\.part|\.download|\.dmp|\.log)$/i;

export const isAllowedSyncRoot = (name) => DEFAULT_ALLOWED_ROOTS.has(String(name || "").normalize("NFC"));

const AUTHOR_LEVEL_ROOTS = Object.freeze(new Set(["Skill库", "创作经验", "经验仓", "experience-store", "能力模板"]));
export const isAuthorLevelLogicalPath = (logicalPath) => AUTHOR_LEVEL_ROOTS.has(normalizeLogicalPath(logicalPath).split("/")[0]);

export const shouldSyncLogicalPath = (logicalPath) => {
  const normalized = normalizeLogicalPath(logicalPath);
  const [root] = normalized.split("/");
  if (!isAllowedSyncRoot(root) || NEVER_SYNC_ROOTS.has(root)) return false;
  if (root === "experience-store" && /(?:\.backup\.json$|\/migration-snapshots\/)/i.test(normalized)) return false;
  return !TEMP_OR_SECRET.test(normalized);
};

export const assertPathInsideRoot = ({ dataRoot, absolutePath }) => {
  const root = resolve(dataRoot);
  const target = resolve(absolutePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error("同步文件必须位于神思数据目录内");
  }
  return rel;
};

export const collectAllowedFiles = async ({ dataRoot }) => {
  const root = resolve(dataRoot);
  const results = [];
  const collisions = new Map();
  const walk = async (absoluteDirectory, logicalDirectory) => {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (const entry of entries) {
      const logicalPath = normalizeLogicalPath(`${logicalDirectory}/${entry.name}`);
      if (!shouldSyncLogicalPath(logicalPath)) continue;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      assertPathInsideRoot({ dataRoot: root, absolutePath });
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) continue;
      const key = logicalPathKey(logicalPath);
      if (collisions.has(key) && collisions.get(key) !== logicalPath) {
        const error = new Error(`同步路径存在大小写或 Unicode 规范化碰撞：${collisions.get(key)} / ${logicalPath}`);
        error.code = "SYNC_PATH_COLLISION";
        throw error;
      }
      collisions.set(key, logicalPath);
      if (info.isDirectory()) await walk(absolutePath, logicalPath);
      else if (info.isFile()) results.push({ logicalPath, absolutePath, size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  const roots = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of roots) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isAllowedSyncRoot(entry.name)) continue;
    await walk(resolve(root, entry.name), normalizeLogicalPath(entry.name));
  }
  return results;
};

export const syncPathPolicy = Object.freeze({ allowedRoots: [...DEFAULT_ALLOWED_ROOTS], authorLevelRoots: [...AUTHOR_LEVEL_ROOTS], excludedRoots: [...NEVER_SYNC_ROOTS] });
