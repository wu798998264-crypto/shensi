import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { machineLocalDataRoot } from "./app-data.mjs";

const SCHEMA_VERSION = 1;
let registryMutationQueue = Promise.resolve();
const clean = (value = "", maximum = 2_048) => String(value ?? "").replace(/\0/gu, "").trim().slice(0, maximum);

export const agentRunnerRegistryPath = ({ machineRoot = machineLocalDataRoot() } = {}) => (
  join(resolve(machineRoot), "config", "agent-runners-v1.json")
);

const normalizeEntry = (runnerId, entry = {}) => {
  const id = clean(runnerId, 80);
  if (!id) return null;
  const prefixArgs = Array.isArray(entry.prefixArgs)
    ? entry.prefixArgs.map((item) => clean(item, 2_048)).filter(Boolean).slice(0, 16)
    : [];
  const executable = clean(entry.executable, 2_048);
  if (!executable) return null;
  return {
    runnerId: id,
    executable,
    prefixArgs,
    version: clean(entry.version, 240),
    installSource: clean(entry.installSource, 240),
    resolvedAt: Number(entry.resolvedAt) || Date.now(),
  };
};

export const readAgentRunnerRegistry = async ({ machineRoot = machineLocalDataRoot() } = {}) => {
  try {
    const payload = JSON.parse(await readFile(agentRunnerRegistryPath({ machineRoot }), "utf8"));
    const entries = payload?.runners && typeof payload.runners === "object" ? payload.runners : {};
    return Object.fromEntries(Object.entries(entries)
      .map(([runnerId, entry]) => [runnerId, normalizeEntry(runnerId, entry)])
      .filter(([, entry]) => entry));
  } catch {
    return {};
  }
};

export const writeAgentRunnerRegistry = async ({ machineRoot = machineLocalDataRoot(), runners = {} } = {}) => {
  const path = agentRunnerRegistryPath({ machineRoot });
  await mkdir(dirname(path), { recursive: true });
  const normalized = Object.fromEntries(Object.entries(runners)
    .map(([runnerId, entry]) => [runnerId, normalizeEntry(runnerId, entry)])
    .filter(([, entry]) => entry));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, runners: normalized }, null, 2), "utf8");
  await rename(temporary, path);
  return normalized;
};

export const rememberAgentRunnerLaunch = async ({ machineRoot = machineLocalDataRoot(), runnerId, launch = {}, version = "", installSource = "" } = {}) => {
  const task = registryMutationQueue.then(async () => {
    const current = await readAgentRunnerRegistry({ machineRoot });
    const entry = normalizeEntry(runnerId, {
      ...launch,
      version: version || current?.[clean(runnerId)]?.version,
      installSource: installSource || launch?.installSource || current?.[clean(runnerId)]?.installSource,
      resolvedAt: Date.now(),
    });
    if (!entry) return current;
    current[entry.runnerId] = entry;
    return writeAgentRunnerRegistry({ machineRoot, runners: current });
  });
  registryMutationQueue = task.catch(() => {});
  return task;
};

export const forgetAgentRunnerLaunch = async ({ machineRoot = machineLocalDataRoot(), runnerId } = {}) => {
  const task = registryMutationQueue.then(async () => {
    const current = await readAgentRunnerRegistry({ machineRoot });
    const id = clean(runnerId, 80);
    if (!id || !Object.hasOwn(current, id)) return current;
    delete current[id];
    return writeAgentRunnerRegistry({ machineRoot, runners: current });
  });
  registryMutationQueue = task.catch(() => {});
  return task;
};
