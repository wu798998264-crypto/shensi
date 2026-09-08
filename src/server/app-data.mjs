import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

let configuredDataRoot = "";

export const machineLocalDataRoot = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) => {
  if (env.SHENSI_MACHINE_DATA_ROOT) return resolve(env.SHENSI_MACHINE_DATA_ROOT);
  if (platform === "win32") return resolve(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ShensiCreativeEngine");
  if (platform === "darwin") return resolve(home, "Library", "Application Support", "ShensiCreativeEngine");
  return resolve(env.XDG_STATE_HOME || join(home, ".local", "state"), "shensi-creative-engine");
};

export const defaultAppDataRoot = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) => {
  if (env.SHENSI_DATA_ROOT) return resolve(env.SHENSI_DATA_ROOT);
  if (platform === "win32") return resolve("E:\\ShensiUserData");
  if (platform === "darwin") return machineLocalDataRoot({ env, platform, home });
  return resolve(env.XDG_DATA_HOME || join(home, ".local", "share"), "shensi-creative-engine");
};

export const appDataRoot = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) => {
  if (env.SHENSI_DATA_ROOT) return resolve(env.SHENSI_DATA_ROOT);
  if (env === process.env && platform === process.platform && home === homedir() && configuredDataRoot) return configuredDataRoot;
  return defaultAppDataRoot({ env, platform, home });
};

const bootstrapPath = () => join(defaultAppDataRoot(), "bootstrap.json");

const USER_DATA_MARKERS = [
  "作品",
  "笔记",
  "Skill库",
  "知识图谱",
  "experience-store",
  "external-markdown",
  "generation-attempts",
  "generation-jobs",
  "task-sessions",
  "recovery",
  "迁移",
  "迁移备份",
  "updates",
];

const hasUserData = async (dirPath) => {
  try {
    const entries = await readdir(dirPath);
    return entries.some((entry) => USER_DATA_MARKERS.includes(entry));
  } catch {
    return false;
  }
};

const migrateLegacyData = async (legacyRoot, targetRoot) => {
  if (!existsSync(legacyRoot)) return false;
  const legacyHasData = await hasUserData(legacyRoot);
  if (!legacyHasData) return false;
  try {
    await mkdir(targetRoot, { recursive: true });
    let migrated = false;
    for (const marker of USER_DATA_MARKERS) {
      const src = join(legacyRoot, marker);
      if (existsSync(src)) {
        const dest = join(targetRoot, marker);
        // Merge rather than abandoning migration when E: already contains an
        // earlier Shensi root. Existing E: files win so an interrupted update
        // cannot overwrite a newer user edit.
        await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
        migrated = true;
      }
    }
    // Keep the legacy copy as a read-only compatibility fallback. The
    // bootstrap pointer moves all subsequent reads/writes to the unified E:
    // root, while failed/partial legacy data remains recoverable.
    return migrated;
  } catch {
    return false;
  }
};

export const initializeConfiguredDataRoot = async () => {
  if (process.env.SHENSI_DATA_ROOT) return appDataRoot();
  const target = defaultAppDataRoot();
  const legacyRoot = machineLocalDataRoot();
  if (resolve(target) !== resolve(legacyRoot)) {
    await migrateLegacyData(legacyRoot, target);
    const legacyBootstrap = join(legacyRoot, "bootstrap.json");
    if (existsSync(legacyBootstrap)) {
      try {
        const legacyPayload = JSON.parse(await readFile(legacyBootstrap, "utf8"));
        if (legacyPayload?.dataRoot) {
          const legacyDataRoot = resolve(legacyPayload.dataRoot);
          if (resolve(legacyDataRoot) !== resolve(target) && resolve(legacyDataRoot) !== resolve(legacyRoot)) {
            await migrateLegacyData(legacyDataRoot, target);
          }
        }
      } catch {}
    }
  }
  let loaded = false;
  try {
    const payload = JSON.parse(await readFile(bootstrapPath(), "utf8"));
    if (payload?.dataRoot) {
      configuredDataRoot = resolve(payload.dataRoot);
      loaded = true;
    }
  } catch {}
  if (!loaded) {
    // 首次运行：将默认数据根目录（Windows 上为 E:\ShensiUserData）写入 bootstrap.json，
    // 以保证后续启动解析到同一数据根目录。
    configuredDataRoot = resolve(target);
    try {
      await mkdir(defaultAppDataRoot(), { recursive: true });
      await writeFile(bootstrapPath(), JSON.stringify({ schemaVersion: 1, dataRoot: configuredDataRoot }, null, 2), "utf8");
    } catch {}
  }
  return appDataRoot();
};

export const setConfiguredDataRoot = async (target) => {
  if (process.env.SHENSI_DATA_ROOT) throw new Error("当前数据目录由 SHENSI_DATA_ROOT 固定，不能在界面中切换");
  configuredDataRoot = resolve(target);
  await mkdir(defaultAppDataRoot(), { recursive: true });
  await writeFile(bootstrapPath(), JSON.stringify({ schemaVersion: 1, dataRoot: configuredDataRoot }, null, 2), "utf8");
  return configuredDataRoot;
};

export const persistentWorksRoot = (options = {}) => join(appDataRoot(options), "作品");
export const persistentNotesRoot = (options = {}) => join(appDataRoot(options), "笔记");
export const persistentSkillsRoot = (options = {}) => join(appDataRoot(options), "Skill库");
export const updateCacheRoot = (options = {}) => join(appDataRoot(options), "updates");
