import { mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appDataRoot } from "./app-data.mjs";

// The Windows mutex itself cannot tell the server which profile owns it. This
// small, credential-free lease is written only while the profile runner holds
// the mutex, so a busy result can be mapped back to a real profile/job without
// exposing tokens or registry contents.
export const dreaminaBrokerLeasePath = () => join(appDataRoot(), "config", "dreamina-broker-lease-v1.json");

const processIsAlive = (pid) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const validLease = (value) => {
  if (!value || typeof value !== "object") return null;
  const profileId = String(value.profileId || "").trim();
  const token = String(value.token || "").trim();
  const pid = Number(value.pid);
  if (!profileId || !token || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    profileId,
    token,
    pid,
    jobId: String(value.jobId || "").trim(),
    channel: String(value.channel || "").trim(),
    command: String(value.command || "").trim(),
    acquiredAt: String(value.acquiredAt || "").trim(),
  };
};

export const readDreaminaBrokerLease = async () => {
  const path = dreaminaBrokerLeasePath();
  let lease;
  try {
    lease = validLease(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      await rm(path, { force: true }).catch(() => {});
      return null;
    }
    throw error;
  }
  if (lease && processIsAlive(lease.pid)) return lease;
  await rm(path, { force: true }).catch(() => {});
  return null;
};

export const writeDreaminaBrokerLease = async (lease = {}) => {
  const path = dreaminaBrokerLeasePath();
  await mkdir(join(appDataRoot(), "config"), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lease)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return path;
};

export const clearDreaminaBrokerLease = async (token = "") => {
  const path = dreaminaBrokerLeasePath();
  if (!token) {
    await rm(path, { force: true }).catch(() => {});
    return true;
  }
  try {
    const current = validLease(JSON.parse(await readFile(path, "utf8")));
    if (current?.token === token) await rm(path, { force: true });
    return current?.token === token;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};
