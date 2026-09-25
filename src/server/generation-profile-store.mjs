import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  generationConfigurationSettings,
  normalizeGenerationProfiles,
} from "../generation-profiles.js";
import { machineLocalDataRoot } from "./app-data.mjs";

const STORE_SCHEMA_VERSION = 1;
let writeQueue = Promise.resolve();

const defaultStorePath = () => join(machineLocalDataRoot(), "config", "generation-profiles-v1.json");

const normalizedStoredSettings = (settings = {}) => generationConfigurationSettings(
  normalizeGenerationProfiles(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
);

const emptyStore = () => ({
  schemaVersion: STORE_SCHEMA_VERSION,
  revision: 0,
  updatedAt: "",
  exists: false,
  settings: {},
});

const readStore = async ({ path = defaultStorePath() } = {}) => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: Math.max(0, Number(parsed.revision) || 0),
      updatedAt: String(parsed.updatedAt || "").slice(0, 80),
      exists: true,
      settings: normalizedStoredSettings(parsed.settings),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return emptyStore();
    throw error;
  }
};

const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const previous = `${path}.${process.pid}.${randomUUID()}.previous`;
    try {
      await rename(path, previous);
      await rename(temporary, path);
      await rm(previous, { force: true });
    } catch (replacementError) {
      await rename(previous, path).catch(() => {});
      throw replacementError;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

export const listGenerationProfileSettings = async (options = {}) => readStore(options);

export const saveGenerationProfileSettings = async ({ settings = {}, expectedRevision = null, path = defaultStorePath(), force = false } = {}) => {
  const prepared = normalizedStoredSettings(settings);
  const operation = writeQueue.catch(() => {}).then(async () => {
    const current = await readStore({ path });
    if (expectedRevision !== null && Number(expectedRevision) !== current.revision) {
      const error = new Error("本机模型配置已在其他窗口更新，请重新打开设置后再保存");
      error.code = "GENERATION_PROFILE_REVISION_CONFLICT";
      error.statusCode = 409;
      throw error;
    }
    // A normalized in-memory read can equal `prepared` while the on-disk JSON
    // still carries stale legacy labels.  `force` lets an explicit migration
    // rewrite that canonical representation without changing credentials.
    if (!force && current.exists && JSON.stringify(current.settings) === JSON.stringify(prepared)) return current;
    const next = {
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      settings: prepared,
    };
    await atomicWrite(path, next);
    return { ...next, exists: true };
  });
  writeQueue = operation;
  return operation;
};

export const generationProfileStorePath = () => defaultStorePath();
