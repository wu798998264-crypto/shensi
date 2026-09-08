import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NUTSTORE_PROTOCOL_VERSION, NUTSTORE_STATE_SCHEMA_VERSION } from "./contracts.mjs";

const cleanDeviceName = (value) => String(value || process.env.COMPUTERNAME || "Windows 电脑").trim().slice(0, 80);
const freshState = (deviceName) => ({
  schemaVersion: NUTSTORE_STATE_SCHEMA_VERSION,
  protocolVersion: NUTSTORE_PROTOCOL_VERSION,
  deviceId: randomUUID(),
  deviceName: cleanDeviceName(deviceName),
  platform: process.platform,
  activeMode: "none",
  enabled: false,
  paused: false,
  capabilityLevel: "unsupported",
  remoteRoot: "/神思同步/",
  lastSuccessfulSyncAt: "",
  lastAttemptAt: "",
  lastErrorCode: "",
  localCursor: 0,
  remoteCursor: "",
  baseline: {},
  outbox: [],
  conflicts: [],
  operations: [],
  retry: {},
  migration: null,
  logs: [],
});

const atomicJsonWrite = async (target, value) => {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${target}.previous`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await copyFile(target, previous).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await rename(temporary, target).catch(async (error) => {
    if (process.platform !== "win32") throw error;
    await rm(target, { force: true });
    await rename(temporary, target);
  });
};

const sanitizeState = (value, deviceName) => {
  const base = freshState(deviceName);
  const input = value && typeof value === "object" ? value : {};
  const merged = { ...base, ...input };
  merged.schemaVersion = NUTSTORE_STATE_SCHEMA_VERSION;
  merged.protocolVersion = NUTSTORE_PROTOCOL_VERSION;
  merged.deviceId = /^[0-9a-f-]{36}$/i.test(String(input.deviceId || "")) ? input.deviceId : base.deviceId;
  merged.deviceName = cleanDeviceName(input.deviceName || deviceName);
  merged.platform = String(input.platform || process.platform);
  for (const key of ["baseline", "retry"]) if (!merged[key] || typeof merged[key] !== "object" || Array.isArray(merged[key])) merged[key] = {};
  for (const key of ["outbox", "conflicts", "operations", "logs"]) if (!Array.isArray(merged[key])) merged[key] = [];
  for (const secretKey of ["password", "authorization", "credentials", "apiKey", "token"]) delete merged[secretKey];
  merged.logs = merged.logs.slice(-500);
  merged.operations = merged.operations.slice(-2000);
  if (!merged.enabled || merged.activeMode !== "nutstore_direct") {
    merged.outbox = merged.outbox.filter((item) => ["completed", "cancelled"].includes(item?.status)).slice(-200);
  } else {
    let fullScanKept = false;
    merged.outbox = merged.outbox.filter((item) => {
      const pendingFullScan = item?.logicalPath === "*" && item?.action === "scan" && !["completed", "cancelled"].includes(item?.status);
      if (!pendingFullScan) return true;
      if (fullScanKept) return false;
      fullScanKept = true;
      return true;
    }).slice(-2000);
  }
  return merged;
};

export const createNutstoreLocalState = ({ machineRoot, deviceName = "" } = {}) => {
  if (!machineRoot) throw new Error("machineRoot is required");
  const stateRoot = resolve(machineRoot, "machine-sessions", "nutstore-sync-v1");
  const statePath = join(stateRoot, "state.json");
  let queue = Promise.resolve();
  const readState = async () => {
    try { return sanitizeState(JSON.parse(await readFile(statePath, "utf8")), deviceName); }
    catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) {
        try { return sanitizeState(JSON.parse(await readFile(`${statePath}.previous`, "utf8")), deviceName); } catch {}
      }
      const state = freshState(deviceName);
      await atomicJsonWrite(statePath, state);
      return state;
    }
  };
  const load = async () => {
    await queue;
    return readState();
  };
  const update = (mutator) => {
    const task = queue.then(async () => {
      const state = await readState();
      const returned = await mutator(state);
      const next = sanitizeState(returned || state, deviceName);
      await atomicJsonWrite(statePath, next);
      return next;
    });
    queue = task.catch(() => {});
    return task;
  };
  return { load, update, paths: { stateRoot, statePath, previousPath: `${statePath}.previous` } };
};
