import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const starts = new Map();
const read = async (file) => JSON.parse(await readFile(file, "utf8").catch(() => "null"));
const ownerAlive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const removeOwnRecord = async (file, id) => { if ((await read(file))?.id === id) await unlink(file).catch(() => {}); };
const portOccupied = (endpoint) => new Promise((resolve) => {
  const url = new URL(endpoint);
  const socket = connect({ host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
  const finish = (value) => { socket.destroy(); resolve(value); };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.setTimeout(1_000, () => finish(true));
});
const command = async (record, action) => {
  const url = new URL(record.controlUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("本地 H3 管理地址无效");
  const response = await fetch(`${url.origin}/${action}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(action === "stop" ? 18_000 : 2_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.sessionId !== record.id || payload.endpoint !== record.endpoint) throw new Error(payload.message || "本地 H3 管理会话不匹配");
  return payload;
};

export const inspectH3ManagedSession = async (file, endpoint) => {
  const record = await read(file);
  if (!record) return { started: false, pid: 0 };
  if (record.endpoint !== endpoint) return { started: false, conflict: true, reason: "另一地址的本地 H3 会话尚未停止，请返回该配置停止后再启动" };
  if (!record.controlUrl) return { started: false, starting: ownerAlive(record.ownerPid), reason: "本地 H3 控制服务正在启动" };
  try { return await command(record, "status"); }
  catch { return { started: false, uncertain: ownerAlive(record.ownerPid), reason: "本地 H3 控制连接不可达，尚不能确认运行状态" }; }
};

export const launchH3ManagedSession = (file, { endpoint, command: launchCommand, cwd }) => {
  if (starts.has(file)) return starts.get(file);
  const operation = (async () => {
    await mkdir(dirname(file), { recursive: true });
    const previous = await read(file);
    if (previous) {
      const existing = await inspectH3ManagedSession(file, endpoint);
      if (existing.started) return existing;
      if (existing.conflict || existing.starting || existing.uncertain) throw new Error(existing.reason);
      // A dead controller is never adopted by PID, and no unrelated process is killed.
      if (ownerAlive(previous.ownerPid)) {
        await command(previous, "stop");
      }
      await removeOwnRecord(file, previous.id);
    }
    if (await portOccupied(endpoint)) throw new Error("本地 H3 端口已被其他进程使用；不会接管或停止用户自行启动的服务");
    const record = { id: randomUUID(), token: randomUUID(), endpoint, ownerPid: process.pid };
    try { await writeFile(file, JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") throw new Error("本地 H3 正在由另一请求启动，请稍后查看状态"); throw error; }
    let host;
    try {
      host = fork(fileURLToPath(new URL("./local-h3-process-host.mjs", import.meta.url)), [], {
        windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, execArgv: [],
      });
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("本地 H3 控制服务启动超时")), 10_000);
        const finish = (error, value) => { clearTimeout(timeout); error ? reject(error) : resolve(value); };
        host.once("error", (error) => finish(error));
        host.once("exit", () => finish(new Error("本地 H3 控制服务提前退出")));
        host.once("message", (value) => finish(value.error ? new Error(value.error) : null, value));
        host.send({ ...record, command: launchCommand, cwd });
      });
      const next = `${file}.${record.id}.next`;
      await writeFile(next, JSON.stringify({ ...record, controlUrl: result.controlUrl }), { mode: 0o600 });
      await rename(next, file);
      host.once("exit", () => { void removeOwnRecord(file, record.id); });
      // Keep the IPC channel for parent-exit cleanup, but not the main event loop.
      host.unref();
      host.channel?.unref();
      return result;
    } catch (error) {
      if (host?.connected) host.disconnect();
      await removeOwnRecord(file, record.id);
      throw error;
    }
  })().finally(() => starts.delete(file));
  starts.set(file, operation);
  return operation;
};

export const stopH3ManagedSession = async (file, endpoint) => {
  // A stop during launch waits only for the bounded supervisor handshake.
  await starts.get(file)?.catch(() => {});
  const record = await read(file);
  if (!record) return { started: false, stopped: true };
  if (record.endpoint !== endpoint) throw new Error("本地 H3 管理会话地址不匹配，已拒绝停止其他配置的进程");
  if (!record.controlUrl) throw new Error("本地 H3 控制服务正在启动，请稍后重试停止");
  const result = await command(record, "stop");
  if (result.started || !result.stopped) throw new Error("本地 H3 尚未确认停止");
  await removeOwnRecord(file, record.id);
  return result;
};
