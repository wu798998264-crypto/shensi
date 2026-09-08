import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const updateBarrierError = (code, message, statusCode = 423) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const readOwnerPid = (path) => {
  try { return Number(JSON.parse(readFileSync(path, "utf8"))?.pid) || 0; } catch { return 0; }
};

const removeIfStale = (path, staleMs = 2 * 60 * 60_000) => {
  if (!existsSync(path)) return true;
  const pid = readOwnerPid(path);
  let age = 0;
  try { age = Date.now() - statSync(path).mtimeMs; } catch { return true; }
  // A live owner may legitimately hold a mutation marker for a long media or
  // long-form job. Age is only a fallback for legacy/corrupt markers without
  // an owner pid; never unlock a write that still has a live process behind it.
  if ((pid && !processIsAlive(pid)) || (!pid && age > staleMs)) {
    rmSync(path, { force: true });
    return true;
  }
  return false;
};

export const createUpdateWriteBarrier = ({ coordinationRoot = "" } = {}) => {
  let frozen = false;
  let activeMutations = 0;
  let waiters = [];
  let retainedUpdateLock = "";
  const root = coordinationRoot ? resolve(coordinationRoot, "update-coordination") : "";
  const mutationRoot = root ? join(root, "mutations") : "";
  const updateLock = root ? join(root, "update.lock") : "";

  if (root) {
    mkdirSync(mutationRoot, { recursive: true });
    removeIfStale(updateLock);
  }

  const notifyDrained = () => {
    if (activeMutations !== 0) return;
    const current = waiters;
    waiters = [];
    for (const resolveWaiter of current) resolveWaiter();
  };

  const beginMutation = () => {
    if (frozen || (updateLock && existsSync(updateLock) && !removeIfStale(updateLock))) {
      throw updateBarrierError("UPDATE_WRITES_FROZEN", "软件正在准备更新，新的写入请求已暂停");
    }
    let marker = "";
    if (mutationRoot) {
      marker = join(mutationRoot, `${process.pid}-${randomUUID()}.lock`);
      const descriptor = openSync(marker, "wx");
      try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8"); } finally { closeSync(descriptor); }
      if (existsSync(updateLock) && !removeIfStale(updateLock)) {
        rmSync(marker, { force: true });
        throw updateBarrierError("UPDATE_WRITES_FROZEN", "软件正在准备更新，新的写入请求已暂停");
      }
    }
    activeMutations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (marker) rmSync(marker, { force: true });
      activeMutations = Math.max(0, activeMutations - 1);
      notifyDrained();
    };
  };

  const waitForDrain = (timeoutMs) => new Promise((resolveDrain, rejectDrain) => {
    if (activeMutations === 0) return resolveDrain();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDrain();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      waiters = waiters.filter((waiter) => waiter !== finish);
      rejectDrain(updateBarrierError("UPDATE_WRITE_DRAIN_TIMEOUT", "等待现有写入结束超时，已取消更新", 409));
    }, timeoutMs);
    timer.unref?.();
    waiters.push(finish);
  });

  const externalMutationMarkers = () => {
    if (!mutationRoot) return [];
    const entries = readdirSync(mutationRoot, { withFileTypes: true });
    const active = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
      const path = join(mutationRoot, entry.name);
      if (!removeIfStale(path)) active.push(path);
    }
    return active;
  };

  const waitForExternalDrain = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (externalMutationMarkers().length) {
      if (Date.now() >= deadline) throw updateBarrierError("UPDATE_EXTERNAL_WRITE_DRAIN_TIMEOUT", "其他窗口或媒体任务仍在写入，已取消更新", 409);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  };

  const acquireUpdateLock = () => {
    if (!updateLock) return "";
    mkdirSync(root, { recursive: true });
    if (existsSync(updateLock) && !removeIfStale(updateLock)) throw updateBarrierError("UPDATE_ALREADY_IN_PROGRESS", "已有更新事务正在进行", 409);
    let descriptor;
    try {
      descriptor = openSync(updateLock, "wx");
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
    } catch (error) {
      throw updateBarrierError("UPDATE_ALREADY_IN_PROGRESS", "已有更新事务正在进行", 409);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return updateLock;
  };

  const releaseUpdateLock = () => {
    if (retainedUpdateLock) rmSync(retainedUpdateLock, { force: true });
    retainedUpdateLock = "";
  };

  const withExclusiveUpdate = async (task, { timeoutMs = 30_000, retainFreezeOnSuccess = false } = {}) => {
    if (frozen) throw updateBarrierError("UPDATE_ALREADY_IN_PROGRESS", "已有更新事务正在进行", 409);
    if (typeof task !== "function") throw new TypeError("更新独占任务必须是函数");
    frozen = true;
    let completed = false;
    retainedUpdateLock = acquireUpdateLock();
    try {
      const waitMs = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 30_000));
      await waitForDrain(waitMs);
      await waitForExternalDrain(waitMs);
      const result = await task();
      completed = true;
      return result;
    } finally {
      if (!completed || !retainFreezeOnSuccess) {
        frozen = false;
        releaseUpdateLock();
      }
    }
  };

  const releaseRetainedFreeze = () => {
    frozen = false;
    releaseUpdateLock();
  };

  const status = () => ({ frozen, activeMutations, externalMutations: externalMutationMarkers().length });

  return { beginMutation, releaseRetainedFreeze, status, withExclusiveUpdate };
};
